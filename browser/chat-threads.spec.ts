import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

/** Asks about a target from its ask command, through the quick-question menu's free question. */
async function askAbout(page: Page, command: ReturnType<Page['locator']>, question: string) {
  await command.click()
  const other = page.getByText('ask something else…', { exact: true }).first()
  if (await other.isVisible()) {
    await other.click()
  }
  await page.locator('#msg').fill(question)
  await page.keyboard.press('Enter')
  await expect(page.locator('#chat-log')).toContainText('covered at')
}

test('each ask opens the thread of its place, and the Threads tab lists them', async ({
  page,
  chatServer,
}, testInfo) => {
  // Narrower screens float the pane over the canvas; the wide one docks it beside the canvas.
  test.skip(testInfo.project.name !== 'desktop')
  const { url } = await chatServer()
  await page.goto(url)
  const pointAsk = page
    .locator('section.layer li.finding[data-fingerprint="fp-1"]')
    .locator('[data-act="ask"]')
    .first()
  const layerAsk = page.getByRole('button', { name: 'ask about this layer' }).first()

  await askAbout(page, pointAsk, 'Is the sum intended?')
  await expect(page.locator('#thread-title')).toHaveText('Sum instead of product')

  await askAbout(page, layerAsk, 'Anything risky here?')
  await expect(page.locator('#thread-title')).toHaveText('layer · Run path')
  await expect(page.locator('#chat-log')).not.toContainText('Is the sum intended?')

  const threadsTab = page.locator('#side-tab-threads')
  await threadsTab.click()
  await expect(page.locator('#thread-index [data-thread-open]')).toHaveCount(2)
  await page.locator('#thread-index').getByText('Sum instead of product').click()
  await expect(page.locator('#thread-title')).toHaveText('Sum instead of product')
  await expect(page.locator('#chat-log')).toContainText('Is the sum intended?')
  // The point's ask counts its thread's questions.
  expect(await pointAsk.evaluate(el => getComputedStyle(el, '::after').content)).toBe('"1"')
})

test('with a thread per place off, every ask goes to the open thread until the reader turns it on', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  const { url } = await chatServer({
    setup: async t => {
      await t.ctx.settings.write({ chatThreadPerPlace: false })
    },
  })
  await page.goto(url)
  const pointAsk = page
    .locator('section.layer li.finding[data-fingerprint="fp-1"]')
    .locator('[data-act="ask"]')
    .first()

  await askAbout(page, pointAsk, 'Is the sum intended?')
  await expect(page.locator('#chat-ctx')).toHaveText('point · Sum instead of product')
  await askAbout(page, page.getByRole('button', { name: 'ask about this layer' }).first(), 'Anything risky?')
  // One thread holds both questions, each naming what it was about.
  await expect(page.locator('#chat-log .turn-ctx')).toHaveText([
    'about point · Sum instead of product',
    'about layer · Run path',
  ])
  await page.locator('#side-tab-threads').click()
  await expect(page.locator('#thread-index [data-thread-open]')).toHaveCount(1)
  expect(await pointAsk.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none')
  await page.locator('#side-tab-chat').click()

  await page.locator('#settings').click()
  await page.locator('dialog').getByRole('tab', { name: 'AI Chat' }).click()
  await page.locator('#set-thread-per-place').check()
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#chat-ctx-line')).toBeHidden()

  await pointAsk.click()
  await page.getByText('ask something else…', { exact: true }).first().click()
  await expect(page.locator('#thread-title')).toHaveText('Sum instead of product')
  await expect(page.locator('#chat-log')).toContainText('A new thread about point · Sum instead of product')
})

test('the wheel scrolls a long Threads list, and the page under a short one', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  let threads = 25
  const { url, ctx } = await chatServer({
    setup: async t => {
      for (let made = 0; made < threads; made += 1) {
        await t.ctx.chat.createThread(42)
      }
    },
  })
  await page.goto(url)
  await page.locator('#side-tab-threads').click()
  const index = page.locator('#thread-index')
  await expect(index.locator('[data-thread-open]')).toHaveCount(threads)
  await index.hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(() => index.evaluate(el => el.scrollTop)).toBeGreaterThan(0)

  // One thread leaves the list nothing to scroll, so the wheel moves the page.
  threads = 1
  await ctx.state.update(42, current => ({
    ...current,
    chat: { ...current.chat, threads: current.chat.threads.slice(0, threads) },
  }))
  await page.reload()
  await page.locator('#side-tab-threads').click()
  await expect(index.locator('[data-thread-open]')).toHaveCount(threads)
  const box = await index.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 40)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
})

test('the other threads wait, and look it, while an answer comes in', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  // The question is held where the turn sets up, so the answer is still coming in for as long as
  // the test looks.
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const { url } = await chatServer({
    runner: { ensureGate: held },
    setup: async t => {
      await t.ctx.chat.createThread(42)
    },
  })
  await page.goto(url)
  const pointAsk = page
    .locator('section.layer li.finding[data-fingerprint="fp-1"]')
    .locator('[data-act="ask"]')
    .first()
  await pointAsk.click()
  await page.getByText('ask something else…', { exact: true }).first().click()
  await page.locator('#msg').fill('Is the sum intended?')
  await page.keyboard.press('Enter')
  await page.locator('#side-tab-threads').click()
  const waiting = page.locator('#thread-index [data-thread-open]').filter({ hasText: 'New thread' })
  await expect(waiting).toBeDisabled()
  await expect(waiting).toHaveCSS('cursor', 'not-allowed')
  release()
  await expect(waiting).toBeEnabled()
  await expect(waiting).toHaveCSS('cursor', 'pointer')
})
