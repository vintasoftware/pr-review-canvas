import { syntheticArtifact } from '../src/testing/synthetic.js'
import { expect, test } from './fixtures.js'

/** Wide enough for split with the AI Chat pane docked beside the diff. */
const WIDE = { width: 1920, height: 1000 }

for (const skin of ['github', 'olive', 'terminal']) {
  test(`the settings dialog saves the diff layout and the page follows it in the ${skin} skin`, async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(`${reviewUrl}?skin=${skin}`)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    await expect(file.locator('tr.del#L-src_app_ts-old-3')).toBeVisible()

    await page.locator('#settings').click()
    await expect(page.locator('#set-diff-layout')).toHaveValue('unified')
    await page.locator('#set-diff-layout').selectOption('split')
    await page.locator('[data-act="settings-save"]').click()
    await expect(page.locator('#settings-dialog')).toBeHidden()
    await expect(file.locator('#L-src_app_ts-new-4 td.code.del')).toBeVisible()
    await expect(page.locator('#diff-layout-toggle')).toHaveAttribute('data-layout', 'split')
    await file.screenshot({ path: testInfo.outputPath(`split-${skin}.png`) })

    await page.reload()
    await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
    await expect(page.locator('#L-src_app_ts-new-4 td.code.del')).toBeVisible()
  })
}

test.describe('split layout', () => {
  test.use({ settings: { diffLayout: 'split' } })

  test('draws the old and new code side by side, and s switches back to unified for good', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()

    // The changed line sits beside the line it became, each side with its own number.
    const row = file.locator('#L-src_app_ts-new-4')
    await expect(row.locator('td.code.del')).toHaveText('-  return a()')
    await expect(row.locator('td.code.add')).toHaveText('+  return a() + b()')
    await expect(row.locator('td.ln[data-side="old"]')).toHaveText('3')
    const [left, right] = await Promise.all([
      row.locator('td.code.del').boundingBox(),
      row.locator('td.code.add').boundingBox(),
    ])
    expect(right!.x).toBeGreaterThan(left!.x + left!.width - 1)
    expect(Math.abs(left!.width - right!.width)).toBeLessThan(2)
    await expect(page.locator('#diff-layout-toggle')).toHaveAttribute('data-layout', 'split')
    await page.screenshot({ path: testInfo.outputPath('split.png') })

    const saved = page.waitForRequest(r => r.url().endsWith('/api/settings') && r.method() === 'PUT')
    await page.keyboard.press('s')
    expect((await saved).postDataJSON()).toEqual({ diffLayout: 'unified' })
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(file.locator('tr.del#L-src_app_ts-old-3')).toBeVisible()

    await page.reload()
    await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
    await expect(page.locator('#L-src_app_ts-old-3')).toHaveClass(/\bdel\b/)
    await expect(page.locator('#diff-layout-toggle')).toHaveAttribute('data-layout', 'unified')
  })

  test('comments on the old side from its own gutter, and keeps a half-written box across a switch', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()

    // A click on the left numbers selects the old side alone.
    await file.locator('#L-src_app_ts-new-4 td.ln[data-side="old"]').click()
    await expect(file.locator('#L-src_app_ts-new-4 td.is-selected')).toHaveCount(3)
    await expect(file.locator('#L-src_app_ts-new-4 td[data-side="new"].is-selected')).toHaveCount(0)
    await expect(file.locator('tr.sel-bar .lbl')).toHaveText('src/app.ts line 3')
    await page.keyboard.press('Escape')

    await file.locator('#L-src_app_ts-new-4 td.code.del').hover()
    await file.locator('#L-src_app_ts-new-4 td.gut[data-side="old"] .plus').click()
    const editor = file.locator('tr.composer')
    await editor.locator('textarea').fill('why drop the product?')

    // The box rides along to the unified row of its line, then back.
    await page.locator('#diff-layout-toggle').click()
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(editor.locator('textarea')).toHaveValue('why drop the product?')
    await page.locator('#diff-layout-toggle').click()
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    await expect(editor.locator('textarea')).toHaveValue('why drop the product?')

    const added = page.waitForRequest(r => r.url().includes('/pending') && r.method() === 'POST')
    await editor.locator('[data-act="composer-queue"]').click()
    expect((await added).postDataJSON()).toMatchObject({ path: 'src/app.ts', side: 'old', line: 3 })
    await expect(file.locator('tr.pending-row .pending-cmt')).toHaveCount(1)
  })

  test('keeps a shown resolved thread, the reply in it, and an opened fold across a switch', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    const thread = file.locator('tr.thread.resolved')
    await thread.locator('[data-act="thread-show"]').click()
    await thread.locator('[data-act="thread-reply"]').click()
    await thread.locator('textarea').fill('agreed, sum it is')
    await file.locator('tr.more.fold [data-act="show-fold"]').click()

    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(thread.locator('textarea')).toBeVisible()
    await expect(thread.locator('textarea')).toHaveValue('agreed, sum it is')
    await expect(file.locator('tr.more.fold [data-act="show-fold"]')).toHaveAttribute('aria-expanded', 'true')
    await expect(file.locator('#L-src_app_ts-new-2')).toBeVisible()
  })

  test('keeps the line under the sticky file header where it was across a switch', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    // A short window, so the file's header sticks over the top of the diff column mid-file.
    await page.setViewportSize({ width: WIDE.width, height: 420 })
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    // The line after the changed one: unified draws one more row above it than split does.
    const line = file.locator('#L-src_app_ts-new-5')
    const top = async () => Math.round((await line.boundingBox())!.y)
    const header = (await file.locator('.file-h').boundingBox())!.height
    await page.evaluate(
      ([y, under]) => window.scrollBy(0, y! - under!),
      [(await line.boundingBox())!.y, header]
    )
    await expect(file.locator('.file-h')).toBeInViewport()
    const before = await top()
    expect(before).toBeLessThan(header + 2)

    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1)
    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1)
  })

  test('draws unified where the diff column is too narrow, and says why split waits', async ({
    page,
    reviewUrl,
  }) => {
    // Every project's window is too narrow for split beside the docked AI Chat pane.
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    await expect(file.locator('tr.del#L-src_app_ts-old-3')).toBeVisible()
    await expect(page.locator('table.diff.split')).toHaveCount(0)
    const split = page.locator('#diff-layout-toggle')
    await expect(split).toBeDisabled()
    await expect(split).toHaveAttribute('title', /split needs a diff column at least 900px wide/)

    await page.keyboard.press('s')
    await expect(page.locator('.toast')).toContainText('split needs a diff column at least 900px wide')

    // Widened, the page draws the saved choice.
    await page.setViewportSize(WIDE)
    await expect(page.locator('table.diff.split').first()).toBeVisible()
    await expect(split).toBeEnabled()
  })
})

test.describe('split layout, each behavior', () => {
  test.use({ settings: { diffLayout: 'split' } })
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
  })

  test('a file not drawn yet draws split when seen, with the side it lacks left blank', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    await page.locator('article.file[data-path="src/app.ts"]').first().scrollIntoViewIfNeeded()
    await page.keyboard.press('s')
    await expect(page.locator('table.diff.split')).toHaveCount(0)
    await page.keyboard.press('s')

    await page.locator('#layer-other summary').first().click()
    const gone = page.locator('article.file[data-path="src/gone.ts"]')
    await gone.scrollIntoViewIfNeeded()
    const deleted = gone.locator('#L-src_gone_ts-old-1')
    await expect(deleted.locator('td.code.del')).toHaveText('-export const old = 1')
    await expect(deleted.locator('td.blank[data-side="new"]')).toHaveCount(3)
    // The point on the deleted line spans both sides under it.
    await expect(gone.locator('tr.ifind[data-fingerprint="fp-3"] > td')).toHaveAttribute('colspan', '6')

    const fresh = page.locator('article.file[data-path="src/new.ts"]')
    await fresh.scrollIntoViewIfNeeded()
    const added = fresh.locator('#L-src_new_ts-new-1')
    await expect(added.locator('td.code.add')).toHaveText('+export const fresh = true')
    await expect(added.locator('td.blank[data-side="old"]')).toHaveCount(3)
    // A blank side has no line to select or comment on.
    await added.locator('td.ln.blank').click()
    await expect(page.locator('.is-selected')).toHaveCount(0)
    await expect(added.locator('td.blank .plus')).toHaveCount(0)
    // The header row and the table's columns are the split ones.
    await expect(fresh.locator('table.diff.split thead th')).toHaveText([
      'Old',
      'Comment',
      'Old code',
      'New',
      'Comment',
      'New code',
    ])
    await expect(fresh.locator('tr.hunk td.code')).toHaveAttribute('colspan', '4')
  })

  test('selects a range on the new side, comments on it, and keeps the selection across a switch', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    await file.locator('#L-src_app_ts-new-3 td.ln[data-side="new"]').click()
    await file.locator('#L-src_app_ts-new-4 td.ln[data-side="new"]').click({ modifiers: ['Shift'] })
    await expect(file.locator('td[data-side="new"].is-selected')).toHaveCount(6)
    await expect(file.locator('td[data-side="old"].is-selected')).toHaveCount(0)
    await expect(file.locator('tr.sel-bar .lbl')).toHaveText('src/app.ts lines 3–4')
    await expect(file.locator('tr.sel-bar td.code')).toHaveAttribute('colspan', '4')

    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(file.locator('tr.is-selected')).toHaveCount(2)
    await expect(file.locator('tr.del.is-selected')).toHaveCount(0)
    await expect(file.locator('tr.sel-bar .lbl')).toHaveText('src/app.ts lines 3–4')
    await page.keyboard.press('s')
    await expect(file.locator('td[data-side="new"].is-selected')).toHaveCount(6)

    await file.locator('tr.sel-bar [data-act="comment-selection"]').click()
    const editor = file.locator('tr.composer')
    await expect(editor.locator('> td')).toHaveAttribute('colspan', '6')
    // A letter typed in the box is text, not the layout key.
    await editor.locator('textarea').pressSequentially('sums')
    await expect(editor.locator('textarea')).toHaveValue('sums')
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    const added = page.waitForRequest(r => r.url().includes('/pending') && r.method() === 'POST')
    await editor.locator('[data-act="composer-queue"]').click()
    expect((await added).postDataJSON()).toMatchObject({ side: 'new', startLine: 3, line: 4 })
  })

  test('keeps a draft being edited and the keys’ ring across a switch', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    await file.locator('#L-src_app_ts-new-4 td.code.add').hover()
    await file.locator('#L-src_app_ts-new-4 td.gut[data-side="new"] .plus').click()
    await file.locator('tr.composer textarea').fill('first words')
    await file.locator('tr.composer [data-act="composer-queue"]').click()
    const draft = file.locator('tr.pending-row .pending-cmt')
    await expect(draft).toHaveCount(1)
    await expect(file.locator('tr.pending-row > td')).toHaveAttribute('colspan', '6')
    await draft.locator('[data-act="pending-edit"]').click()
    await draft.locator('textarea').fill('second words')

    await page.locator('#diff-layout-toggle').click()
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(file.locator('tr.pending-row > td')).toHaveAttribute('colspan', '4')
    await expect(draft.locator('textarea')).toHaveValue('second words')
    await expect(draft.locator('[data-act="pending-edit"]')).toBeHidden()
    await draft.locator('[data-act="pending-save"]').click()
    await expect(file.locator('tr.pending-row')).toHaveAttribute('data-pending-body', 'second words')

    // The point the keys ring stays ringed.
    await page.keyboard.press(']')
    const ringed = page.locator('tr.ifind.is-focused')
    await expect(ringed).toHaveCount(1)
    const fingerprint = await ringed.getAttribute('data-fingerprint')
    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    await expect(ringed).toHaveAttribute('data-fingerprint', fingerprint!)
    await expect(ringed.locator('> td')).toHaveAttribute('colspan', '6')
  })

  test('a link to an old line lands on the split row that holds it', async ({ page, reviewUrl }) => {
    await page.goto(`${reviewUrl}#line:src/app.ts:3:old`)
    const row = page.locator('article.file[data-path="src/app.ts"]').first().locator('#L-src_app_ts-new-4')
    await expect(row).toHaveClass(/is-target/)
    await expect(row).toBeInViewport()
    await expect(row).toHaveAttribute('data-old', '3')
  })

  test('a wrapped line continues under its code, and a drag selects one side’s text', async ({
    page,
    reviewUrl,
  }) => {
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    // Large type makes the short lines of this diff wrap.
    await page.addStyleTag({ content: '.diff { font-size: 60px !important; line-height: 70px !important }' })
    const lines = await file.locator('#L-src_app_ts-new-4 td.code.add').evaluate(cell => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      const lefts = new Map<number, number>()
      for (const rect of range.getClientRects()) {
        const top = Math.round(rect.top)
        lefts.set(top, Math.min(lefts.get(top) ?? Infinity, rect.left))
      }
      const ch = parseFloat(getComputedStyle(cell).fontSize) * 0.6
      return { lefts: [...lefts.entries()].sort((a, b) => a[0] - b[0]).map(([, left]) => left), ch }
    })
    expect(lines.lefts.length).toBeGreaterThan(1)
    // One character in: the column of the code, after the marker.
    expect(lines.lefts[1]! - lines.lefts[0]!).toBeGreaterThan(lines.ch * 0.9)
    expect(lines.lefts[1]! - lines.lefts[0]!).toBeLessThan(lines.ch * 1.1)
    await page.addStyleTag({ content: '.diff { font-size: 12px !important; line-height: 20px !important }' })

    const drag = async (side: 'old' | 'new') => {
      const from = (await file.locator(`#L-src_app_ts-new-3 td.code[data-side="${side}"]`).boundingBox())!
      const to = (await file.locator(`#L-src_app_ts-new-5 td.code[data-side="${side}"]`).boundingBox())!
      await page.mouse.move(from.x + 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 5 })
      await page.mouse.up()
      return page.evaluate(() => String(getSelection()))
    }
    const right = await drag('new')
    expect(right).toContain('+  return a() + b()')
    expect(right).not.toContain('-  return a()')
    const left = await drag('old')
    expect(left).toContain('-  return a()')
    expect(left).not.toContain('+ b()')
    // A press outside the code frees both sides again.
    await page.locator('.hdr-title').click()
    await expect(page.locator('[data-select-side]')).toHaveCount(0)
  })

  test('says so when the choice cannot be saved, and still switches', async ({ page, reviewUrl }) => {
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    await page.route('**/api/settings', route =>
      route.request().method() === 'PUT' ? route.abort() : route.continue()
    )
    const toggle = page.locator('#diff-layout-toggle')
    await expect(toggle).toHaveText('layout: split')
    await expect(toggle).toHaveAttribute(
      'title',
      'Diff layout: split. Switch to unified (s); the choice is saved'
    )
    await toggle.click()
    await expect(page.locator('.toast')).toContainText('could not save the diff layout to settings.yml')
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(toggle).toHaveText('layout: unified')
    await page.keyboard.press('?')
    await expect(page.locator('dialog[open]')).toContainText('switch the diff between unified and split')
  })

  test('minimizing AI Chat makes room for split, and docking it again keeps the box being written', async ({
    page,
    reviewUrl,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    const toggle = page.locator('#diff-layout-toggle')
    await expect(toggle).toBeDisabled()
    await page.getByRole('button', { name: 'Minimize AI Chat' }).click()
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    await expect(toggle).toBeEnabled()

    await file.locator('#L-src_app_ts-new-4 td.code.del').hover()
    await file.locator('#L-src_app_ts-new-4 td.gut[data-side="old"] .plus').click()
    const text = file.locator('tr.composer textarea')
    await text.fill('kept while the pane opens')
    await page.getByRole('button', { name: 'AI Chat', exact: true }).click()
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(toggle).toBeDisabled()
    await expect(text).toHaveValue('kept while the pane opens')
    await expect(file.locator('tr.composer')).toHaveCount(1)
    // The saved choice is still split.
    const saved = await page.evaluate(async () => (await (await fetch('../api/settings')).json()).settings)
    expect(saved.diffLayout).toBe('split')
  })
})

test.describe('split layout with a point drawn as one line', () => {
  test.use({ settings: { diffLayout: 'split' } })

  test('a point the reader opened stays open across a switch', async ({ page, reviewUrl }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(reviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    const point = file.locator('tr.ifind[data-fingerprint="fp-1"]')
    // A point added to the review collapses to its title.
    await point.locator('[data-act="point-queue"]').click()
    await expect(point).toHaveAttribute('data-status', 'queued')
    await expect(point).not.toHaveAttribute('data-expanded', '')
    await point.locator('.p-toggle').click()
    await expect(point).toHaveAttribute('data-expanded', '')
    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(point).toHaveAttribute('data-expanded', '')
    await point.locator('.p-toggle').click()
    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    await expect(point).not.toHaveAttribute('data-expanded', '')
  })
})

test.describe('split layout by points', () => {
  test.use({ settings: { diffLayout: 'split', readByPoints: true } })

  test('a stop of one point at a time draws split and follows a switch', async ({
    page,
    reviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(`${reviewUrl}#point-p-1`)
    const layer = page.locator('#layer-run-path')
    await expect(layer).toHaveAttribute('data-lens', 'point')
    const row = layer.locator('#L-src_app_ts-new-4')
    await expect(row.locator('td.code.del')).toBeVisible()
    await page.keyboard.press('s')
    await expect(layer.locator('table.diff.split')).toHaveCount(0)
    await expect(layer.locator('#L-src_app_ts-old-3')).toBeVisible()
    await expect(layer).toHaveAttribute('data-lens', 'point')
  })
})

test.describe('split layout with canvas folds', () => {
  test.use({ settings: { diffLayout: 'split', foldLevel: 'moderate' } })

  test('a canvas fold counts both sides, spans the split columns, and stays open across a switch', async ({
    page,
    chatServer,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    const { url } = await chatServer({
      setup: async ({ ctx }) => {
        const artifact = syntheticArtifact()
        artifact.layers[0]!.files.find(file => file.path === 'src/app.test.ts')!.folds = [
          { title: 'The expectations', side: 'new', startLine: 2, endLine: 4, level: 'moderate' },
        ]
        ctx.fixtureArtifact = artifact
      },
    })
    await page.setViewportSize(WIDE)
    await page.goto(url)
    const file = page.locator('article.file[data-path="src/app.test.ts"]')
    await file.scrollIntoViewIfNeeded()
    const fold = file.locator('tr.code-fold')
    const toggle = fold.locator('.fold-toggle')
    // Lines 2 to 4 of the new file, and the old line beside line 3.
    await expect(fold.locator('> td')).toHaveAttribute('colspan', '6')
    await expect(toggle).toContainText('The expectations')
    await expect(toggle).toContainText('4 lines')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(file.locator('#L-src_app_test_ts-new-3')).toBeHidden()

    await toggle.click()
    await expect(file.locator('#L-src_app_test_ts-new-3 td.code.del')).toBeVisible()
    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(fold.locator('> td')).toHaveAttribute('colspan', '4')
    await expect(toggle).toContainText('4 lines')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(file.locator('#L-src_app_test_ts-old-3')).toBeVisible()

    await toggle.click()
    await expect(file.locator('#L-src_app_test_ts-old-3')).toBeHidden()
    await page.keyboard.press('s')
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(file.locator('#L-src_app_test_ts-new-3')).toBeHidden()

    // Lowering Hide code opens the fold without drawing the table again.
    await page.locator('#fold-level').selectOption('light')
    await expect(file.locator('#L-src_app_test_ts-new-3 td.code.add')).toBeVisible()
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
  })
})

test.describe('split layout for the author', () => {
  test.use({ settings: { diffLayout: 'split' } })

  test('keeps the reason being written to resolve a point across a switch', async ({
    page,
    selfReviewUrl,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'one wide window is enough')
    await page.setViewportSize(WIDE)
    await page.goto(selfReviewUrl)
    const file = page.locator('article.file[data-path="src/app.ts"]').first()
    await file.scrollIntoViewIfNeeded()
    const point = file.locator('tr.ifind[data-fingerprint="fp-1"]')
    await point.locator('[data-act="point-settle"]').click()
    const reason = point.locator('.settle-box textarea')
    await reason.fill('The spec says sum.')

    await page.locator('#diff-layout-toggle').click()
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(reason).toHaveValue('The spec says sum.')
    await page.locator('#diff-layout-toggle').click()
    await expect(file.locator('table.diff.split')).not.toHaveCount(0)
    await expect(reason).toHaveValue('The spec says sum.')

    // The point just resolved stays on the page, and a switch leaves it there.
    await point.locator('[name="settle-comment"]').uncheck()
    await point.locator('[data-act="settle-save"]').click()
    await expect(point).toHaveAttribute('data-status', 'resolved')
    await expect(point).toBeVisible()
    await page.locator('#diff-layout-toggle').click()
    await expect(file.locator('table.diff.split')).toHaveCount(0)
    await expect(point).toBeVisible()
  })
})
