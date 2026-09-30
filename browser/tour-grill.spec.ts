import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { TourArtifactSchema } from '../src/contract/tour.js'
import { PACKAGE_ROOT } from '../src/server/context.js'
import { BASE_SHA, HEAD_SHA, syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

const RESTATEMENT =
  '```restatement\n{ "what": "Only --json means JSON; a pipe prints text.", "where": ["src/commands.ts:66"], "unchanged": "prepare, validate, and publish keep printing JSON." }\n```'

test('grills a change through AI Chat, in the tour thread, and approves the restatement', async ({
  page,
  chatServer,
}) => {
  const { url, ctx } = await chatServer({
    runner: {
      script: options =>
        options.prompt.includes('How would you carry')
          ? [
              { type: 'chunk', text: '1. Change `outputMode` in `src/commands.ts`.\n2. Run `pnpm test`.' },
              { type: 'done', stopReason: 'end_turn' },
            ]
          : options.prompt.includes('I want to change this decision')
            ? [
                { type: 'chunk', text: 'What should a person piping into `less` see?' },
                { type: 'done', stopReason: 'end_turn' },
              ]
            : [
                { type: 'chunk', text: 'Thanks.\n' },
                { type: 'chunk', text: RESTATEMENT },
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
  const origin = new URL(url).origin
  await page.goto(`${origin}/tour/42#decision-pipe-means-json`)
  await page.locator('.tour-option[data-pick="change"]').click()
  await page.locator('[data-act="grill"]').click()
  const dialog = page.locator('#tour-grill')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.tour-chat-h .agent')).toContainText('claude')
  // The opening goes out by itself, and the agent asks its first question.
  await expect(dialog.locator('.tour-msg.reader').first()).toContainText('I want to change this decision')
  await expect(dialog.locator('.tour-msg.agent').first()).toContainText('piping into')
  await expect(dialog.locator('[data-act="stop"]')).toHaveCount(0)

  await dialog.locator('#composer').fill('Text, like at a terminal.')
  await dialog.locator('#composer').press('Enter')
  const card = dialog.locator('.tour-restate')
  await expect(card).toBeVisible()
  await expect(card).toContainText('a pipe prints text')
  await expect(card.locator('.where span')).toHaveText('src/commands.ts:66')

  // The drawer is drawn again once a turn ends; the next click waits for that.
  const settled = () => expect(dialog.locator('[data-act="stop"]')).toHaveCount(0)
  await settled()

  // The reverse quiz asks how the agent would do it.
  await dialog.locator('[data-act="reverse"]').click()
  await expect(dialog.locator('.tour-msg.agent').last()).toContainText('Change outputMode')
  await settled()

  await card.locator('[data-act="approve"]').click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.tour-state.change')).toContainText('change approved')
  await expect(page.locator('.tour-restated')).toContainText('a pipe prints text')
  await expect(page.locator('.toast')).toContainText('change approved')

  // The grilling ran in the tour's own thread: the canvas pane lists no thread.
  const threads = await ctx.chat.threads(42)
  expect(threads.threads).toEqual([])
  const history = await ctx.chat.tourHistory(42)
  expect(history.turns.filter(t => t.role === 'user').map(t => t.context?.kind)).toEqual([
    'tour-decision',
    'tour-decision',
    'tour-decision',
  ])
  expect(history.name).toMatch(/-t0$/)

  // Reopening shows the thread as it was and sends no opening again.
  await page.locator('[data-act="grill"]').click()
  await expect(dialog.locator('.tour-msg.reader')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
