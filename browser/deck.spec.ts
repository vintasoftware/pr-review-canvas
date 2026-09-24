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

/** A sketch that draws, so a side shows it instead of its words. */
const DRAWS = "p.draw = () => { ui.box(20, 100, 120, 80, 'rows'); ui.dot(200 + 60 * ui.pulse(), 140) }"

const CARDS = [
  { ...card('one', 'First', 'a'), sketches: true },
  card('two', 'Second', 'a'),
  card('three', 'Third', 'b'),
].map(({ sketches, ...c }: DecisionCard & { sketches?: boolean }) =>
  sketches === true ? { ...c, a: { ...c.a, sketch: DRAWS }, b: { ...c.b, sketch: DRAWS } } : c
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

test('draws each side in a sandboxed frame, and turns the card over with i', async ({ page, deckUrl }) => {
  await page.goto(deckUrl)
  for (const side of ['a', 'b']) {
    await expect(page.locator(`.deck-visual[data-visual="${side}"]`)).toHaveAttribute('data-live', '')
    await expect(page.frameLocator(`iframe[data-sketch="${side}"]`).locator('canvas')).toBeVisible()
  }
  // The words step aside for the sketch, but stay for screen readers.
  await expect(page.locator('[data-visual="a"] .deck-visual-text')).toHaveText('Old exports import cleanly.')
  expect(
    await page.locator('[data-visual="a"] .deck-visual-text').evaluate(el => el.getBoundingClientRect().width)
  ).toBe(1)
  await expect(page.locator('.deck-back')).toBeHidden()

  await page.keyboard.press('i')
  await expect(page.locator('.deck-back')).toBeVisible()
  await expect(page.locator('.deck-back .deck-context')).toHaveText('The importer skips rows with no cells.')
  await expect(page.locator('[data-act="details"]')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('.deck-back')).toBeHidden()
  await expect(page.locator('[data-act="details"]')).toHaveAttribute('aria-pressed', 'false')

  // Editing turns the card over, since the justifications live on the back.
  await page.keyboard.press('e')
  await expect(page.locator('[data-why="a"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('.deck-back')).toBeHidden()

  await page.keyboard.press('a')
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
  // A card without sketches shows its consequences as words, and frames nothing.
  await expect(page.locator('iframe')).toHaveCount(0)
  // (Publish shuffled this card's sides, so the words are checked as a pair.)
  await expect(page.locator('.deck-visual-text')).toHaveText([
    /Nothing is dropped quietly\.|Old exports import cleanly\./,
    /Nothing is dropped quietly\.|Old exports import cleanly\./,
  ])
  await expect(page.locator('.deck-visual[data-live]')).toHaveCount(0)
})

test('a sketch reaches neither the page nor the network, and a failed one falls back to words', async ({
  page,
  deckUrl,
}) => {
  // Skip the validator, as a hand-edited deck.json would: the sandbox has to hold on its own.
  const hostile = {
    a: "p.draw = () => { parent.document.title = 'owned' }",
    b:
      "p.setup = () => { try { localStorage.setItem('x', '1') } catch (e) { ui.storage = String(e.name) } }\n" +
      "p.draw = () => { if (!ui.sent) { ui.sent = true; fetch(new URL('/api/health?leak=1', location.href)).catch(() => {}) } ui.box(10, 10, 50, 50) }",
  }
  await page.route('**/api/deck/uncommitted', async route => {
    const res = await route.fetch()
    const body = await res.json()
    const first = body.deck.cards[0]
    first.a.sketch = hostile.a
    first.b.sketch = hostile.b
    await route.fulfill({ response: res, json: body })
  })
  const leaks: string[] = []
  page.on('request', req => {
    if (req.url().includes('leak=1')) leaks.push(req.url())
  })
  const warnings: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'warning' && msg.text().startsWith('sketch ')) warnings.push(msg.text())
  })
  await page.goto(deckUrl)
  const title = await page.title()

  // Side A threw on touching the deck page: its frame is gone and its words are back.
  await expect(page.locator('.deck-visual[data-visual="a"]')).toHaveAttribute('data-failed', '')
  await expect(page.locator('iframe[data-sketch="a"]')).toHaveCount(0)
  await expect(page.locator('[data-visual="a"] .deck-visual-text')).toBeVisible()
  expect(await page.title()).toBe(title)
  expect(warnings.join('\n')).toMatch(/^sketch one\.a failed: /)

  // Side B drew, but its request never left the frame.
  await expect(page.locator('.deck-visual[data-visual="b"]')).toHaveAttribute('data-live', '')
  await page.waitForTimeout(300)
  expect(leaks).toEqual([])
  // And the card still works around a broken side.
  await page.keyboard.press('b')
  await expect(page.locator('.deck-card h2')).toHaveText('Second')
})
