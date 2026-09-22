import { expect, test } from './fixtures.js'

test('describes every header action and preserves tooltips after review progress changes', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  for (const button of await page.locator('.hdr button').all()) {
    await expect(button).toHaveAttribute('title', /\S.+/)
  }
  await page.locator('section.layer[data-layer="layer-1"] [data-act="mark-layer"]').click()
  await expect(page.locator('#approve')).toBeEnabled()
  await expect(page.locator('#approve')).toHaveAttribute(
    'title',
    'Write and preview an approving review on GitHub'
  )
  await expect(page.locator('#request-changes')).toHaveAttribute(
    'title',
    'Write and preview a review requesting changes on GitHub'
  )
})

test('switches how much code is hidden from the control and from the keyboard', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const select = page.locator('#fold-level')
  const hint = page.locator('.reading .fold-hint')

  // Every reader opens the canvas at light; the choice is page state and is never saved.
  await expect(select).toHaveValue('light')
  await expect(hint).toContainText('imports, whitespace, moved blocks, and generated files')

  await select.selectOption('moderate')
  await expect(page.locator('.toast')).toHaveText('hiding code: moderate')
  await expect(hint).toContainText('also test bodies, helpers, wiring, templates')

  await page.locator('body').press('f')
  await expect(select).toHaveValue('aggressive')
  await expect(hint).toContainText('only the code you have to judge')
  await page.locator('body').press('f')
  await expect(select).toHaveValue('light')

  await page.reload()
  await expect(page.locator('#fold-level')).toHaveValue('light')
})
