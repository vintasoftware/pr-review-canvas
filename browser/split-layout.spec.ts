import { expect, test } from './fixtures.js'

/** Wide enough for split with the AI Chat pane docked beside the diff. */
const WIDE = { width: 1920, height: 1000 }

test.describe('split layout', () => {
  test.use({ settings: { diffLayout: 'split' } })

  test('draws the old and new code side by side, and s switches back to unified for good', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()

    // The changed line sits beside the line it became, each side with its own number.
    const row = file.locator('#L-src_app_ts-new-4')
    await expect(row.locator('td.code.del')).toHaveText('-  return a()')
    await expect(row.locator('td.code.add')).toHaveText('+  return a() + b()')
    await expect(row.locator('td.ln[data-side="old"]')).toHaveText('3')
    const [left, right] = await Promise.all([
      row.locator('td.code.del').boundingBox(),
      row.locator('td.code.add').boundingBox(),
    ])
    expect(right!.x).toBeGreaterThan(left!.x + left!.width - 1)
    expect(Math.abs(left!.width - right!.width)).toBeLessThan(2)
    await expect(page.locator('.diff-layout [data-layout="split"]')).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: testInfo.outputPath('split.png') })

    const saved = page.waitForRequest(r => r.url().endsWith('/api/settings') && r.method() === 'PUT')
    await page.keyboard.press('s')
    expect((await saved).postDataJSON()).toEqual({ diffLayout: 'unified' })
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(file.locator('tr.del#L-src_app_ts-old-3')).toBeVisible()

    await page.reload()
    await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
    await expect(page.locator('#L-src_app_ts-old-3')).toHaveClass(/\bdel\b/)
    await expect(page.locator('.diff-layout [data-layout="unified"]')).toHaveAttribute('aria-pressed', 'true')
  })

  test('comments on the old side from its own gutter, and keeps a half-written box across a switch', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()

    // A click on the left numbers selects the old side alone.
    await file.locator('#L-src_app_ts-new-4 td.ln[data-side="old"]').click()
    await expect(file.locator('#L-src_app_ts-new-4 td.is-selected')).toHaveCount(3)
    await expect(file.locator('#L-src_app_ts-new-4 td[data-side="new"].is-selected')).toHaveCount(0)
    await expect(file.locator('tr.sel-bar .lbl')).toHaveText('src/app.ts line 3')
    await page.keyboard.press('Escape')

    await file.locator('#L-src_app_ts-new-4 td.code.del').hover()
    await file.locator('#L-src_app_ts-new-4 td.gut[data-side="old"] .plus').click()
    const editor = file.locator('tr.composer')
    await editor.locator('textarea').fill('why drop the product?')

    // The box rides along to the unified row of its line, then back.
    await page.locator('.diff-layout [data-layout="unified"]').click()
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(editor.locator('textarea')).toHaveValue('why drop the product?')
    await page.locator('.diff-layout [data-layout="split"]').click()
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    await expect(editor.locator('textarea')).toHaveValue('why drop the product?')

    const added = page.waitForRequest(r => r.url().includes('/pending') && r.method() === 'POST')
    await editor.locator('[data-act="composer-queue"]').click()
    expect((await added).postDataJSON()).toMatchObject({ path: 'src/app.ts', side: 'old', line: 3 })
    await expect(file.locator('tr.pending-row .pending-cmt')).toHaveCount(1)
  })

  test('draws unified where the diff column is too narrow, and says why split waits', async ({
    page,
    reviewUrl,
  }) => {
    // Every project's window is too narrow for split beside the docked AI Chat pane.
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    await expect(file.locator('tr.del#L-src_app_ts-old-3')).toBeVisible()
    await expect(page.locator('table.diff.split')).toHaveCount(0)
    const split = page.locator('.diff-layout [data-layout="split"]')
    await expect(split).toBeDisabled()
    await expect(split).toHaveAttribute('title', /split needs a diff column at least 900px wide/)

    await page.keyboard.press('s')
    await expect(page.locator('.toast')).toContainText('split needs a diff column at least 900px wide')

    // Widened, the page draws the saved choice.
    await page.setViewportSize(WIDE)
    await expect(page.locator('table.diff.split').first()).toBeVisible()
    await expect(split).toBeEnabled()
  })
})
