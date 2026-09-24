import { expect, test } from './fixtures.js'

test('the author settles a point with a reason, reads it after a reload, and reopens it', async ({
  page,
  selfReviewUrl,
}) => {
  await page.goto(selfReviewUrl)
  await expect(page.locator('.self-review-note')).toContainText('2 points are marked yours')
  const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  await expect(card.locator('.pill.audience')).toHaveText('reviewer')
  await card.locator('[data-act="point-settle"]').click()
  const box = card.locator('.settle-box')
  await expect(box.locator('textarea')).toBeFocused()
  await box.locator('textarea').fill('The spec says sum; see the linked issue.')
  await box.locator('[data-act="settle-save"]').click()
  await expect(card).toBeHidden()
  await expect(page.locator('.toast')).toContainText('canvas comment is updated')

  await page.reload()
  const settled = page.locator('.settled-list')
  await expect(settled.locator('.dismissed-line')).toContainText('1 settled by the author')
  await expect(card).toBeHidden()
  await settled.locator('[data-act="show-settled"]').click()
  await expect(settled.locator('.settled-reason')).toContainText('The spec says sum')
  await expect(settled.locator('a[href$="#discussion_r5001"]')).toHaveCount(1)
  await settled.locator('[data-act="point-unsettle"]').click()
  await expect(card).toBeVisible()
  await expect(card.locator('[data-act="point-settle"]')).toBeVisible()
  await expect(settled).toBeHidden()
})
