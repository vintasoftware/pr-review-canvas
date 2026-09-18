import { expect, test } from './fixtures.js'

test('keeps the dismissed list open when a pending save completes', async ({ page, reviewUrl }) => {
  let releaseSave = () => {}
  const saveReleased = new Promise<void>(resolve => {
    releaseSave = resolve
  })
  await page.route('**/points/fp-1/dismissed', async route => {
    await saveReleased
    await route.continue()
  })
  try {
    await page.goto(reviewUrl)
    await page.locator('section.layer li.finding[data-fingerprint="fp-1"] [data-act="point-dismiss"]').click()
    const dismissed = page.locator('.dismissed-list')
    const toggle = dismissed.locator('[data-act="show-dismissed"]')
    await toggle.click()
    await expect(dismissed.locator('li.finding')).toBeVisible()

    releaseSave()
    await expect(page.locator('.toast')).toHaveText('attention point dismissed')
    await expect(dismissed.locator('li.finding')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveText('hide')
    await toggle.click()
    await expect(dismissed.locator('li.finding')).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  } finally {
    releaseSave()
  }
})

test('dismisses a point everywhere, keeps it dismissed after reload, and restores it', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
  const inline = page.locator('tr.ifind[data-fingerprint="fp-1"]')
  await expect(card).toBeVisible()
  await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
  await expect(inline).toBeVisible()
  await card.locator('[data-act="point-dismiss"]').click()
  await expect(card).toBeHidden()
  await expect(inline).toBeHidden()
  await expect(page.locator('.toast')).toHaveText('attention point dismissed')
  await expect(page.locator('.toast')).toBeHidden({ timeout: 7000 })

  await page.reload()
  await expect(page.locator('.dismissed-line')).toContainText('1 dismissed')
  await expect(card).toBeHidden()
  await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
  await expect(inline).toHaveCount(1)
  await expect(inline).toBeHidden()
  const dismissed = page.locator('.dismissed-list')
  await dismissed.locator('[data-act="show-dismissed"]').click()
  await expect(dismissed.locator('li.finding')).toBeVisible()
  await dismissed.locator('[data-act="point-restore"]').click()
  await expect(card).toBeVisible()
  await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
  await expect(inline).toBeVisible()
  await expect(dismissed).toBeHidden()
})

test('collapses and reopens file and layer bodies', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const layer = page.locator('section.layer[data-layer="run-path"]')
  const file = layer.locator('article.file[data-path="src/app.ts"]')
  const fileBody = file.locator(':scope > .file-body')
  const fileToggle = file.locator(':scope > .file-h > .chev')
  await expect(fileBody).toBeVisible()
  await file.scrollIntoViewIfNeeded()
  await expect(file.locator('tr.ifind[data-fingerprint="fp-1"]')).toBeVisible()
  await fileToggle.click()
  await expect(fileBody).toBeHidden()
  await fileToggle.click()
  await expect(fileBody).toBeVisible()

  const layerBody = layer.locator(':scope > .layer-body')
  const layerToggle = layer.locator(':scope > .layer-h > .chev')
  await layerToggle.click()
  await expect(layerBody).toBeHidden()
  await layerToggle.click()
  await expect(layerBody).toBeVisible()
  await expect(fileBody).toBeVisible()
})

test('hidden takes priority over component display rules', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  await expect(page.locator('section.layer').first()).toBeVisible()
  const displays = await page.evaluate(() => {
    const host = document.createElement('div')
    host.innerHTML = `
      <div class="layout" hidden>grid</div>
      <div class="layer-ctl" hidden>flex</div>
      <span class="sq" hidden>inline block</span>
      <ol class="findings"><li hidden>finding</li></ol>
      <table><tbody><tr class="noise shown" hidden><td>row</td></tr></tbody></table>`
    document.body.appendChild(host)
    const samples = [...host.querySelectorAll('[hidden]')]
    const hidden = samples.map(el => getComputedStyle(el).display)
    for (const el of samples) {
      el.removeAttribute('hidden')
    }
    const shown = samples.map(el => getComputedStyle(el).display)
    host.remove()
    return { hidden, shown }
  })
  expect(displays).toEqual({
    hidden: ['none', 'none', 'none', 'none', 'none'],
    shown: ['grid', 'flex', 'inline-block', 'grid', 'table-row'],
  })
})
