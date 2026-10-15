import { expect, test } from './fixtures.js'

test('keeps a dismissed point expanded when its save completes', async ({ page, reviewUrl }) => {
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
    const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
    await card.locator('[data-act="point-dismiss"]').click()
    // The page shows the dismissal before the server answers.
    await expect(card).toHaveAttribute('data-status', 'dismissed')
    const toggle = card.locator('[data-act="point-expand"]')
    await toggle.click()
    await expect(card.locator('.prose')).toBeVisible()

    releaseSave()
    await expect(page.locator('.toast')).toHaveText('attention point dismissed')
    await expect(card.locator('.prose')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveText('hide')
    await toggle.click()
    await expect(card.locator('.prose')).toBeHidden()
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
  // Both stay where they are, collapsed to the title and one line.
  for (const el of [card, inline]) {
    await expect(el).toHaveAttribute('data-status', 'dismissed')
    await expect(el.locator('.prose')).toBeHidden()
    await expect(el.locator('.p-summary')).toContainText('You dismissed this point')
  }
  await expect(page.locator('.toast')).toHaveText('attention point dismissed')
  await expect(page.locator('.toast')).toBeHidden({ timeout: 7000 })

  await page.reload()
  await expect(page.locator('.point-statuses')).toContainText('1 dismissed')
  await expect(card).toHaveAttribute('data-status', 'dismissed')
  await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
  await expect(inline).toHaveAttribute('data-status', 'dismissed')

  // The overview's switch takes the points acted on off the page, and brings them back.
  const hide = page.locator('[data-act="toggle-handled"]')
  await hide.click()
  await expect(card).toBeHidden()
  await expect(inline).toBeHidden()
  await hide.click()
  await expect(card).toBeVisible()

  await card.locator('[data-act="point-expand"]').click()
  await card.locator('[data-act="point-restore"]').click()
  await expect(card).toHaveAttribute('data-status', 'open')
  await expect(card.locator('.prose')).toBeVisible()
  await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
  await expect(inline.locator('.prose')).toBeVisible()
  await expect(page.locator('[data-act="toggle-handled"]')).toHaveCount(0)
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
  const fileTitle = file.locator(':scope > .file-h > .path')
  await fileTitle.click()
  await expect(fileBody).toBeHidden()
  await expect(fileToggle).toHaveAttribute('aria-expanded', 'false')
  await fileTitle.click()
  await expect(fileBody).toBeVisible()
  // Double and triple clicks select the name to copy it, and leave the card open.
  const onName = { position: { x: 4, y: 4 } }
  await fileTitle.dblclick(onName)
  expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe('')
  await expect(fileBody).toBeVisible()
  await fileTitle.click({ ...onName, clickCount: 3 })
  await expect(fileBody).toBeVisible()
  await expect(fileToggle).toHaveAttribute('aria-expanded', 'true')

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
