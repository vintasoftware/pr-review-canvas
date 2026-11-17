import { syntheticArtifact } from '../src/testing/synthetic.js'
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

test('stops the summary at 100 characters, short of a wide panel', async ({ page, reviewUrl }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.goto(reviewUrl)
  const body = await page.locator('#overview > .body').first().boundingBox()
  const summary = await page.locator('#overview .summary').boundingBox()
  if (!body || !summary) throw new Error('missing overview body or summary')
  expect(await page.locator('#overview .summary').evaluate(el => getComputedStyle(el).maxWidth)).not.toBe(
    'none'
  )
  expect(summary.width).toBeLessThan(body.width - 100)
})

test.describe('with fullWidthText', () => {
  test.use({ settings: { fullWidthText: true } })

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
})

for (const [view, settings] of [
  ['all layers', { layerView: 'all' }],
  ['one layer', { layerView: 'one' }],
  ['attention points', { readByPoints: true }],
] as const) {
  test(`opens Background on request and follows its code link when reading by ${view}`, async ({
    page,
    chatServer,
  }) => {
    const server = await chatServer({
      setup: async ({ ctx }) => {
        await ctx.settings.write(settings)
        ctx.fixtureArtifact = {
          ...syntheticArtifact(),
          background: [
            {
              topic: 'Retry policies',
              kind: 'concept',
              explanation:
                'Read [the later hunk](#hunk:src/app.ts#2). See [docs](https://example.com/retry).',
            },
          ],
        }
      },
    })
    await page.goto(server.url + '#overview')
    const background = page.locator('#overview details.background')
    await expect(background).toBeVisible()
    await expect(background).not.toHaveAttribute('open')
    const toggle = background.locator(':scope > summary')
    await expect(toggle).toContainText('Background · 1 topic')
    await toggle.click()
    await expect(background.getByText('Retry policies')).toBeVisible()
    await expect(background.getByRole('link', { name: 'docs' })).toHaveAttribute('rel', 'noopener noreferrer')
    await background.getByRole('link', { name: 'the later hunk' }).click()
    await expect(page.locator('#hunk-src_app_ts-2')).toBeInViewport()
  })
}
