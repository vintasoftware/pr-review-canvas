import { syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

test('lists the review being written in the side pane, edits a draft there, and drops it', async ({
  page,
  chatServer,
}, testInfo) => {
  // Narrower screens float the pane over the canvas; the wide one docks it beside the canvas.
  test.skip(testInfo.project.name !== 'desktop')
  const { url } = await chatServer()
  await page.goto(url)
  const pane = page.locator('aside.chat')
  const reviewTab = pane.getByRole('tab', { name: /Your review/ })
  await expect(reviewTab.locator('.review-count')).toHaveText('0')

  const point = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await point.locator('[data-act="point-queue"]').click()
  await expect(reviewTab.locator('.review-count')).toHaveText('1')

  // The pending bar opens the list in its tab; AI Chat keeps its place behind it.
  await page.locator('#msg').fill('half a question')
  await page.locator('.pending-bar [data-act="show-review"]').click()
  await expect(reviewTab).toHaveAttribute('aria-selected', 'true')
  await expect(reviewTab).toBeFocused()
  const panel = page.getByRole('tabpanel', { name: /Your review/ })
  await expect(panel).toBeVisible()
  await expect(page.locator('#chat-log')).toBeHidden()
  const draft = panel.locator('.review-draft')
  await expect(draft).toHaveCount(1)
  await expect(draft.locator('.review-where')).toContainText('src/app.ts:4')
  await expect(draft.locator('.review-where')).toContainText('from the point “Sum instead of product”')

  await draft.locator('[data-act="pending-edit"]').click()
  await panel.locator('.composer-box textarea').fill('Is the sum what the spec wants?')
  await panel.locator('.composer-box [data-act="pending-save"]').click()
  await expect(panel.locator('.review-draft .pending-cmt > .prose')).toContainText(
    'Is the sum what the spec wants?'
  )
  // The edit shows on the diff and on the point too: there is one draft.
  await expect(page.locator('tr.pending-row .pending-cmt')).toContainText('Is the sum what the spec wants?')
  await expect(point.locator('.p-outcome .pending-cmt > .prose')).toContainText(
    'Is the sum what the spec wants?'
  )

  // Back on AI Chat, the half-written question is still there.
  await pane.getByRole('tab', { name: 'AI Chat' }).click()
  await expect(page.locator('#msg')).toHaveValue('half a question')
  await reviewTab.press('ArrowLeft')
  await pane.getByRole('tab', { name: 'AI Chat' }).press('ArrowRight')
  await expect(reviewTab).toHaveAttribute('aria-selected', 'true')

  await panel.locator('[data-act="pending-delete"]').click()
  await expect(panel.locator('.review-empty')).toBeVisible()
  await expect(reviewTab.locator('.review-count')).toHaveText('0')
  await expect(point).toHaveAttribute('data-status', 'open')
})

test('a wheel over a review list too short to scroll moves the page', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  const { url } = await chatServer()
  await page.goto(url)
  await page
    .locator('aside.chat')
    .getByRole('tab', { name: /Your review/ })
    .click()
  const panel = page.locator('#review-panel')
  await expect(panel.locator('.review-empty')).toBeVisible()
  expect(await panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(false)
  const box = await panel.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 40)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
})

test('asking AI Chat about a point brings its tab back from the review', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  const { url } = await chatServer()
  await page.goto(url)
  const pane = page.locator('aside.chat')
  await pane.getByRole('tab', { name: /Your review/ }).click()
  await expect(page.locator('#chat-log')).toBeHidden()
  await page.locator('section.layer li.finding[data-fingerprint="fp-1"] [data-act="ask"]').click()
  await expect(pane.getByRole('tab', { name: 'AI Chat' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#chat-log')).toBeVisible()
})

test('without AI Chat, the review has a pane of its own that opens on demand', async ({
  page,
  noChatUrl,
}) => {
  await page.goto(noChatUrl)
  const launcher = page.locator('#chat-launcher')
  const pane = page.locator('aside.review-only')
  // Nothing waits, so nothing stands for the review and the canvas keeps its width.
  await expect(launcher).toBeHidden()
  await expect(pane).toBeHidden()

  await page.locator('section.layer li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]').click()
  await expect(launcher).toBeVisible()
  await expect(launcher).toHaveText('Your review · 1')
  await expect(pane).toBeHidden()

  await page.locator('.pending-bar [data-act="show-review"]').click()
  const panel = page.locator('#review-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.review-draft')).toHaveCount(1)
  await page.getByRole('button', { name: 'Minimize your review' }).click()
  await expect(panel).toBeHidden()
  await expect(launcher).toBeVisible()
  await launcher.click()
  await expect(panel).toBeVisible()
})

test('a comment AI Chat ties to a point acts on that point once it joins the review', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  const proposal = { path: 'src/app.ts', line: 3, body: 'Cap the peer range.', point: 'fp-1' }
  const { url } = await chatServer({
    runner: {
      script: [
        { type: 'chunk', text: '```comment\n' + JSON.stringify(proposal) + '\n```' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    },
  })
  await page.goto(url)
  const point = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await point.locator('[data-act="ask"]').click()
  await page.locator('#msg').fill('Should we cap it?')
  await page.locator('#chat-send').click()
  const card = page.locator('.proposed').first()
  await expect(card.locator('.proposed-point')).toHaveText('about the point “Sum instead of product” unlink')

  await card.locator('[data-act="proposed-queue"]').click()
  // The point shows the comment as its draft, though the comment sits on another line.
  await expect(point).toHaveAttribute('data-status', 'queued')
  await expect(point.locator('.p-summary')).toHaveText(
    'Waits in your review at src/app.ts:3 · not on GitHub yet'
  )
  await expect(card.locator('[data-act="proposed-unlink"]')).toHaveCount(0)
  await page
    .locator('aside.chat')
    .getByRole('tab', { name: /Your review/ })
    .click()
  await expect(page.locator('#review-panel .review-where')).toContainText(
    'proposed by AI Chat about the point “Sum instead of product”'
  )
  // Taking the draft away opens the point again, and the card can be untied once more.
  await page.locator('#review-panel [data-act="pending-delete"]').click()
  await expect(point).toHaveAttribute('data-status', 'open')
  await page.locator('aside.chat').getByRole('tab', { name: 'AI Chat' }).click()
  await expect(card.locator('[data-act="proposed-unlink"]')).toHaveCount(1)
})

test('the author resolves a point with the reason AI Chat proposed', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  const proposal = { point: 'fp-1', reason: 'We keep the sum; the spec says so.' }
  const { url } = await chatServer({
    runner: {
      script: [
        { type: 'chunk', text: 'Then resolve it.\n```resolve\n' + JSON.stringify(proposal) + '\n```' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    },
    // The author's own canvas, with the canvas comment off so nothing goes to the forge.
    setup: async t => {
      t.ctx.fixtureArtifact = null
      t.ctx.projectConfig = {
        ...t.ctx.projectConfig,
        config: { ...t.ctx.projectConfig.config, sharing: { canvasComment: false, mentionCanvas: false } },
      }
      const artifact = syntheticArtifact()
      await t.ctx.canvases.write(
        artifact.pr.headSha,
        artifact,
        {
          formatVersion: 1,
          tool: { name: 'pr-review', version: '0.5.0' },
          repo: artifact.pr.repo,
          prNumber: 42,
          headSha: artifact.pr.headSha,
          mergeBaseSha: artifact.pr.mergeBaseSha,
          generatedAt: artifact.generatedAt,
          generator: artifact.generator,
          baseRef: 'main',
          headRef: 'feat/b',
        },
        42
      )
    },
  })
  await page.goto(url)
  const point = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await point.locator('[data-act="ask"]').click()
  await page.locator('#msg').fill('We decided to keep the sum.')
  await page.locator('#chat-send').click()
  const card = page.locator('.proposed[data-resolution="fp-1"]')
  await expect(card.locator('.proposed-point')).toHaveText('about the point “Sum instead of product”')
  await card.locator('[data-act="resolution-save"]').click()
  await expect(point).toHaveAttribute('data-status', 'resolved')
  await expect(point.locator('.p-summary')).toHaveText(
    'Resolved by the author: We keep the sum; the spec says so.'
  )
  await expect(card.locator('.pill.status.resolved')).toHaveText('resolved')
})
