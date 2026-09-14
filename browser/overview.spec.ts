import { expect, test } from './fixtures.js'

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
