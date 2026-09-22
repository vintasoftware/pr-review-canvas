import { expect, test } from './fixtures.js'

for (const skin of ['terminal', 'github'] as const) {
  test(`holds a comment in a pending review, shows it, and discards it in the ${skin} skin`, async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(`${reviewUrl}?skin=${skin}`)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()

    // No review is open, so the first command offers to start one.
    await file.locator('#L-src_app_ts-new-4 .plus').click()
    const editor = file.locator('tr.composer')
    await expect(editor.locator('[data-act="composer-queue"]')).toHaveText('start a review')
    await editor.locator('textarea').fill('this needs a guard')
    await editor.locator('[data-act="composer-queue"]').click()

    // The draft is drawn under its line, badged as not posted.
    const draft = file.locator('tr.pending-row .pending-cmt')
    await expect(draft).toHaveCount(1)
    await expect(page.locator('tr.pending-row .pending-cmt')).toHaveCount(1)
    await expect(draft.locator('.pill.pending')).toHaveText('pending')
    await expect(draft.locator('.prose')).toContainText('this needs a guard')
    await expect(editor).toHaveCount(0)

    // The draft sits below the line it comments on, like a posted comment does.
    const line = await file.locator('#L-src_app_ts-new-4 td.code').boundingBox()
    const bounds = await draft.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(line!.y + line!.height)

    // The bar says a review is open and offers both ways out of it.
    const bar = page.locator('.pending-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('1 pending comment')
    // Both skins mark it with the same heavy edge, so an open review is hard to miss in either.
    await expect(bar).toHaveCSS('border-left-width', '4px')
    const edge = await bar.evaluate(el => getComputedStyle(el).borderLeftColor)
    await expect(bar).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    expect(edge).not.toBe('rgba(0, 0, 0, 0)')
    await page.screenshot({ path: test.info().outputPath(`pending-review-${skin}.png`) })

    // A second comment joins the review already open, and that is now the only way out of the
    // box: a single comment would publish ahead of the review still being written.
    await file.locator('#L-src_app_ts-new-5 .plus').click()
    await expect(editor.locator('[data-act="composer-queue"]')).toHaveText('add review comment')
    await expect(editor.locator('[data-act="composer-post"]')).toHaveCount(0)
    await editor.locator('textarea').fill('and a test for it')
    await editor.locator('[data-act="composer-queue"]').click()
    await expect(bar).toContainText('2 pending comments')
    await expect(file.locator('tr.pending-row .pending-cmt')).toHaveCount(2)

    // Editing one draft swaps it for a box holding what it said.
    const first = file.locator('.pending-cmt').first()
    await first.locator('[data-act="pending-edit"]').click()
    const box = first.locator('.composer-box')
    await expect(box.locator('textarea')).toHaveValue('this needs a guard')
    await box.locator('textarea').fill('this needs two guards')
    await box.locator('[data-act="pending-save"]').click()
    // The box closes and the draft is drawn again from what the server now holds.
    await expect(first.locator('.composer-box')).toHaveCount(0)
    await expect(first).toContainText('this needs two guards')

    // Deleting one leaves the other, and the bar counts down with it.
    await first.locator('[data-act="pending-delete"]').click()
    await expect(file.locator('tr.pending-row .pending-cmt')).toHaveCount(1)
    await expect(bar).toContainText('1 pending comment')

    // Discarding takes the last draft and the bar away together.
    await bar.locator('[data-act="pending-discard"]').click()
    await expect(page.locator('.pending-bar')).toHaveCount(0)
    await expect(file.locator('tr.pending-row')).toHaveCount(0)
  })
}

test('gives a draft its commands back when an edit is cancelled', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const file = page.locator('article.file[data-path="src/app.ts"]').first()
  await file.scrollIntoViewIfNeeded()

  await file.locator('#L-src_app_ts-new-4 .plus').click()
  const editor = file.locator('tr.composer')
  await editor.locator('textarea').fill('this needs a guard')
  await editor.locator('[data-act="composer-queue"]').click()

  const draft = file.locator('tr.pending-row .pending-cmt').first()
  await draft.locator('[data-act="pending-edit"]').click()
  // The box stands in front of the draft, so neither the body nor its commands are on screen.
  await expect(draft.locator('.composer-box')).toHaveCount(1)
  await expect(draft.locator('[data-act="pending-edit"]')).toBeHidden()

  await draft.locator('[data-act="composer-cancel"]').click()

  // Cancelling puts the draft back as it was. It used to leave edit and delete hidden until some
  // other change redrew the row, which left the draft stranded on the page.
  await expect(draft.locator('.composer-box')).toHaveCount(0)
  await expect(draft.locator('.prose')).toBeVisible()
  await expect(draft.locator('.prose')).toContainText('this needs a guard')
  await expect(draft.locator('[data-act="pending-edit"]')).toBeVisible()
  await expect(draft.locator('[data-act="pending-delete"]')).toBeVisible()

  // And the draft can be edited again, which is what the hidden commands had made impossible.
  await draft.locator('[data-act="pending-edit"]').click()
  await expect(draft.locator('.composer-box textarea')).toHaveValue('this needs a guard')
  // Escape is the other way out, and puts the draft back the same way.
  await page.keyboard.press('Escape')
  await expect(draft.locator('.composer-box')).toHaveCount(0)
  await expect(draft.locator('[data-act="pending-edit"]')).toBeVisible()
})

test('keeps a pending review across a reload', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const file = page.locator('article.file[data-path="src/app.ts"]').first()
  await file.scrollIntoViewIfNeeded()
  await file.locator('#L-src_app_ts-new-4 .plus').click()
  await file.locator('tr.composer textarea').fill('written before the reload')
  await file.locator('tr.composer [data-act="composer-queue"]').click()
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')

  await page.reload()
  // The drafts are review state on this machine, so they are still there.
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')
  const reloaded = page.locator('article.file[data-path="src/app.ts"]').first()
  await reloaded.scrollIntoViewIfNeeded()
  await expect(reloaded.locator('tr.pending-row .pending-cmt')).toContainText('written before the reload')
})

test('comments on a range of lines picked with a shift-click', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const file = page.locator('article.file[data-path="src/app.ts"]').first()
  await file.scrollIntoViewIfNeeded()
  await file.locator('#L-src_app_ts-new-4 td.ln').nth(1).click()
  await file
    .locator('#L-src_app_ts-new-5 td.ln')
    .nth(1)
    .click({ modifiers: ['Shift'] })
  await expect(file.locator('tr.is-selected')).toHaveCount(2)

  const bar = file.locator('tr.sel-bar')
  await expect(bar).toContainText('src/app.ts lines 4–5')
  await bar.locator('[data-act="comment-selection"]').click()
  // The composer carries both ends of the range, which is what makes the comment multi-line.
  const editor = file.locator('tr.composer .composer-box')
  await expect(editor).toHaveAttribute('data-start-line', '4')
  await expect(editor).toHaveAttribute('data-line', '5')

  // The draft that comes out of it keeps the range, so it posts as a multi-line comment.
  await editor.locator('textarea').fill('this whole block')
  await editor.locator('[data-act="composer-queue"]').click()
  await expect(file.locator('.pending-cmt')).toHaveCount(1)
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')
})

test('adds an attention point to the review and gives it back on delete', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const point = page.locator('.findings li.finding[data-fingerprint="fp-1"]').first()
  await point.scrollIntoViewIfNeeded()
  // A point offers both ways to send it, and keeps both while a review is open.
  await expect(point.locator('[data-act="point-post"]')).toHaveCount(1)
  await point.locator('[data-act="point-queue"]').click()

  await expect(point.locator('.pill.pending')).toHaveText('in your review')
  await expect(point.locator('[data-act="point-queue"]')).toHaveCount(0)
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')
  // The point's own text is what waits, drawn on the line it is anchored to.
  await expect(page.locator('tr.pending-row .pending-cmt')).toContainText('Sum instead of product')

  await page.locator('tr.pending-row [data-act="pending-delete"]').click()
  await expect(point.locator('.pill.pending')).toHaveCount(0)
  await expect(point.locator('[data-act="point-post"]')).toHaveCount(1)
  await expect(point.locator('[data-act="point-queue"]')).toHaveCount(1)
})

test('turns a submitted attention point into a posted thread and link', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const point = page.locator('li[data-point="p-1"]')
  await point.locator('[data-act="point-queue"]').click()
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')
  await page.locator('[data-act="pending-finish"]').click()
  const dialog = page.locator('#signoff-dialog')
  await expect(dialog.locator('[data-act="signoff-post"]')).toBeEnabled()
  await dialog.locator('[data-act="signoff-post"]').click()
  await expect(dialog.locator('.signoff-result')).toContainText('Posted')
  await expect(page.locator('tr.pending-row')).toHaveCount(0)
  await expect(page.locator('tr.thread[data-thread="8001"]')).toContainText('Sum instead of product')
  await expect(point.locator('.tbtns a')).toHaveAttribute('href', /discussion_r8001$/)
  await expect(point.locator('[data-act="point-queue"]')).toHaveCount(0)
})
