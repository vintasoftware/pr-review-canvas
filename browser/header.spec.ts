import { expect, test } from './fixtures.js'

test('describes every header action and preserves tooltips after review progress changes', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  for (const button of await page.locator('.hdr button').all()) {
    await expect(button).toHaveAttribute('title', /\S.+/)
  }
  await page.locator('section.layer[data-layer="run-path"] [data-act="mark-layer"]').click()
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
