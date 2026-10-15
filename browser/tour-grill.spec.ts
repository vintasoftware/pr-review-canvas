import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { TourArtifactSchema } from '../src/contract/tour.js'
import { PACKAGE_ROOT } from '../src/server/context.js'
import { BASE_SHA, HEAD_SHA, syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

const RESTATEMENT =
  '```restatement\n{ "what": "Only --json means JSON; a pipe prints text.", "where": ["src/commands.ts:66"], "unchanged": "prepare, validate, and publish keep printing JSON." }\n```'

test('grills something else through AI Chat, in the tour thread, and approves the restatement', async ({
  page,
  chatServer,
}) => {
  const { url, ctx } = await chatServer({
    runner: {
      script: options =>
        options.prompt.includes('I want neither')
          ? [
              { type: 'chunk', text: 'What should a person piping into `less` see?' },
              { type: 'done', stopReason: 'end_turn' },
            ]
          : options.prompt.includes("That's enough")
            ? [
                { type: 'chunk', text: 'Thanks.\n' },
                { type: 'chunk', text: RESTATEMENT },
                { type: 'done', stopReason: 'end_turn' },
              ]
            : [
                { type: 'chunk', text: 'And should `--json` still force JSON at a terminal?' },
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
  await page.locator('.tour-option[data-pick="other"]').click()
  const dialog = page.locator('#tour-grill')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.ctx-line')).toContainText('claude')
  // The opening goes out by itself, and the agent asks its first question.
  await expect(dialog.locator('.turn.u').first()).toContainText('I want neither')
  await expect(dialog.locator('.turn.a').first()).toContainText('piping into')
  await expect(dialog.locator('[data-act="stop"]')).toHaveCount(0)

  // Step one: talk it through.
  const step = dialog.locator('.tour-grill-steps [aria-current="step"]')
  await expect(step).toContainText('talk it through')
  await dialog.locator('#composer').fill('Text, like at a terminal.')
  await dialog.locator('#composer').press('Enter')
  await expect(dialog.locator('.turn.a').last()).toContainText('still force JSON')

  // Step two: finish. The agent restates from what it has.
  await dialog.locator('.tour-grill-guide [data-act="done"]').click()
  await expect(dialog.locator('.turn.u').last()).toContainText("That's enough")
  const card = dialog.locator('.tour-restate')
  await expect(card).toBeVisible()
  await expect(card).toContainText('a pipe prints text')
  await expect(card.locator('.where span')).toHaveText('src/commands.ts:66')

  // Step three: approve.
  await expect(step).toContainText('approve')
  await expect(dialog.locator('[data-act="done"]')).toHaveCount(0)
  // Edit shows each field whole, at least five lines tall, with nothing to scroll inside it.
  await card.locator('[data-act="edit"]').click()
  const fields = dialog.locator('form[data-act="restate"] textarea')
  await expect(fields).toHaveCount(3)
  for (const field of await fields.all()) {
    const size = await field.evaluate(el => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
      line: parseFloat(getComputedStyle(el).lineHeight),
    }))
    expect(size.scroll).toBeLessThanOrEqual(size.client + 1)
    expect(size.client).toBeGreaterThanOrEqual(size.line * 5)
  }
  await dialog.locator('[data-act="redraw"]').click()
  await card.locator('[data-act="approve"]').click()
  await expect(dialog).toBeHidden()
  // Approving settles the decision and stays on it: something else is chosen, the restatement shown.
  await expect(page).toHaveURL(/#decision-pipe-means-json$/)
  await expect(page.locator('.tour-option[aria-checked="true"]')).toHaveAttribute('data-pick', 'other')
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
  await expect(dialog.locator('.turn.u')).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // Reading the conversation again does not take the approval back.
  await expect(page.locator('.tour-state.change')).toContainText('change approved')
})
