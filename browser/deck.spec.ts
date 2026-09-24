import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { test as base, expect } from '@playwright/test'
import type { DecisionCard } from '../src/contract/deck.js'
import { prepareDeck } from '../src/deck/prepare-deck.js'
import { publishDeck } from '../src/deck/publish-deck.js'
import { DEFAULT_PROJECT_CONFIG } from '../src/project-config.js'
import { createApp } from '../src/server/app.js'
import { resolveVendorRoots } from '../src/server/context.js'
import { writeTextAtomic } from '../src/store/atomic-json.js'
import { makeTestContext } from '../src/testing/fakes.js'
import { gitForLocal } from '../src/testing/synthetic.js'

function card(key: string, title: string, current: 'a' | 'b' | null): DecisionCard {
  return {
    key,
    bucket: 'trade-off',
    topic: 'Rare case vs simplify',
    title,
    context: 'The importer skips rows with no cells.',
    path: 'src/app.ts',
    line: 2,
    current,
    a: {
      label: `${title}: A`,
      consequence: 'Old exports import cleanly.',
      snippet: {
        code: "import { b } from './b'\nreturn { ...rest, version: 2, reviewed: {}, reviewedCanvasSha: undefined, carriedFrom: null }",
      },
      why: 'Only old exports pad.',
      record: 'pr-comment',
    },
    b: {
      label: `${title}: B`,
      consequence: 'Nothing is dropped quietly.',
      why: 'Never drop data.',
      record: 'none',
    },
  }
}

/** A scene for card one's sides: the kit lays it out, and the frame shows it. */
const SCENE =
  '<div class="scene"><div class="row"><div class="box bad"><i data-icon="circle-x" class="lg"></i><span class="big">3</span></div><span class="arrow"></span><div class="banner bad">rows lost</div></div></div>'

/** A scene with far more rows than any frame holds, to be shrunk until it fits. */
const TALL = `<div class="scene">${Array.from({ length: 8 }, (_, i) => `<div class="box">row ${i + 1}</div>`).join('')}<div class="banner bad">last row</div></div>`

const CARDS = [
  { ...card('one', 'First', 'a'), scenes: true },
  card('two', 'Second', 'a'),
  card('three', 'Third', 'b'),
].map(({ scenes, ...c }: DecisionCard & { scenes?: boolean }) =>
  scenes === true ? { ...c, a: { ...c.a, scene: SCENE }, b: { ...c.b, scene: TALL } } : c
)

const test = base.extend<{ deckUrl: string }>({
  deckUrl: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const config = { ...DEFAULT_PROJECT_CONFIG, selfReview: { maxCards: 10, linesPerCard: 1 } }
    const t = await makeTestContext({
      git: gitForLocal(),
      projectConfig: { config, warnings: [], source: null },
      vendorRoots: resolveVendorRoots(),
    })
    const prepared = await prepareDeck(t.ctx, { review: 'uncommitted', force: false }, () => undefined)
    await writeTextAtomic(prepared.modelPath, JSON.stringify({ cards: CARDS }))
    await publishDeck(t.ctx, 'uncommitted', { agent: 'claude', allowStale: false })
    const server = serve({ fetch: createApp(t.ctx).fetch, port: 0, hostname: '127.0.0.1' })
    try {
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('test server did not bind a port')
      }
      await use(`http://127.0.0.1:${address.port}/deck/uncommitted`)
      expect(errors).toEqual([])
    } finally {
      if ('closeAllConnections' in server) {
        server.closeAllConnections()
      }
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
      await t.cleanup()
    }
  },
})

test.use({ contextOptions: { reducedMotion: 'reduce' } })

test('deals one card at a time, and a desktop page never scrolls', async ({ page, deckUrl }, info) => {
  await page.goto(deckUrl)
  const top = page.locator('.deck-card')
  await expect(top).toHaveCount(1)
  await expect(top.locator('h2')).toHaveText('First')
  await expect(top.locator('.deck-side-a .deck-now')).toHaveText('in code now')
  await expect(page.locator('.deck-pip')).toHaveCount(3)
  if (info.project.name !== 'mobile') {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight
    )
    expect(overflow).toBe(0)
  }
  // A long snippet line wraps: every character stays on the card, with no scroll box of its own.
  const clipped = await page
    .locator('.deck-side-a .deck-snippet')
    .evaluate(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
  expect(clipped).toBe(false)
})

test('picks with a and b, takes a note with n, skips with s, undoes with u', async ({ page, deckUrl }) => {
  await page.goto(deckUrl)
  await expect(page.locator('.deck-card h2')).toHaveText('First')
  await page.keyboard.press('b')
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
  await page.keyboard.press('u')
  await expect(page.locator('.deck-card h2')).toHaveText('First')
  await page.keyboard.press('a')
  await expect(page.locator('.deck-card h2')).toHaveText('Second')

  await page.keyboard.press('n')
  const note = page.locator('.deck-note textarea')
  await expect(note).toBeFocused()
  // Deck keys typed into the note are text, not picks.
  await note.fill('hold on, log and continue')
  await note.press('Enter')
  await expect(page.locator('.deck-card h2')).toHaveText('Third')

  await page.keyboard.press('s')
  await expect(page.locator('.deck-finish h2')).toHaveText('Deck cleared')
  await expect(page.locator('.deck-tally-fixes .deck-tally-n')).toHaveText('1')
  await expect(page.locator('.deck-tally-comments .deck-tally-n')).toHaveText('1')
  await expect(page.locator('.deck-tally-skipped .deck-tally-n')).toHaveText('1')
  await expect(page.locator('.deck-fixes-body')).toContainText('neither side. hold on, log and continue')
  // The finish screen grows with the page; nothing on it scrolls inside a box of its own.
  for (const selector of ['.deck-finish', '.deck-fixes-body', '.deck-table']) {
    const inner = await page.locator(selector).evaluate(el => el.scrollHeight - el.clientHeight)
    expect(inner, selector).toBe(0)
  }
  await expect(page.locator('.deck-run code')).toHaveText('/pr-self-review-fix uncommitted')

  // A pick can be changed from the finish screen.
  await page.locator('.deck-picks summary').click()
  await page.locator('[data-reopen="three"]').click()
  await expect(page.locator('.deck-card h2')).toHaveText('Third')
})

test('edits a justification before picking, and shows the code with o', async ({ page, deckUrl }) => {
  await page.goto(deckUrl)
  await expect(page.locator('.deck-card h2')).toHaveText('First')
  await page.keyboard.press('o')
  const drawer = page.locator('.deck-drawer')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.deck-diff-here')).toContainText("import { b } from './b'")
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  await page.keyboard.press('e')
  const why = page.locator('[data-why="b"]')
  await why.fill('Because the importer should be loud.')
  await page.locator('[data-record-select="b"]').selectOption('code')
  await why.press('Enter')
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
  const saved = await page.evaluate(async () => (await fetch('/api/deck/uncommitted')).json())
  expect(saved.picks.one).toMatchObject({
    choice: 'b',
    why: 'Because the importer should be loud.',
    record: 'code',
  })
})

test('drags a card right to pick side B', async ({ page, deckUrl }) => {
  await page.goto(deckUrl)
  await expect(page.locator('.deck-card h2')).toHaveText('First')
  const box = await page.locator('.deck-card').boundingBox()
  if (box === null) throw new Error('no card')
  await page.mouse.move(box.x + box.width / 2, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 260, box.y + 40, { steps: 10 })
  await page.mouse.up()
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
  const saved = await page.evaluate(async () => (await fetch('/api/deck/uncommitted')).json())
  expect(saved.picks.one.choice).toBe('b')
})

test('fits a phone: no sideways scroll, and every action has a button', async ({ page, deckUrl }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(deckUrl)
  await expect(page.locator('.deck-card h2')).toHaveText('First')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBe(0)
  // Stacked, a scene's frame takes its scene's height instead of a fixed box.
  await expect(page.locator('iframe[data-scene="a"]')).toHaveAttribute('style', /--scene-height: \d+px/)
  // The back, with its long lines of code, stays within the screen: the code scrolls in its box.
  await page.locator('.deck-card-more [data-act="details"]').click()
  await expect(page.locator('.deck-back')).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ).toBe(0)
  await page.locator('.deck-card-more [data-act="details"]').click()
  await expect(page.locator('.deck-back')).toBeHidden()
  await page.locator('[data-act="drawer"]').click()
  await expect(page.locator('.deck-drawer')).toBeVisible()
  await page.locator('.deck-drawer-close').click()
  await expect(page.locator('.deck-drawer')).toBeHidden()
  await page.locator('[data-pick="b"]').click()
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
  await page.locator('.deck-links [data-act="undo"]').click()
  await expect(page.locator('.deck-card h2')).toHaveText('First')
  await page.locator('.deck-card-more [data-act="edit"]').click()
  await expect(page.locator('[data-why="a"]')).toBeFocused()
})

test('shows each side’s scene in a locked frame, and turns the card over with i', async ({
  page,
  deckUrl,
}) => {
  await page.goto(deckUrl)
  const scene = page.frameLocator('iframe[data-scene="a"]')
  await expect(scene.locator('.banner')).toHaveText('rows lost')
  // The icon was inlined by the server: the frame loads nothing for it.
  await expect(scene.locator('svg.icon.lg')).toHaveCount(1)
  await expect(page.frameLocator('iframe[data-scene="b"]').locator('.banner')).toHaveText('last row')
  await expect(page.locator('.deck-front .deck-side-a .deck-gist')).toHaveText('Old exports import cleanly.')
  await expect(page.locator('.deck-back')).toBeHidden()
  await expect(page.locator('.deck-corner')).toContainText('reasons and code on the back')

  await page.keyboard.press('i')
  await expect(page.locator('.deck-back')).toBeVisible()
  await expect(page.locator('.deck-back .deck-context')).toHaveText('The importer skips rows with no cells.')
  await expect(page.locator('.deck-back .deck-diff-here')).toBeVisible()
  await expect(page.locator('.deck-corner')).toContainText('back to the front')
  await expect(page.locator('[data-act="details"][aria-pressed="true"]')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(page.locator('.deck-back')).toBeHidden()

  // The corner turns it too, and editing turns it, since the justifications live on the back.
  await page.locator('.deck-corner').click()
  await expect(page.locator('.deck-back')).toBeVisible()
  await page.locator('.deck-corner').click()
  await expect(page.locator('.deck-back')).toBeHidden()
  await page.keyboard.press('e')
  await expect(page.locator('[data-why="a"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('.deck-back')).toBeHidden()

  await page.keyboard.press('a')
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
  // A card without scenes shows its consequences alone, and frames nothing.
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('.deck-side[data-plain]')).toHaveCount(2)
})

test('fits a scene that would overflow its frame, so all of it shows', async ({ page, deckUrl }) => {
  await page.goto(deckUrl)
  const tall = page.locator('iframe[data-scene="b"]')
  // A desktop card shrinks the scene into its fixed room; stacked sides give it its full height.
  const stacked = await page.evaluate(() => matchMedia('(max-width: 900px), (max-height: 700px)').matches)
  if (stacked) {
    await expect(tall).toHaveAttribute('data-zoom', '1')
    await expect(tall).toHaveAttribute('style', /--scene-height: \d+px/)
  } else {
    await expect(tall).toHaveAttribute('data-zoom', /^0\.\d+$/)
    expect(Number(await tall.getAttribute('data-zoom'))).toBeGreaterThanOrEqual(0.55)
  }
  const last = page.frameLocator('iframe[data-scene="b"]').locator('.banner')
  const frameBox = await tall.boundingBox()
  const lastBox = await last.boundingBox()
  expect(frameBox).not.toBeNull()
  expect(lastBox).not.toBeNull()
  // The last row sits inside the frame, not cut off below it.
  expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual(
    (frameBox?.y ?? 0) + (frameBox?.height ?? 0) + 1
  )
  // A scene that fits is left at its size.
  await expect(page.locator('iframe[data-scene="a"]')).toHaveAttribute('data-zoom', '1')
})

test('a scene runs no script, even one that slips past validation', async ({ page, deckUrl }) => {
  // Rewrite the frame's body in flight but keep the server's headers, its policy included, as a
  // hand-edited deck.json would.
  await page.route('**/deck-scene/**', async route => {
    const res = await route.fetch()
    const hostile =
      "<!doctype html><p id=ok>shown</p><script>parent.document.title = 'owned'; fetch('/api/health?leak=1'); document.getElementById('ok').textContent = 'ran'</script>"
    await route.fulfill({ response: res, body: hostile })
  })
  const leaks: string[] = []
  page.on('request', req => {
    if (req.url().includes('leak=1')) leaks.push(req.url())
  })
  await page.goto(deckUrl)
  const title = await page.title()
  const scene = page.frameLocator('iframe[data-scene="a"]')
  await expect(scene.locator('#ok')).toHaveText('shown')
  await page.waitForTimeout(300)
  expect(await page.title()).toBe(title)
  expect(leaks).toEqual([])
  await page.keyboard.press('b')
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
})
