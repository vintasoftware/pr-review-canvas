import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

/** Waits for the board to finish gliding to what was opened. */
async function settled(page: Page) {
  await expect(page.locator('#main')).not.toHaveClass(/\bis-moving\b/)
}

/** Saves the layer view in the settings dialog. */
async function showLayers(page: Page, view: 'all' | 'board') {
  await page.locator('#settings').click()
  await page.locator('#set-layer-view').selectOption(view)
  await page.locator('[data-act="settings-save"]').click()
  await expect(page.locator('#settings-dialog')).toBeHidden()
}

/**
 * Where a node is from the root node, which stays put while the room around the tree changes, in
 * plane pixels.
 */
async function fromRoot(page: Page, id: string) {
  return page.evaluate(nodeId => {
    const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect()
    const node = box(`.bnode[data-node="${nodeId}"]`)
    const root = box('.bnode[data-node="root"]')
    // In plane pixels: the board may open at another zoom.
    const plane = document.querySelector('.board-plane')
    const zoom = plane instanceof HTMLElement ? Number(plane.style.zoom || 1) : 1
    return node && root
      ? { x: Math.round((node.left - root.left) / zoom), y: Math.round((node.top - root.top) / zoom) }
      : null
  }, id)
}

/**
 * Two places within a few pixels: CSS zoom rounds line heights a little differently at each zoom,
 * and the board can open at another zoom after a reload.
 */
function expectNear(got: { x: number; y: number } | null, want: { x: number; y: number } | null) {
  expect(Math.abs((got?.x ?? 0) - (want?.x ?? 0))).toBeLessThanOrEqual(4)
  expect(Math.abs((got?.y ?? 0) - (want?.y ?? 0))).toBeLessThanOrEqual(4)
}

test('shows the review as a tree with the pull request at its root, clean of the rail and the side pane', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  await showLayers(page, 'board')

  // No rail and no docked pane: the pane floats behind its launcher.
  await expect(page.locator('nav.rail')).toBeHidden()
  await expect(page.locator('#chat-launcher')).toBeVisible()
  await expect(page.locator('.layout > aside.chat')).toHaveCount(0)

  // The header's title block is the root; the layers hang under it, their points under them.
  // Files have no nodes: the reader reviews the points.
  const rootNode = page.locator('.bnode[data-node="root"]')
  await expect(rootNode.locator('.hdr-title h1')).toBeVisible()
  await expect(page.locator('header .hdr-title')).toHaveCount(0)
  // The board shows no diff but in the side panel: the Hide code control is not on it.
  await expect(rootNode.locator('.reading')).toBeHidden()
  const layers = page.locator('.bnode.b-layer')
  await expect(layers).toHaveCount(await page.locator('pr-layer > section').count())
  await expect(page.locator('.board-lines .b-trunk')).toHaveCount(await layers.count())
  await expect(page.locator('.bnode.b-file')).toHaveCount(0)
  await expect(layers.first().locator('.b-progress')).toHaveText(/points$/)
  // A closed layer keeps its points off the board.
  await expect(page.locator('.bnode.b-point').first()).toBeHidden()
  await expect(page.locator('.board-lines .b-edge:not(.b-trunk)')).toHaveCount(0)
  const rootBox = await rootNode.boundingBox()
  const layerBox = await layers.first().boundingBox()
  expect(layerBox?.y).toBeGreaterThan((rootBox?.y ?? 0) + (rootBox?.height ?? 0))

  // Every node starts closed, and the page itself does not scroll.
  await expect(page.locator('.bnode .file-body').first()).toBeHidden()
  const pageScrolls = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 1
  )
  expect(pageScrolls).toBe(false)

  // Opened, a layer shows its points, and comes into view at full size.
  await page.locator('[data-board="fit"]').click()
  await layers.first().locator('.layer-h h2').click()
  await settled(page)
  await expect(page.locator('.board-zoom')).toHaveText('100%')
  await expect(layers.first().locator('.layer-h h2')).toBeInViewport()
  const point = page.locator('.bnode.b-point:visible').first()
  await expect(point).toBeVisible()
  await expect(page.locator('.board-lines .b-edge:not(.b-trunk)').first()).toBeAttached()
  // A point opens to its text and its commands, and its file opens in the side panel at its line,
  // beside the point.
  await point.locator('.p-title').click()
  await expect(point.locator('[data-act="point-dismiss"]')).toBeVisible()
  const panel = page.locator('.b-filepanel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('article.file .diff-host table.diff').first()).toBeVisible()
  await settled(page)
  const pointBox = await point.boundingBox()
  const panelBox = await panel.boundingBox()
  expect((pointBox?.x ?? 0) + (pointBox?.width ?? 0)).toBeLessThanOrEqual(panelBox?.x ?? 0)
  // The open point is in focus: the rest of the board fades behind it, until Escape.
  await expect(page.locator('#main')).toHaveClass(/\bhas-focus\b/)
  await expect(layers.first()).toHaveCSS('opacity', '0.1')
  await expect(point).toHaveCSS('opacity', '1')
  // Escape ends the focus and puts the file away.
  await page.keyboard.press('Escape')
  await expect(layers.first()).toHaveCSS('opacity', '1')
  await expect(panel).toBeHidden()
  // The point shows no link to its line: opened again, it opens its file again, and close puts
  // the file away.
  await expect(point.locator('.f-title .loc')).toBeHidden()
  await point.locator('.p-title').click()
  await point.locator('.p-title').click()
  await expect(page.locator('#main')).toHaveClass(/\bhas-focus\b/)
  await expect(panel).toBeVisible()
  await panel.locator('[data-board="close-file"]').click()
  await expect(panel).toBeHidden()
})

test('takes the reader from each point they dismiss to the next, until the layer is done', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  await showLayers(page, 'board')
  const layer = page
    .locator('.bnode.b-layer')
    .filter({ has: page.locator('.b-progress', { hasText: /^0\/\d+ points$/ }) })
    .first()
  await layer.locator('.layer-h h2').click()
  await settled(page)
  const id = (await layer.getAttribute('data-node')) ?? ''
  const total = Number(((await layer.locator('.b-progress').textContent()) ?? '').match(/\/(\d+)/)?.[1])
  const reviewed = page.locator('.bnode[data-node="root"] .ptext')
  const layersBefore = Number(((await reviewed.textContent()) ?? '').match(/^(\d+)/)?.[1])
  // The reader opens the first point; after that the board opens each next one.
  await page.locator('.bnode.b-point:visible').first().locator('.p-title').click()
  for (let done = 1; done <= total; done++) {
    const focused = page.locator('.bnode.b-point.is-focus')
    await expect(focused).toHaveCount(1)
    const before = await focused.getAttribute('data-node')
    await focused.locator('[data-act="point-dismiss"]').click()
    await expect(page.locator(`.bnode[data-node="${id}"] .b-progress`)).toHaveText(`${done}/${total} points`)
    // The dismissed point closes, and the focus moves on to another point, or to none at the end.
    await expect(page.locator(`.bnode[data-node="${before}"]`)).not.toHaveClass(/\bis-focus\b/)
  }
  await expect(page.locator(`.bnode[data-node="${id}"]`)).toHaveClass(/\bis-done\b/)
  // With its points done, the layer counts as reviewed on the root, though the board has no box.
  await expect(reviewed).toHaveText(new RegExp(`^${layersBefore + 1} of \\d+ layers reviewed`))

  // A dismissed point opened again shows its title and one line until show; its file opens.
  // Marked reviewed, the layer folds; the reader opens it again.
  const done = page.locator(`.bnode[data-node="${id}"]`)
  await expect(done.locator('section > .layer-body')).toBeHidden()
  await done.locator('.layer-h h2').click()
  await settled(page)
  const dismissed = page
    .locator('.bnode.b-point:visible')
    .filter({ has: page.locator('[data-status="dismissed"]') })
    .first()
  await dismissed.locator('.p-title').click()
  await expect(dismissed.locator('.prose')).toBeHidden()
  await expect(page.locator('.b-filepanel')).toBeVisible()
  await dismissed.locator('[data-act="point-expand"]').click()
  await expect(dismissed.locator('.prose')).toBeVisible()
})

test('drags a layer with what hangs from it, keeps it there after a reload, and tidies it back', async ({
  page,
  reviewUrl,
}) => {
  await page.goto(reviewUrl)
  await showLayers(page, 'board')
  const layer = page.locator('.bnode.b-layer').first()
  const id = (await layer.getAttribute('data-node')) ?? ''
  // Open, so its points are on the board to move with it.
  await layer.locator('.layer-h h2').click()
  await settled(page)
  const leaf = layer.locator('xpath=following-sibling::div[contains(@class,"bnode")][1]')
  const leafId = (await leaf.getAttribute('data-node')) ?? ''
  const before = await fromRoot(page, id)
  const leafBefore = await fromRoot(page, leafId)

  const handle = layer.locator('.layer-h h2')
  const box = await handle.boundingBox()
  if (box === null) throw new Error('no layer title')
  await page.mouse.move(box.x + 8, box.y + 8)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 48, { steps: 4 })
  await page.mouse.up()
  const after = await fromRoot(page, id)
  expect(after?.x).toBeGreaterThan((before?.x ?? 0) + 20)
  expect(after?.y).toBeGreaterThan((before?.y ?? 0) + 20)
  // Its first leaf moved with it.
  const leafAfter = await fromRoot(page, leafId)
  expect((leafAfter?.x ?? 0) - (leafBefore?.x ?? 0)).toBe((after?.x ?? 0) - (before?.x ?? 0))

  await page.reload()
  await expect(page.locator(`.bnode[data-node="${id}"]`)).toBeVisible()
  // Every node starts closed again; open, the layer is as wide as it was.
  await page.locator(`.bnode[data-node="${id}"] .layer-h h2`).click()
  await settled(page)
  await expect(page.locator(`.bnode[data-node="${leafId}"]`)).toBeVisible()
  expectNear(await fromRoot(page, id), after)
  await page.locator('[data-board="tidy"]').click()
  expectNear(await fromRoot(page, id), before)

  // Back to all at once: the title block goes back to the header, the sections to the page.
  await showLayers(page, 'all')
  await expect(page.locator('.board-viewport')).toHaveCount(0)
  await expect(page.locator('header .hdr-title h1')).toBeVisible()
  await expect(page.locator('#main > #overview')).toBeVisible()
  await expect(page.locator('nav.rail')).toBeVisible()
})
