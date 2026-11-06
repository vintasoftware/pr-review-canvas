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

// From here on a review reads by attention points, as `readByPoints` turns on in the settings.
test.describe('reading by attention points', () => {
  test.use({ readByPoints: true })

  test('reads the canvas one attention point at a time, on this page and after a reload', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    const layer = page.locator('#layer-run-path')
    const nav = page.locator('#stop-nav')

    // The page opens on the first layer's stop: its heading, description and tests, no files.
    await expect(layer).toHaveAttribute('data-lens', 'layer')
    await expect(layer.locator('table.testmap')).toBeVisible()
    await expect(layer.locator('article.file').first()).toBeHidden()
    await expect(page.locator('#overview')).toBeHidden()
    await expect(page.locator('#layer-other')).toBeHidden()

    // On to its point: the point's card and the one chunk that holds it, in the layer's own cards.
    await nav.locator('a', { hasText: 'go to its 1 attention point' }).click()
    await expect(page).toHaveURL(/#point-p-1$/)
    await expect(layer).toHaveAttribute('data-lens', 'point')
    await expect(page.locator('#point-p-1')).toBeVisible()
    await expect(layer.locator('table.testmap')).toBeHidden()
    await expect(layer.locator('table.diff:visible')).toHaveCount(1)
    await expect(layer.locator('tr.ifind[data-fingerprint="fp-1"]')).toBeVisible()
    await expect(nav.locator('.step-n')).toHaveText('Point 1 of 3')

    // The rail lists the stops; one takes the place of the one before, under a page at its top.
    await page.mouse.wheel(0, 600)
    await page.locator('nav.rail a[href="#point-p-2"]').click()
    await expect(page.locator('#layer-other')).toHaveAttribute('data-lens', 'point')
    await expect(layer).toBeHidden()
    await expect(page.locator('nav.rail a[href="#point-p-2"]')).toHaveAttribute('aria-current', 'location')
    expect(await page.evaluate(() => window.scrollY)).toBe(0)

    // Back and forward move between stops; the URL names the stop, so a reload opens on it.
    await page.goBack()
    await expect(layer).toHaveAttribute('data-lens', 'point')
    await page.goForward()
    await page.reload()
    await expect(page.locator('#layer-other')).toHaveAttribute('data-lens', 'point')
    await expect(page.locator('tr.ifind[data-fingerprint="fp-2"]')).toBeVisible()

    // After the last point come the layers, on this page only.
    await nav.locator('a', { hasText: 'next point' }).click()
    await nav.locator('a', { hasText: 'the rest of the diff' }).click()
    await expect(page.locator('[data-lens]')).toHaveCount(0)
    await expect(page.locator('#overview')).toBeVisible()
    await expect(layer.locator('article.file').first()).toBeVisible()
    await expect(page.locator('nav.rail .rail-view [data-view="layers"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await page.reload()
    await expect(layer).toHaveAttribute('data-lens', 'layer')
  })

  test('the rail’s switch keeps the reader’s place, in the layer view the settings choose', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl + '#point-p-1')
    await page.locator('nav.rail .rail-view [data-view="layers"]').click()
    // All the layers at once, on the point's card.
    await expect(page.locator('#layer-other')).toBeVisible()
    await expect(page.locator('#point-p-1')).toBeInViewport()
    await page.locator('nav.rail .rail-view [data-view="points"]').click()
    await page.locator('#settings').click()
    await page.locator('#set-layer-view').selectOption('one')
    await page.locator('[data-act="settings-save"]').click()
    await expect(page.locator('#settings-dialog')).toBeHidden()
    // Show layers is about the layers: the page stays on its attention points.
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', /./)
    await page.locator('nav.rail .rail-view [data-view="layers"]').click()
    await expect(page.locator('#layer-run-path')).toBeVisible()
    await expect(page.locator('#layer-other')).toBeHidden()
    await expect(page.locator('#overview')).toBeHidden()
  })

  test('the step keys walk the stops: n and p every one, j and k the layers’ openings, ] and [ the open points', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'layer')
    const lands = async (key: string, id: string) => {
      await page.keyboard.press(key)
      await expect(page).toHaveURL(new RegExp(`#${id}$`))
      await expect(page.locator('[data-lens]')).toHaveCount(1)
    }
    await lands('n', 'point-p-1')
    await lands('j', 'layer-other')
    await lands(']', 'point-p-2')
    await lands('k', 'layer-other')
    await lands('k', 'layer-run-path')
    await lands(']', 'point-p-1')
    await lands('p', 'layer-run-path')
    // A point reached by the rail takes the focus with ] first, so the point keys act on it.
    await page.locator('nav.rail a[href="#point-p-2"]').click()
    await lands(']', 'point-p-2')
    await expect(page.locator('tr.ifind[data-fingerprint="fp-2"]')).toHaveClass(/is-focused/)
    // A dismissed point leaves the walk.
    await page.keyboard.press('d')
    await lands(']', 'point-p-3')
    await lands('[', 'point-p-1')
  })

  test('a target no stop shows takes the page to its layers', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl + '#point-p-1')
    await page.locator('#point-p-1').waitFor()
    // A file of the layer with no point on it.
    await page.evaluate(() => {
      window.location.hash = '#file:src/new-name.ts'
    })
    await expect(page.locator('[data-lens]')).toHaveCount(0)
    await expect(page.locator('nav.rail .rail-view [data-view="layers"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.locator('article.file[data-path="src/new-name.ts"]')).toBeInViewport()
  })

  test('a stop keeps its code in sight when its file is marked reviewed', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl + '#point-p-1')
    const file = page.locator('#layer-run-path article.file[data-path="src/app.ts"]')
    await file.locator('.file-h input[type="checkbox"]').check()
    await expect(page.locator('.toast')).toHaveText('file marked reviewed')
    await expect(file.locator('table.diff')).toBeVisible()
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'point')
  })

  test('a stop keeps its layer open, with no chevron to fold it', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl)
    const layer = page.locator('#layer-run-path')
    await expect(layer).toHaveAttribute('data-lens', 'layer')
    await expect(layer.locator(':scope > .layer-h > .chev')).toBeHidden()
    // A fold from a key or a script leaves the stop as it was.
    await layer.evaluate(section => section.querySelector(':scope > .layer-body')?.setAttribute('hidden', ''))
    await expect(layer.locator('table.testmap')).toBeVisible()
    await page.locator('nav.rail a[href="#point-p-2"]').click()
    const other = page.locator('#layer-other')
    await expect(other).toHaveAttribute('data-lens', 'point')
    await expect(other.locator('summary .chev')).toBeHidden()
    await other.evaluate(section => {
      const details = section.querySelector(':scope > details')
      if (details instanceof HTMLDetailsElement) details.open = false
    })
    await expect(other.locator('tr.ifind[data-fingerprint="fp-2"]')).toBeVisible()
  })

  test('a point’s stop spaces its card from the layer heading and from its file', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl + '#point-p-1')
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'point')
    const gaps = await page.evaluate(() => {
      const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? 0
      const bottom = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0
      return [
        top('#point-p-1') - bottom('#layer-run-path > .layer-h'),
        top('#layer-run-path article.file[data-path="src/app.ts"]') - bottom('#point-p-1'),
      ]
    })
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(8)
  })

  test('the settings turn reading by attention points off and on, on the open page', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    const readByPoints = page.locator('#set-read-by-points')
    await page.locator('#settings').click()
    await readByPoints.uncheck()
    await page.locator('[data-act="settings-save"]').click()
    // Off, the page reads the layers alone, with no switch.
    await expect(page.locator('[data-lens]')).toHaveCount(0)
    await expect(page.locator('#layer-other')).toBeVisible()
    await expect(page.locator('nav.rail .rail-view')).toHaveCount(0)
    await page.reload()
    await expect(page.locator('nav.rail .rail-view')).toHaveCount(0)
    // On again, the page opens its attention points at once.
    await page.locator('#settings').click()
    await readByPoints.check()
    await page.locator('[data-act="settings-save"]').click()
    await expect(page.locator('[data-lens]')).toHaveCount(1)
    await expect(page.locator('nav.rail .rail-view [data-view="points"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})
