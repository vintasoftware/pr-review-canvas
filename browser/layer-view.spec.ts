import type { Page } from '@playwright/test'
import { publishedSyntheticArtifact, syntheticArtifact } from '../src/testing/synthetic.js'
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

test.describe('the bar of one layer at a time', () => {
  test.use({ settings: { layerView: 'one' } })

  /**
   * Whether the bar over the section is at the top of the screen, or as near it as a page too short
   * to scroll that far allows. A layout can leave half a pixel.
   */
  const barAtTop = (page: Page) =>
    page.locator('#stop-nav').evaluate(bar => {
      const pageEnd = document.documentElement.scrollHeight - window.innerHeight
      return Math.abs(bar.getBoundingClientRect().top) < 1 || window.scrollY > pageEnd - 1
    })

  test('leads back and on from a layer, with its bar at the top of the screen, and back and forward', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl + '#overview')
    const nav = page.locator('#stop-nav')
    const run = page.locator('#layer-run-path')
    const other = page.locator('#layer-other')
    await expect(nav.locator('a')).toHaveText(['start with Layer 1: Run path →'])

    // The rail opens a layer with its bar at the top of the screen, so the layer starts under it.
    await page.locator('nav.rail a[href="#layer-run-path"]').click()
    await expect(run).toBeVisible()
    await expect(nav.locator('a')).toHaveText(['← overview', 'next layer: Other changes →'])
    await expect.poll(() => barAtTop(page)).toBe(true)

    // The bar under the layer leads on from its end, and the new layer opens under its bar.
    await page
      .locator('nav.step-nav[aria-label="Previous and next layer, at the end"] a', { hasText: 'next layer' })
      .click()
    await expect(page).toHaveURL(/#layer-other$/)
    await expect(other).toBeVisible()
    await expect(run).toBeHidden()
    await expect.poll(() => barAtTop(page)).toBe(true)
    await expect(nav.locator('a')).toHaveText([
      '← previous layer: Run path',
      'next open layer, Layer 1: Run path →',
    ])

    // Back and forward move between the layers the bar opened, each under its bar.
    await page.goBack()
    await expect(run).toBeVisible()
    await expect(page).toHaveURL(/#layer-run-path$/)
    await expect.poll(() => barAtTop(page)).toBe(true)
    await page.goForward()
    await expect(other).toBeVisible()

    // Once the other layers are reviewed, the last one says so in place of a way on.
    await nav.locator('a', { hasText: 'previous layer' }).click()
    await run.locator('[data-act="mark-layer"]').click()
    await expect(run).toHaveClass(/is-reviewed/)
    await page.keyboard.press('j')
    await expect(other).toBeVisible()
    await expect.poll(() => barAtTop(page)).toBe(true)
    await expect(nav.locator('.step-done')).toHaveText('all other layers are reviewed')
    await expect(nav.locator('a[data-way="on"]')).toHaveCount(0)
  })

  test('puts the bar at the top on a first visit to a layer shorter than the screen until its files draw', async ({
    page,
    reviewUrl,
  }) => {
    // Until its files draw, Run path ends above the bottom of this screen, so the first scroll
    // stops short of the bar.
    await page.setViewportSize({ width: 800, height: 1400 })
    await page.goto(reviewUrl + '#overview')
    await page.locator('#stop-nav a[data-way="on"]').click()
    await expect(page.locator('#layer-run-path')).toBeVisible()
    await expect.poll(() => barAtTop(page)).toBe(true)
  })

  test('g o opens the overview under its bar', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl + '#layer-other')
    await expect(page.locator('#layer-other')).toBeVisible()
    await page.mouse.wheel(0, 400)
    // mouse.wheel returns before the page scrolls. Wait for the scroll, so g o comes after it.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    await page.keyboard.press('g')
    await page.keyboard.press('o')
    await expect(page.locator('#overview')).toBeVisible()
    await expect(page).toHaveURL(/#overview$/)
    await expect.poll(() => barAtTop(page)).toBe(true)
  })

  test('Enter on a rail link moves the keyboard into the layer: Tab goes on inside it', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl + '#overview')
    await page.locator('nav.rail a[href="#layer-run-path"]').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#layer-run-path')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.locator('#layer-run-path :focus')).toHaveCount(1)
  })

  test('keeps the keyboard on the bar: Enter again moves on', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl + '#overview')
    const on = page.locator('#stop-nav a[data-way="on"]')
    await on.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#layer-run-path')).toBeVisible()
    await expect(on).toBeFocused()
    await expect(on).toHaveText('next layer: Other changes →')
    await page.keyboard.press('Enter')
    await expect(page.locator('#layer-other')).toBeVisible()
    await expect(on).toBeFocused()
  })

  test.describe('from all the layers at once', () => {
    test.use({ settings: { layerView: 'all' } })

    test('the settings switch to one at a time opens the section under its bar', async ({
      page,
      reviewUrl,
    }) => {
      await page.goto(reviewUrl)
      await page.locator('#settings').click()
      await page.locator('#set-layer-view').selectOption('one')
      await page.locator('[data-act="settings-save"]').click()
      await expect(page.locator('#overview')).toBeVisible()
      await expect(page.locator('#layer-run-path')).toBeHidden()
      await expect.poll(() => barAtTop(page)).toBe(true)
    })
  })

  test.describe('out of the attention points', () => {
    test.use({ settings: { layerView: 'one', readByPoints: true } })

    test('the bar and the rail’s switch open the layer under its bar, as a step does', async ({
      page,
      reviewUrl,
    }) => {
      const nav = page.locator('#stop-nav')
      await page.goto(reviewUrl + '#point-p-3')
      await page.locator('#stop-nav a[data-act="layer-view"]').click()
      await expect(nav).toHaveAttribute('aria-label', 'Previous and next layer')
      await expect.poll(() => barAtTop(page)).toBe(true)

      await page.locator('nav.rail [data-act="layer-view"][data-view="points"]').click()
      await expect(nav).toHaveAttribute('aria-label', 'Attention points')
      await page.locator('nav.rail [data-act="layer-view"][data-view="layers"]').click()
      await expect(nav).toHaveAttribute('aria-label', 'Previous and next layer')
      await expect.poll(() => barAtTop(page)).toBe(true)
    })
  })
})

test.describe('compact attention points saved in the settings', () => {
  test('draws the open page’s lists compact at once, and whole again', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl)
    const prose = page.locator('#point-p-1 .prose')
    await expect(prose).toBeVisible()
    const save = async (on: boolean) => {
      await page.locator('#settings').click()
      await page.locator('#set-compact-points').setChecked(on)
      await page.locator('[data-act="settings-save"]').click()
      await expect(page.locator('#settings-dialog')).toBeHidden()
    }
    await save(true)
    await expect(prose).toBeHidden()
    await expect(page.locator('#point-p-1 .p-toggle')).toBeVisible()
    await save(false)
    await expect(prose).toBeVisible()
    await expect(page.locator('.points-density').first()).toBeHidden()
  })
})

for (const layerView of ['all', 'one'] as const) {
  test.describe(`a missing test's link in the layers, compact, ${layerView === 'all' ? 'all at once' : 'one at a time'}`, () => {
    test.use({ settings: { compactPoints: true, readByPoints: false, layerView } })

    test('opens its open point whole, and leaves one acted on folded', async ({ page, chatServer }) => {
      // As publish writes it, the missing test's point is in its layer, so the Tests table links to it.
      const server = await chatServer({
        setup: async ({ ctx }) => {
          ctx.fixtureArtifact = publishedSyntheticArtifact()
        },
      })
      await page.goto(server.url + '#layer-run-path')
      const tests = page.locator('#layer-run-path details.test-map')
      const link = tests.getByRole('link', { name: 'See its attention point' })
      await tests.locator('summary').click()
      const href = (await link.getAttribute('href')) ?? ''
      const card = page.locator(`li.finding${href}`)
      await expect(card.locator('.prose')).toBeHidden()

      await link.click()
      await expect(page).toHaveURL(new RegExp(`${href}$`))
      await expect(card.locator('.prose')).toBeVisible()
      await expect(card.locator('.p-toggle')).toHaveAttribute('aria-expanded', 'true')
      await expect(card).toBeInViewport()

      // Dismissed, the point keeps its one line when the link is followed again.
      await card.locator('[data-act="point-dismiss"]').click()
      await expect(card).toHaveAttribute('data-status', 'dismissed')
      await expect(card.locator('.prose')).toBeHidden()
      await link.click()
      await expect(card.locator('.p-summary')).toBeVisible()
      await expect(card.locator('.prose')).toBeHidden()
    })
  })
}

/** The synthetic canvas with src/new-name.ts hidden whole at the light level. */
function withLevelHiddenFile() {
  const artifact = syntheticArtifact()
  return {
    ...artifact,
    layers: artifact.layers.map(layer => ({
      ...layer,
      files: layer.files.map(f => (f.path === 'src/new-name.ts' ? { ...f, collapsed: 'light' as const } : f)),
    })),
  }
}

for (const layerView of ['all', 'one'] as const) {
  test.describe(`the file after one marked reviewed, ${layerView === 'all' ? 'all at once' : 'one at a time'}`, () => {
    test.use({ settings: { layerView, foldLevel: 'light' } })

    test('takes the focus and stays closed when the reading level hides it', async ({ page, chatServer }) => {
      const server = await chatServer({
        setup: async ({ ctx }) => {
          ctx.fixtureArtifact = withLevelHiddenFile()
        },
      })
      await page.goto(server.url + '#layer-run-path')
      const app = page.locator('#file-src_app_ts')
      const next = page.locator('#file-src_new_name_ts')
      await expect(app.locator('.file-body')).toBeVisible()
      await expect(next.locator('.file-body')).toBeHidden()

      await app.locator('input[data-reviewed-id]').check()
      await expect(app.locator('.file-body')).toBeHidden()
      await expect(next).toHaveClass(/\bis-focused\b/)
      await expect(next.locator('.file-h')).toBeInViewport()
      await expect(next.locator('.file-body')).toBeHidden()
      await expect(page.locator('#layer-run-path')).toBeVisible()
    })
  })
}

test.describe('reading by attention points with compact points', () => {
  test.use({ settings: { readByPoints: true, compactPoints: true } })

  test('a point’s stop shows its open point whole', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl + '#point-p-1')
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'point')
    await expect(page.locator('#point-p-1 .prose')).toBeVisible()
  })
})

// From here on a review reads by attention points, as `readByPoints` turns on in the settings.
test.describe('reading by attention points', () => {
  test.use({ settings: { readByPoints: true } })

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
    // Back on the point's stop, which the rail marks.
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'point')
    await expect(page.locator('nav.rail a[aria-current]')).toHaveAttribute('href', '#point-p-1')
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

  test('r marks the file of the point in focus in its stop', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl + '#point-p-1')
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'point')
    await page.keyboard.press(']')
    await expect(page.locator('#point-p-1')).toHaveClass(/is-focused/)
    await page.keyboard.press('r')
    await expect(page.locator('.toast')).toHaveText('file marked reviewed')
    await expect(
      page.locator('#layer-run-path article.file[data-path="src/app.ts"] .file-h input[type="checkbox"]')
    ).toBeChecked()
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
    await expect(page.locator('.toast')).toHaveText('no stop shows this, so it opens in the layers')
  })

  test('back to a stop while the layers show goes to its layer there, from the top the stop left', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl + '#point-p-1')
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'point')
    await page.keyboard.press('n')
    await expect(page).toHaveURL(/#layer-other$/)
    await page.keyboard.press('n')
    await expect(page).toHaveURL(/#point-p-2$/)
    await page.locator('nav.rail .rail-view [data-view="layers"]').click()
    await expect(page.locator('[data-lens]')).toHaveCount(0)
    await page.goBack()
    await expect(page).toHaveURL(/#layer-other$/)
    await expect(page.locator('#layer-other')).toBeInViewport()
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

  test('a point’s stop keeps its file open with no chevron, and a handled point’s line still opens', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl + '#point-p-1')
    const layer = page.locator('#layer-run-path')
    await expect(layer).toHaveAttribute('data-lens', 'point')
    await expect(layer.locator('article.file > .file-h > .chev').first()).toBeHidden()
    await page.locator('#point-p-1 [data-act="point-dismiss"]').click()
    await expect(page.locator('.toast')).toHaveText('attention point dismissed')
    const row = layer.locator('tr.ifind[data-fingerprint="fp-1"]')
    await expect(row.locator('.prose')).toBeHidden()
    await row.locator('[data-act="point-expand"]').click()
    await expect(row.locator('.prose')).toBeVisible()
  })

  test('on a phone the rail keeps the layers’ stops, and a stop fits the screen', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile')
    await page.goto(reviewUrl)
    await expect(page.locator('#layer-run-path')).toHaveAttribute('data-lens', 'layer')
    await expect(page.locator('nav.rail .pt-layer a[href="#layer-run-path"]')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(0)
    // Every chip starts its first part at one inset, and all of them, the switch too, share a middle.
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll('nav.rail .tree a, nav.rail .rail-view')]
        .filter(el => el.getClientRects().length > 0)
        .map(el => {
          const box = el.getBoundingClientRect()
          const first = [...el.children].find(child => child.getClientRects().length > 0)
          return {
            link: el.matches('a'),
            inset: Math.round((first?.getBoundingClientRect().left ?? box.left) - box.left),
            middle: Math.round(box.top + box.height / 2),
          }
        })
    )
    expect(new Set(chips.filter(chip => chip.link).map(chip => chip.inset)).size).toBe(1)
    expect(new Set(chips.map(chip => chip.middle)).size).toBe(1)
    // The strip follows the stop: the last point's chip comes into view, cut to fit.
    await page.locator('#stop-nav a', { hasText: 'go to its 1 attention point' }).click()
    for (const key of ['n', 'n', 'n']) await page.keyboard.press(key)
    await expect(page).toHaveURL(/#point-p-3$/)
    const chip = page.locator('nav.rail a[href="#point-p-3"]')
    await expect(chip).toHaveAttribute('aria-current', 'location')
    const inStrip = await chip.evaluate(el => {
      const strip = el.closest('.tree')?.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      return strip !== undefined && box.left >= strip.left && box.right <= strip.right
    })
    expect(inStrip).toBe(true)
  })

  test('the settings turn reading by attention points off and on, on the open page', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    const readByPoints = page.locator('#set-read-by-points')
    // Turned off from the layers, where the view on screen stays: the switch still goes.
    await page.locator('nav.rail .rail-view [data-view="layers"]').click()
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
    // The URL names the stop that opened, so a reload or a copied link opens on it.
    const lensed = await page.locator('[data-lens]').getAttribute('id')
    await expect(page).toHaveURL(new RegExp(`#${lensed}$`))
  })

  test('the rail’s switch keeps the keyboard on the button it pressed', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl)
    await page.locator('nav.rail .rail-view [data-view="layers"]').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('nav.rail .rail-view [data-view="layers"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.locator('nav.rail .rail-view [data-view="layers"]')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Enter')
    await expect(page.locator('nav.rail .rail-view [data-view="points"]')).toBeFocused()
  })

  test('the step keys leave the page at its top, and a layer’s stop gives its tests back closed', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    const tests = page.locator('#layer-run-path details.test-map')
    await expect(tests).toHaveAttribute('open', '')
    for (const key of ['n', 'n', ']']) {
      await page.keyboard.press(key)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    }
    await expect(page).toHaveURL(/#point-p-2$/)
    await page.locator('nav.rail .rail-view [data-view="layers"]').click()
    await expect(tests).not.toHaveAttribute('open', '')
  })
})
