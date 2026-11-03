import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

/** The file of PR 42 that holds an annotation, the point p-1, and the resolved thread 1001. */
function appFile(page: Page): Locator {
  return page.locator('article.file[data-path="src/app.ts"]').first()
}

/** Opens the review with src/app.ts drawn, so its inline rows are in the page. */
async function openDrawn(page: Page, url: string): Promise<Locator> {
  await page.goto(url)
  const file = appFile(page)
  await file.scrollIntoViewIfNeeded()
  await file.locator('tr.ifind').first().waitFor()
  return file
}

/**
 * Runs a switch and waits for its save to land. The page switches at once and saves in the
 * background, so a reload that overtook the save would come back the old way.
 */
async function saved(page: Page, act: () => Promise<void>) {
  const put = page.waitForResponse(
    response =>
      new URL(response.url()).pathname.endsWith('/api/settings') && response.request().method() === 'PUT'
  )
  await act()
  expect((await put).ok()).toBe(true)
}

/** What the layer summary shows: its point cards and the line that counts them by status. */
async function summary(page: Page): Promise<string[]> {
  return [
    await page
      .locator('section.layer li.finding')
      .evaluateAll(cards => cards.map(c => c.outerHTML).join('\n')),
    (await page.locator('.point-statuses').first().textContent()) ?? '',
  ]
}

test('hides and shows every inline item, keeps the layer summary as it was, and remembers it', async ({
  page,
  reviewUrl,
}) => {
  const file = await openDrawn(page, reviewUrl)
  const rows = {
    point: file.locator('tr.ifind[data-point="p-1"]'),
    thread: file.locator('tr.thread[data-thread="1001"]'),
    note: file.locator('tr.annot'),
  }
  const toggle = page.locator('#inline-toggle')
  for (const row of Object.values(rows)) await expect(row).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  const before = await summary(page)
  await page.screenshot({ path: test.info().outputPath('inline-shown.png') })

  await saved(page, () => toggle.click())
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveText('show inline items')
  await expect(page.locator('.inline-hint')).toContainText('still in the layer summary')
  for (const row of Object.values(rows)) await expect(row).toBeHidden()
  // Only the code is left: the rows are still in the page, and the code lines are where they were.
  await expect(rows.point).toHaveCount(1)
  await expect(file.locator('#L-src_app_ts-new-4')).toBeVisible()
  expect(await summary(page)).toEqual(before)
  await page.screenshot({ path: test.info().outputPath('inline-hidden.png') })

  // The setting outlives the page.
  await page.reload()
  await appFile(page).scrollIntoViewIfNeeded()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(rows.point).toHaveCount(1)
  for (const row of Object.values(rows)) await expect(row).toBeHidden()
  expect(await summary(page)).toEqual(before)

  // The i key switches it back, and the same items return.
  await saved(page, () => page.locator('body').press('i'))
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  for (const row of Object.values(rows)) await expect(row).toBeVisible()
  await page.reload()
  await expect(page.locator('#inline-toggle')).toHaveAttribute('aria-pressed', 'false')
})

test('keeps the code under the reader in place when it switches', async ({ page, reviewUrl }) => {
  const file = await openDrawn(page, reviewUrl)
  // A code line below the annotation and the point, so rows above it go and come back.
  const line = file.locator('#L-src_app_ts-new-5')
  await line.evaluate(el => el.scrollIntoView({ block: 'center' }))
  const y = async () => (await line.boundingBox())!.y
  const start = await y()
  await page.locator('body').press('i')
  await expect(file.locator('tr.ifind[data-point="p-1"]')).toBeHidden()
  expect(Math.abs((await y()) - start)).toBeLessThan(2)
  await page.locator('body').press('i')
  await expect(file.locator('tr.ifind[data-point="p-1"]')).toBeVisible()
  expect(Math.abs((await y()) - start)).toBeLessThan(2)
})

test('a click on a point in the layer summary shows only that point', async ({ page, reviewUrl }) => {
  const file = await openDrawn(page, reviewUrl)
  await page.locator('#inline-toggle').click()
  const inline = file.locator('tr.ifind[data-point="p-1"]')
  await expect(inline).toBeHidden()

  await page.locator('section.layer li.finding[data-point="p-1"] a[data-item-link]').click()
  await expect(inline).toBeVisible()
  await expect(inline).toBeInViewport()
  // The rest stays hidden, and so does the switch.
  await expect(file.locator('tr.thread[data-thread="1001"]')).toBeHidden()
  await expect(file.locator('tr.annot')).toBeHidden()
  await expect(page.locator('#inline-toggle')).toHaveAttribute('aria-pressed', 'true')

  // Switching off and on again puts the point back under the rule.
  await page.locator('body').press('i')
  await page.locator('body').press('i')
  await expect(inline).toBeHidden()
})

test('a code link in the text of a point is not a visit to the point', async ({ page, reviewUrl }) => {
  const file = await openDrawn(page, reviewUrl)
  await page.locator('#inline-toggle').click()
  // A link the point's markdown would draw, to another line of the file.
  await page.locator('section.layer li.finding[data-point="p-1"] .prose').evaluate(prose => {
    prose.insertAdjacentHTML(
      'beforeend',
      '<a class="loc" data-link="#line:src/app.ts:5" href="#line:src/app.ts:5">src/app.ts:5</a>'
    )
  })
  await page.locator('section.layer li.finding[data-point="p-1"] .prose a.loc').click()
  await expect(file.locator('#L-src_app_ts-new-5')).toBeInViewport()
  await expect(file.locator('tr.ifind[data-point="p-1"]')).toBeHidden()
  await expect(page.locator('#inline-toggle')).toHaveAttribute('aria-pressed', 'true')
})

test('a resolved point the author keeps open stays in the layer summary through the switch', async ({
  page,
  selfReviewUrl,
}) => {
  await page.goto(selfReviewUrl)
  const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await card.locator('[data-act="point-settle"]').click()
  await card.locator('.settle-box textarea').fill('The spec says sum.')
  await card.locator('[data-act="settle-save"]').click()
  await expect(card).toHaveAttribute('data-status', 'resolved')
  await expect(card).toBeVisible()
  await page.locator('body').press('i')
  await expect(page.locator('#inline-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('body').press('i')
  await expect(page.locator('#inline-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(card).toBeVisible()
})

test('with "turn hiding off" chosen, a summary click switches it off and lands on the item', async ({
  page,
  reviewUrl,
}) => {
  const file = await openDrawn(page, reviewUrl)
  await page.locator('#inline-toggle').click()
  await page.locator('#settings').click()
  const dialog = page.locator('dialog.settings')
  await dialog.locator('#set-hidden-item-click').selectOption('show-all')
  await dialog.locator('[data-act="settings-save"]').click()
  await expect(dialog).toBeHidden()
  const toggle = page.locator('#inline-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(file.locator('tr.ifind[data-point="p-1"]')).toBeHidden()

  await page.locator('section.layer li.finding[data-point="p-1"] a[data-item-link]').click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(file.locator('tr.ifind[data-point="p-1"]')).toBeVisible()
  await expect(file.locator('tr.thread[data-thread="1001"]')).toBeVisible()
  await expect(file.locator('#L-src_app_ts-new-4')).toBeInViewport()
})

test('hides only the kinds the settings name', async ({ page, reviewUrl }) => {
  const file = await openDrawn(page, reviewUrl)
  await page.locator('#settings').click()
  const dialog = page.locator('dialog.settings')
  await dialog.locator('input[name="set-inline-kind"][value="comments"]').uncheck()
  await dialog.locator('input[name="set-inline-kind"][value="annotations"]').uncheck()
  await dialog.locator('[data-act="settings-save"]').click()
  await expect(dialog).toBeHidden()
  await page.locator('#inline-toggle').click()
  await expect(page.locator('.inline-hint')).toContainText('points and drafts hidden')
  await expect(file.locator('tr.ifind[data-point="p-1"]')).toBeHidden()
  await expect(file.locator('tr.thread[data-thread="1001"]')).toBeVisible()
  await expect(file.locator('tr.annot')).toBeVisible()
})

test('a new comment can be written on a line while items are hidden, and its draft stays listed', async ({
  page,
  reviewUrl,
}) => {
  const file = await openDrawn(page, reviewUrl)
  await page.locator('#inline-toggle').click()
  await file.locator('#L-src_app_ts-new-4 .plus').click()
  const editor = file.locator('tr.composer')
  await expect(editor).toBeVisible()
  await editor.locator('textarea').fill('a guard here')
  await editor.locator('[data-act="composer-queue"]').click()
  await expect(editor).toHaveCount(0)

  // The draft is held like any other: hidden in the diff, listed in the review panel.
  const row = file.locator('tr.pending-row')
  await expect(row).toHaveCount(1)
  await expect(row).toBeHidden()
  await expect(page.locator('.pending-bar')).toContainText('1 pending comment')
  await page.locator('.pending-bar [data-act="show-review"]').click()
  const panel = page.locator('#review-panel')
  await expect(panel.locator('.review-draft .prose')).toContainText('a guard here')

  // Its link in the panel shows only the draft.
  await panel.locator('.review-draft a[data-item-link]').click()
  await expect(row).toBeVisible()
  await expect(file.locator('tr.ifind[data-point="p-1"]')).toBeHidden()
})
