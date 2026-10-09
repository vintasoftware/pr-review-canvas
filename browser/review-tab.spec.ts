import { syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test, type ChatServerOptions } from './fixtures.js'

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
  await expect(point.locator('.p-draft-where')).toHaveText('src/app.ts:4 · your edit of the point’s text')

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

/** The author's own canvas, with the canvas comment off so nothing goes to the forge. */
async function authorCanvas(t: Parameters<NonNullable<ChatServerOptions['setup']>>[0]) {
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
}

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
    setup: authorCanvas,
  })
  await page.goto(url)
  const point = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await point.locator('[data-act="ask"]').click()
  await page.locator('#msg').fill('We decided to keep the sum.')
  await page.locator('#chat-send').click()
  const card = page.locator('.proposed.resolution')
  await expect(card.locator('.proposed-point')).toHaveText('about the point “Sum instead of product”')
  await card.locator('[data-act="resolution-save"]').click()
  await expect(point).toHaveAttribute('data-status', 'resolved')
  await expect(point.locator('.p-summary')).toHaveText(
    'Resolved by the author: We keep the sum; the spec says so.'
  )
  await expect(card.locator('.pill.status.resolved')).toHaveText('resolved')
})

test('edit on a proposed resolution shows its point while the acted-on points are hidden', async ({
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
    setup: authorCanvas,
  })
  await page.goto(url)
  const point = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await point.locator('[data-act="ask"]').click()
  await page.locator('#msg').fill('We decided to keep the sum.')
  await page.locator('#chat-send').click()
  const card = page.locator('.proposed.resolution')
  await expect(card.locator('[data-act="resolution-edit"]')).toBeVisible()

  // A point in the review can still be resolved, but the switch takes it off the page.
  await point.locator('[data-act="point-queue"]').click()
  await expect(point).toHaveAttribute('data-status', 'queued')
  await page.locator('[data-act="toggle-handled"]').click()
  await expect(point).toBeHidden()

  // Editing the reason brings the point back with its box, and it leaves again once the box closes.
  await card.locator('[data-act="resolution-edit"]').click()
  const reason = point.locator('.settle-box textarea')
  await expect(reason).toBeVisible()
  await expect(reason).toHaveValue(proposal.reason)
  await expect(reason).toBeFocused()
  await point.locator('[data-act="settle-cancel"]').click()
  await expect(point).toBeHidden()
})

/** A chat that answers with a resolution proposal for `point`. */
function resolutionScript(point: string, reason: string) {
  return {
    script: [
      {
        type: 'chunk' as const,
        text: 'Then resolve it.\n```resolve\n' + JSON.stringify({ point, reason }) + '\n```',
      },
      { type: 'done' as const, stopReason: 'end_turn' },
    ],
  }
}

test('edit on a proposed resolution steps the phone modal aside and focuses the reason', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  await page.setViewportSize({ width: 390, height: 900 })
  const { url } = await chatServer({
    runner: resolutionScript('fp-1', 'The spec requires a sum.'),
    setup: authorCanvas,
  })
  await page.goto(url)
  const point = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await point.locator('[data-act="ask"]').click()
  await page.locator('#msg').fill('Resolve this with a reason.')
  await page.locator('#chat-send').click()
  await page.locator('[data-act="resolution-edit"]').click()
  await expect(page.locator('#chat-dialog')).not.toHaveAttribute('open')
  const reason = point.locator('.settle-box textarea')
  await expect(reason).toHaveValue('The spec requires a sum.')
  await expect(reason).toBeFocused()
})

test('edit on a proposed resolution draws a point of the collapsed Other layer', async ({
  page,
  chatServer,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  const { url } = await chatServer({
    runner: resolutionScript('fp-3', 'Nothing imports this file.'),
    setup: authorCanvas,
  })
  await page.goto(url)
  await page.locator('#msg').fill('Resolve the deleted file point.')
  await page.locator('#chat-send').click()
  await page.locator('[data-act="resolution-edit"]').click()
  const reason = page.locator('[data-fingerprint="fp-3"] .settle-box textarea').first()
  await expect(reason).toBeVisible()
  await expect(reason).toHaveValue('Nothing imports this file.')
  await expect(reason).toBeFocused()
})

for (const width of [390, 800]) {
  test(`a draft's line link minimizes the floating review over it at width ${width}`, async ({
    page,
    noChatUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop')
    await page.setViewportSize({ width, height: 900 })
    await page.goto(noChatUrl)
    await page.locator('section.layer li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]').click()
    await page.locator('.pending-bar [data-act="show-review"]').click()
    await expect(page.locator('#chat-dialog')).toHaveAttribute('open')
    await page.locator('#review-panel .review-where a').click()
    await expect(page.locator('#chat-dialog')).not.toHaveAttribute('open')
    const row = page.locator('tr.pending-row').first()
    await expect(row).toBeInViewport()
    // The row is what a pointer reaches at its middle, not a pane over it.
    const reached = await row.evaluate(el => {
      const b = el.getBoundingClientRect()
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
      return hit !== null && el.contains(hit)
    })
    expect(reached).toBe(true)
    // The launcher brings the review back as it was.
    await page.locator('#chat-launcher').click()
    await expect(page.locator('#review-panel .review-draft')).toHaveCount(1)
  })
}

test('a draft being edited keeps the focus and caret when another draft finishes saving', async ({
  page,
  reviewUrl,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  await page.goto(reviewUrl)
  await page.locator('section.layer li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]').click()
  await page.locator('.pending-bar [data-act="show-review"]').click()
  await page.locator('#review-panel [data-act="pending-edit"]').click()
  const input = page.locator('#review-panel textarea')
  await input.fill('In progress')
  await page.locator('#layer-other summary').click()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  await page.route('**/pending', async route => {
    if (route.request().method() === 'POST') await gate
    await route.continue()
  })
  await page.locator('#layer-other tr.ifind[data-fingerprint="fp-2"] [data-act="point-queue"]').click()
  await input.focus()
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 8))
  release()
  await expect(page.locator('#review-panel .review-draft')).toHaveCount(2)
  await expect(input).toHaveValue('In progress')
  await expect(input).toBeFocused()
  expect(await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([
    3, 8,
  ])
})

test('a review submitted from the phone modal leaves its receipt on top', async ({
  page,
  noChatUrl,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(noChatUrl)
  await page.locator('section.layer li.finding[data-fingerprint="fp-1"] [data-act="point-queue"]').click()
  await page.locator('.pending-bar [data-act="show-review"]').click()
  await page.locator('#review-panel [data-act="pending-finish"]').click()
  await page.locator('#signoff-dialog [data-act="signoff-post"]').click()
  await expect(page.locator('#signoff-dialog')).toBeHidden()
  await expect(page.locator('#chat-dialog')).not.toHaveAttribute('open')
  const receipt = page.locator('.toast a[href$="pullrequestreview-7001"]')
  await expect(receipt).toBeVisible()
  // Nothing covers it: a click would land on the link.
  await receipt.click({ trial: true, timeout: 2000 })
})
