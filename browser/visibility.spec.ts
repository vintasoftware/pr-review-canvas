import { expect, openFiles, test } from './fixtures.js'

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
    const toggle = card.locator('.p-toggle')
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
  await openFiles(page)
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
  await openFiles(page)
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

  await card.locator('.p-toggle').click()
  await card.locator('[data-act="point-restore"]').click()
  await expect(card).toHaveAttribute('data-status', 'open')
  await expect(card.locator('.prose')).toBeVisible()
  await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
  await expect(inline.locator('.prose')).toBeVisible()
  await expect(page.locator('[data-act="toggle-handled"]')).toHaveCount(0)
})

test('opens and closes file and layer bodies', async ({ page, reviewUrl }) => {
  await page.goto(reviewUrl)
  const layer = page.locator('section.layer[data-layer="run-path"]')
  const file = layer.locator('article.file[data-path="src/app.ts"]')
  const fileBody = file.locator(':scope > .file-body')
  const fileToggle = file.locator(':scope > .file-h > .chev')
  // The first layer starts open, with every file closed under its name.
  await expect(layer.locator(':scope > .layer-body')).toBeVisible()
  await expect(fileBody).toBeHidden()
  await file.scrollIntoViewIfNeeded()
  await fileToggle.click()
  await expect(fileBody).toBeVisible()
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
  // At the end of this short page the browser's scroll anchoring would push the name up as the
  // card opens, so the reader would land on the end of the file; the name stays under the pointer.
  // Closing it there shrinks the page below the scroll, which the browser has to give back.
  await fileTitle.click()
  await expect(fileBody).toBeHidden()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const nameTop = () => fileTitle.evaluate(el => Math.round(el.getBoundingClientRect().top))
  const top = await nameTop()
  await fileTitle.click()
  await expect(fileBody).toBeVisible()
  expect(await nameTop()).toBe(top)
  // Double and triple clicks select the name to copy it, and leave the card as it was.
  await fileTitle.click()
  await expect(fileBody).toBeHidden()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const onName = { position: { x: 4, y: 4 } }
  await fileTitle.dblclick(onName)
  expect(await page.evaluate(() => window.getSelection()?.toString())).not.toBe('')
  await expect(fileBody).toBeHidden()
  await fileTitle.click({ ...onName, clickCount: 3 })
  await expect(fileBody).toBeHidden()
  await expect(fileToggle).toHaveAttribute('aria-expanded', 'false')
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await fileTitle.click()
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
      <span class="lv" hidden>inline flex</span>
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
    shown: ['grid', 'flex', 'inline-flex', 'grid', 'table-row'],
  })
})

test.describe('a first visit', () => {
  test.use({ pointsDensity: 'compact' })

  test('lists each point as one line, opens one from its title, and remembers show details', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    await openFiles(page)
    const card = page.locator('section.layer li.finding[data-fingerprint="fp-1"]')
    await expect(card.locator('.f-title .p-title')).toBeVisible()
    await expect(card.locator('.prose')).toBeHidden()
    await expect(card.locator('.tbtns')).toBeHidden()
    // The point stays whole on its line in the diff.
    await page.locator('#file-src_app_ts').scrollIntoViewIfNeeded()
    await expect(page.locator('tr.ifind[data-fingerprint="fp-1"] .prose')).toBeVisible()
    await card.locator('.p-title').click()
    await expect(card.locator('.prose')).toBeVisible()
    await expect(card.locator('[data-act="point-dismiss"]')).toBeVisible()
    await card.locator('.p-title').click()
    await expect(card.locator('.prose')).toBeHidden()
    // Selecting the title to copy it leaves the point as it was.
    await card.locator('.p-title').dblclick()
    await expect(card.locator('.prose')).toBeHidden()
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    // A point acted on keeps its one-line summary in the compact list.
    await card.locator('.p-title').click()
    await card.locator('[data-act="point-dismiss"]').click()
    await expect(card).toHaveAttribute('data-status', 'dismissed')
    await expect(card.locator('.p-summary')).toBeVisible()
    await expect(card.locator('.prose')).toBeHidden()
    await card.locator('.p-toggle').click()
    await card.locator('[data-act="point-restore"]').click()
    await expect(card).toHaveAttribute('data-status', 'open')
    await expect(card.locator('.prose')).toBeHidden()

    const density = page.locator('section.layer[data-layer="run-path"] [data-act="points-density"]')
    await expect(density).toHaveText('show details', { useInnerText: true })
    await density.click()
    await expect(card.locator('.prose')).toBeVisible()
    await expect(card.locator('.p-toggle')).toBeHidden()
    await expect(density).toHaveText('compact', { useInnerText: true })
    await page.reload()
    await expect(card.locator('.prose')).toBeVisible()
    await expect(density).toHaveText('compact', { useInnerText: true })
  })
})
