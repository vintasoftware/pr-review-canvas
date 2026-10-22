import { expect, test } from './fixtures.js'

test('shows one layer at a time once the setting is saved, on this page and after a reload', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const overview = page.locator('#overview')
  const layer = page.locator('#layer-run-path')
  const other = page.locator('#layer-other')
  await expect(overview).toBeVisible()
  await expect(layer).toBeVisible()

  // The save applies to the open page: the overview stays, the layers go.
  await page.locator('#settings').click()
  await page.locator('#set-layer-view').selectOption('one')
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
  await expect(overview).toBeVisible()
  await expect(layer).toBeHidden()
  await expect(other).toBeHidden()

  // The rail moves between layers, and marks the one that shows.
  await page.locator('nav.rail a[href="#layer-run-path"]').click()
  await expect(layer).toBeVisible()
  await expect(overview).toBeHidden()
  await expect(page.locator('nav.rail a[href="#layer-run-path"]')).toHaveAttribute('aria-current', 'location')
  await expect(page.locator('nav.rail a[href="#overview"]')).not.toHaveAttribute('aria-current', 'location')

  // The choice is in settings.yml, and the URL names the layer, so a reload opens on it alone.
  await page.reload()
  await expect(layer).toBeVisible()
  await expect(overview).toBeHidden()
  await expect(other).toBeHidden()

  // With nothing in focus, j starts from the layer on screen, though it is too short to scroll.
  await page.keyboard.press('j')
  await expect(other).toBeVisible()
  await expect(page).toHaveURL(/#layer-other$/)
  await expect(other.locator('details > .body')).toBeVisible()
  await page.reload()
  await expect(other.locator('details > .body')).toBeVisible()
  // A refresh keeps the layer the reader moved to.
  await page.locator('#refresh').click()
  await expect(page.locator('#refresh')).toBeEnabled()
  await expect(other).toBeVisible()
  await expect(layer).toBeHidden()

  // The keys move too: g o to the overview, j to the first layer, j again to Other.
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  await expect(overview).toBeVisible()
  await expect(layer).toBeHidden()
  await page.keyboard.press('j')
  await expect(layer).toBeVisible()
  await expect(overview).toBeHidden()
  await page.keyboard.press('j')
  await expect(other).toBeVisible()
  await expect(layer).toBeHidden()

  // After the rail moves away, j steps on from the layer that shows, not the card it left.
  await page.locator('nav.rail a[href="#overview"]').click()
  await expect(overview).toBeVisible()
  await page.keyboard.press('j')
  await expect(layer).toBeVisible()
  await expect(other).toBeHidden()

  // And k, from a reload onto the last layer.
  await page.locator('nav.rail a[href="#layer-other"]').click()
  await page.reload()
  await expect(other).toBeVisible()
  await page.keyboard.press('k')
  await expect(layer).toBeVisible()
  await expect(other).toBeHidden()

  await expect(page).toHaveURL(/#layer-run-path$/)
  await page.keyboard.press('k')
  await expect(overview).toBeVisible()
  await expect(page).toHaveURL(/#overview$/)
  await page.keyboard.press('j')
  await page.keyboard.press('Shift+r')
  await page.reload()
  await expect(layer.locator('.layer-body')).toBeVisible()

  // Back to all at once, and every section returns.
  await page.locator('#settings').click()
  await page.locator('#set-layer-view').selectOption('all')
  await page.locator('[data-act="settings-save"]').click()
  await expect(overview).toBeVisible()
  await expect(layer).toBeVisible()
  await expect(other).toBeVisible()
})

test('reads the canvas one attention point at a time once the setting is saved, on this page and after a reload', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const overview = page.locator('#overview')
  const layer = page.locator('#layer-run-path')
  const opening = page.locator('#step-layer-run-path')
  const first = page.locator('#step-p-1')
  await expect(overview).toBeVisible()
  await expect(layer).toBeVisible()

  // The save draws the page again, opening on the first layer's opening stop alone.
  await page.locator('#settings').click()
  await page.locator('#set-layer-view').selectOption('points')
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
  await expect(opening).toBeVisible()
  await expect(opening.locator('table.testmap')).toBeVisible()
  await expect(overview).toBeHidden()
  await expect(layer).toBeHidden()

  // The opening leads to the layer's points, each with only its chunk of code.
  await opening.locator('.step-nav a.step-on').click()
  await expect(first).toBeVisible()
  await expect(opening).toBeHidden()
  await expect(first.locator('table.diff')).toHaveCount(1)
  await expect(page).toHaveURL(/#step-p-1$/)

  // The rail lists the points under their layers; a stop takes the place of the one before, under a
  // page that stays at the top.
  await page.mouse.wheel(0, 600)
  await page.locator('nav.rail a[href="#step-p-2"]').click()
  await expect(page.locator('#step-p-2')).toBeVisible()
  await expect(first).toBeHidden()
  await expect(page.locator('nav.rail a[href="#step-p-2"]')).toHaveAttribute('aria-current', 'location')
  expect(await page.evaluate(() => window.scrollY)).toBe(0)

  // The URL names the stop, so a reload opens on it alone.
  await page.reload()
  await expect(page.locator('#step-p-2')).toBeVisible()
  await expect(first).toBeHidden()

  // After the last point come the layers, for the rest of the diff.
  await page.locator('#step-p-2 .step-nav a', { hasText: 'next point' }).click()
  await page.locator('#step-p-3 .step-nav a', { hasText: 'the rest of the diff' }).click()
  await expect(layer).toBeVisible()
  await expect(page.locator('#step-p-3')).toBeHidden()

  // The rail's switch goes back to the layers: every section returns, the stops are gone, and the
  // rail lists the layers in place of the points.
  await expect(page.locator('nav.rail a[href="#layer-run-path"]')).toHaveCount(0)
  await page.locator('nav.rail .rail-view [data-view="layers"]').click()
  await expect(overview).toBeVisible()
  await expect(layer).toBeVisible()
  await expect(page.locator('#layer-other')).toBeVisible()
  await expect(page.locator('section.point-step')).toHaveCount(0)
  await expect(page.locator('nav.rail a[href="#layer-run-path"]')).toBeVisible()
  await expect(page.locator('nav.rail .rail-points')).toHaveCount(0)

  // It is saved as the setting is, so a reload keeps the layers; the switch leads back to the points,
  // from anywhere down the page, under a page at its top.
  await page.reload()
  await expect(page.locator('nav.rail .rail-view [data-view="layers"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await page.mouse.wheel(0, 1500)
  await page.locator('nav.rail .rail-view [data-view="points"]').click()
  await expect(opening).toBeVisible()
  await expect(overview).toBeHidden()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test('the one-point view keeps back and forward between stops, and a line link lands in its layer', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  await page.locator('#settings').click()
  await page.locator('#set-layer-view').selectOption('points')
  await page.locator('[data-act="settings-save"]').click()
  await page.locator('#step-layer-run-path .step-nav a.step-on').click()
  await page.locator('#step-p-1 .step-nav a', { hasText: 'next layer' }).click()
  await page.goBack()
  await expect(page.locator('#step-p-1')).toBeVisible()
  await expect(page.locator('#step-layer-other')).toBeHidden()
  await page.goForward()
  await expect(page.locator('#step-layer-other')).toBeVisible()
  await page.goto(reviewUrl + '#line:src/app.ts:4')
  await expect(page.locator('#layer-run-path')).toBeVisible()
  // A point's stop draws the line again; the link lands in the layer.
  await expect(page.locator('pr-layer #L-src_app_ts-new-4')).toBeInViewport()
})

test('the rail’s switch goes back to the layers in the layer view the reader read them in', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  await page.locator('#settings').click()
  await page.locator('#set-layer-view').selectOption('one')
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
  await page.locator('nav.rail .rail-view [data-view="points"]').click()
  await expect(page.locator('#step-layer-run-path')).toBeVisible()
  await page.locator('nav.rail .rail-view [data-view="layers"]').click()
  // One section at a time again, not every layer at once.
  await expect(page.locator('section.point-step')).toHaveCount(0)
  await expect(page.locator('#overview')).toBeVisible()
  await expect(page.locator('#layer-run-path')).toBeHidden()
})
