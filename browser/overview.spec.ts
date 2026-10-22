import { expect, test } from './fixtures.js'

test('toggles details when clicking directly on the chevron', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const details = page.locator('#overview details').first()
  const summary = details.locator(':scope > summary')
  const chevron = summary.locator('.chev')
  await expect(details).not.toHaveAttribute('open')
  await chevron.click()
  await expect(details).toHaveAttribute('open')
  await chevron.click()
  await expect(details).not.toHaveAttribute('open')
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(details).toHaveAttribute('open')
  await page.keyboard.press('Space')
  await expect(details).not.toHaveAttribute('open')
})

test('aligns the overview with the layers in both skins', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  for (let skin = 0; skin < 2; skin++) {
    const overview = await page.locator('#overview').boundingBox()
    const layer = await page.locator('section.layer').first().boundingBox()
    if (!overview || !layer) throw new Error('missing overview or layer')
    expect(Math.abs(overview.x - layer.x)).toBeLessThan(1)
    expect(Math.abs(overview.width - layer.width)).toBeLessThan(1)
    await page.locator('#skin-toggle').click()
  }
})

test('lets the summary and its diagram fill the overview panel', async ({ page, reviewUrl }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.goto(reviewUrl)
  const body = await page.locator('#overview > .body').first().boundingBox()
  const summary = await page.locator('#overview .summary').boundingBox()
  if (!body || !summary) throw new Error('missing overview body or summary')
  const padding = await page
    .locator('#overview > .body')
    .first()
    .evaluate(element => Number.parseFloat(getComputedStyle(element).paddingLeft) * 2)
  expect(Math.abs(summary.width - (body.width - padding))).toBeLessThan(2)
})
