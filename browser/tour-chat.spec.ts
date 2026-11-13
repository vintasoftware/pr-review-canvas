import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { TourArtifactSchema } from '../src/contract/tour.js'
import { PACKAGE_ROOT } from '../src/server/context.js'
import { BASE_SHA, HEAD_SHA, syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

test('asks AI Chat from any stop of the tour, in a thread per stop that follows the reader', async ({
  page,
  chatServer,
}, testInfo) => {
  const { url, ctx } = await chatServer({
    runner: {
      script: options => [
        {
          type: 'chunk',
          text: options.prompt.includes('## Context: landmark')
            ? 'The landmark is about `src/commands.ts:66`.'
            : 'The tour covers the JSON output.',
        },
        { type: 'done', stopReason: 'end_turn' },
      ],
    },
    setup: async t => {
      const raw = JSON.parse(
        await readFile(path.join(PACKAGE_ROOT, '__fixtures__', 'tour-67', 'tour.json'), 'utf8')
      )
      const pr = syntheticArtifact().pr
      await t.ctx.tours.write(
        HEAD_SHA,
        TourArtifactSchema.parse({
          ...raw,
          pr: { ...pr, title: raw.pr.title, body: raw.pr.body },
          repo: pr.repo,
          headSha: HEAD_SHA,
          mergeBaseSha: BASE_SHA,
          record: { touredBy: [] },
        })
      )
    },
  })
  await page.goto(new URL('../tour/42', url).href)
  const pane = page.locator('#tour-ask')
  await expect(pane).toBeHidden()
  const ask = page.locator('.tour-nav .tour-ask-launcher')
  await ask.click()
  await expect(pane).toBeVisible()
  await expect(pane.locator('#tour-ask-title')).toHaveText('the whole tour')
  await pane.locator('#tour-ask-box').fill('What is this tour about?')
  await pane.locator('#tour-ask-box').press('Enter')
  await expect(pane.locator('.turn.a')).toContainText('covers the JSON output')
  await expect(ask).toHaveAttribute('data-thread', '')

  // The open pane follows the reader to the next stop, which has no thread yet.
  await page.locator('.tour-nav [data-nav="next"]').click()
  await expect(pane.locator('#tour-ask-title')).toContainText('landmark ·')
  await expect(pane.locator('.turn')).toHaveCount(0)
  await expect(ask).not.toHaveAttribute('data-thread')
  await pane.locator('#tour-ask-box').fill('Where does this happen?')
  await pane.locator('#tour-ask-box').press('Enter')
  await expect(pane.locator('.turn.a')).toContainText('src/commands.ts:66')
  await page.screenshot({ path: testInfo.outputPath('tour-chat-landmark.png') })

  // Each stop kept its own thread, seeded on its own first question, apart from the canvas's.
  const { threads } = await ctx.chat.tourThreads(42)
  expect(threads.map(t => [t.place.kind, t.turns])).toEqual([
    ['tour', 1],
    ['tour-landmark', 1],
  ])
  expect((await ctx.chat.threads(42)).threads).toEqual([])

  // The thread's name opens the list of them by kind; the whole tour's offers no stop to go to.
  await pane.locator('#tour-ask-switch').click()
  await expect(pane.locator('.thread-group')).toHaveText(['Landmarks', 'Whole tour'])
  await pane.locator('.thread-item', { hasText: 'the whole tour' }).click()
  await expect(pane.locator('.turn.u')).toContainText('What is this tour about?')
  await expect(pane.locator('[data-act="ask-goto"]')).toBeHidden()

  // Back at the cover the pane shows the same thread; the landmark's brings its stop back.
  await page.locator('.tour-nav [data-nav="prev"]').click()
  await expect(pane.locator('.turn.a')).toContainText('covers the JSON output')
  await pane.locator('#tour-ask-switch').click()
  await pane.locator('.thread-item', { hasText: 'landmark ·' }).click()
  await pane.locator('[data-act="ask-goto"]').click()
  await expect(page).toHaveURL(/#landmark-l0$/)
  await expect(pane.locator('.turn.a')).toContainText('src/commands.ts:66')

  // The pane stays open across a reload, and closes on Escape.
  await page.reload()
  await expect(pane).toBeVisible()
  await expect(pane.locator('.turn.a')).toContainText('src/commands.ts:66')
  await expect(ask).toBeHidden()
  await pane.locator('#tour-ask-box').press('Escape')
  await expect(pane).toBeHidden()
  // The launcher is back, floating clear of next.
  await expect(ask).toBeVisible()
  const launcher = await ask.boundingBox()
  const next = await page.locator('.tour-nav [data-nav="next"]').boundingBox()
  const apart =
    launcher !== null &&
    next !== null &&
    (launcher.y + launcher.height <= next.y || launcher.x >= next.x + next.width)
  expect(apart).toBe(true)
  await page.keyboard.press('/')
  await expect(pane).toBeVisible()
  await expect(pane.locator('#tour-ask-box')).toBeFocused()
})
