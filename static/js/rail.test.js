// @ts-check
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { emptyState } from '../../src/contract/state.js'
import { toPatchMap } from '../../src/git/diff-collector.js'
import { mapReviewComment } from '../../src/github/comments.js'
import { GH_REVIEW_COMMENTS, SYNTHETIC_FILES, syntheticArtifact } from '../../src/testing/synthetic.js'
import { setRenderContext } from './layers.js'
import { dotColor, refreshRail, renderRail } from './rail.js'

const NOW = new Date('2026-09-10T12:00:00.000Z')
const artifact = syntheticArtifact()
const files = artifact.files
const patches = toPatchMap(SYNTHETIC_FILES)
const comments = GH_REVIEW_COMMENTS.map(c => mapReviewComment(c, new Set([1001, 1002])))
const state = emptyState(NOW.toISOString())

/** @returns {import('./layers.js').RenderContext} */
function ctx() {
  return {
    artifact,
    headSha: artifact.pr.headSha,
    mergeBaseSha: artifact.pr.mergeBaseSha,
    files,
    patches,
    comments,
    state,
    now: NOW,
  }
}

describe('rail', () => {
  it('lists overview, layers with dots, and Other muted', () => {
    document.body.innerHTML = renderRail(artifact, state)
    const items = [...document.querySelectorAll('.tree a')]
    expect(items.map(a => a.getAttribute('href'))).toEqual(['#overview', '#layer-run-path', '#layer-other'])
    expect(items[0]?.getAttribute('aria-current')).toBe('location')
    expect(items[0]?.querySelector('.m')?.textContent).toBe('3 open attention points')
    expect(items[1]?.querySelector('.dot')?.getAttribute('aria-label')).toBe('not started')
    expect(items[1]?.querySelector('.dot')?.getAttribute('style')).toBe('--dc:var(--s1)')
    expect(items[1]?.querySelector('.m')?.textContent).toBe('3 files · schema')
    expect(document.querySelector('li.other .m')?.textContent).toBe('3 files, ignored')
    expect(dotColor(7)).toBe('var(--s2)')
  })

  it('shows partial and done dots and the active item', () => {
    const partial = { ...state, reviewed: { 'layer:run-path/file:src_app_ts': /** @type {const} */ (true) } }
    document.body.innerHTML = renderRail(artifact, partial, { activeId: 'layer-run-path' })
    const a = document.querySelector('a[href="#layer-run-path"]')
    expect(a?.getAttribute('aria-current')).toBe('location')
    expect(a?.querySelector('.dot')?.className).toBe('dot half')
    expect(a?.querySelector('.m')?.textContent).toBe('1 of 3 files · schema')
    const done = { ...state, reviewed: { 'layer:run-path': /** @type {const} */ (true) } }
    document.body.innerHTML = renderRail(artifact, done)
    expect(document.querySelector('a[href="#layer-run-path"] .dot')?.className).toBe('dot on')
    document.body.innerHTML = renderRail(
      {
        ...artifact,
        layers: artifact.layers.filter(l => l.kind !== 'other'),
        points: artifact.points.slice(0, 1),
      },
      state
    )
    expect(document.querySelector('li.other')).toBeNull()
    expect(document.querySelector('a[href="#overview"] .m')?.textContent).toBe('1 open attention point')
  })

  it('shows the lines each layer adds and removes next to its file count, after a state change too', () => {
    setRenderContext(ctx())
    document.body.innerHTML = renderRail(artifact, state)
    const stat = document.querySelector('a[href="#layer-run-path"] .diffstat')
    expect(stat?.getAttribute('title')).toBe('code +3 −2 · tests +2 −1')
    expect(document.querySelector('a[href="#layer-run-path"] .m')?.textContent).toBe(
      '3 files · +5 −3 (code +3 −2 · tests +2 −1) · schema'
    )
    expect(document.querySelector('li.other .m')?.textContent).toBe('3 files, ignored')
    const partial = { ...state, reviewed: { 'layer:run-path/file:src_app_ts': /** @type {const} */ (true) } }
    expect(refreshRail(document, artifact, partial)).toBe(true)
    expect(document.querySelector('a[href="#layer-run-path"] .m')?.textContent).toBe(
      '1 of 3 files · +5 −3 (code +3 −2 · tests +2 −1) · schema'
    )
    setRenderContext(null)
  })

  /**
   * The rail of the one-point view, drawn as the page draws it: the layers' rail, marked for the
   * points view, then drawn again.
   * @param {import('./contract-types.js').ReviewArtifact} canvas
   */
  function pointsRail(canvas) {
    document.body.innerHTML = renderRail(canvas, state, { switchable: true, points: true })
  }

  it('lists the points under their layers in the one-point view, and dims one acted on', () => {
    pointsRail(artifact)
    const group = () =>
      [...document.querySelectorAll('.rail-points li')].map(li =>
        li.classList.contains('pt-layer')
          ? `[${li.querySelector('.t')?.textContent}]`
          : li.querySelector('a')?.getAttribute('href')
      )
    expect(group()).toEqual(['[Run path]', '#point-p-1', '[Other changes]', '#point-p-2', '#point-p-3'])
    expect(document.querySelector('a[href="#point-p-1"] .lv.decide')).not.toBeNull()
    // A layer's heading leads to the layer's opening stop.
    expect(document.querySelector('.rail-points .pt-layer a')?.getAttribute('href')).toBe('#layer-run-path')
    const dismissed = { ...state, dismissed: { 'fp-2': { at: 'x' } } }
    expect(refreshRail(document, artifact, dismissed)).toBe(true)
    expect(group()).toEqual(['[Run path]', '#point-p-1', '[Other changes]', '#point-p-2', '#point-p-3'])
    expect(
      document.querySelector('a[href="#point-p-2"]')?.parentElement?.classList.contains('is-handled')
    ).toBe(true)
    expect(
      document.querySelector('a[href="#point-p-1"]')?.parentElement?.classList.contains('is-handled')
    ).toBe(false)
  })

  it('has no points group in the other views', () => {
    document.body.innerHTML = renderRail(artifact, state)
    expect(document.querySelector('.rail-points')).toBeNull()
    expect(refreshRail(document, artifact, state)).toBe(true)
    expect(document.querySelector('.rail-points')).toBeNull()
  })

  it('shows the points or the layers, under a switch between the two that presses the one shown', () => {
    const pressed = () =>
      [...document.querySelectorAll('.rail-view button')].map(button => [
        button.textContent,
        button.getAttribute('data-view'),
        button.getAttribute('aria-pressed'),
      ])
    pointsRail(artifact)
    expect(pressed()).toEqual([
      ['Attention points', 'points', 'true'],
      ['Layers', 'layers', 'false'],
    ])
    expect(document.querySelector('.layers')).toBeNull()
    expect(document.querySelector('li.other')).toBeNull()
    document.body.innerHTML = renderRail(artifact, state, { switchable: true })
    expect(pressed()).toEqual([
      ['Attention points', 'points', 'false'],
      ['Layers', 'layers', 'true'],
    ])
    expect(document.querySelector('.layers')).not.toBeNull()
    // A page that does not read by attention points names its layers, with no switch, and keeps
    // that when the rail is drawn again.
    document.body.innerHTML = renderRail(artifact, state)
    expect(pressed()).toEqual([])
    expect(document.querySelector('.grp-lbl')?.textContent).toBe('Layers')
    refreshRail(document, artifact, state)
    expect(pressed()).toEqual([])
  })

  it('names the layers with no switch, and in either view, for a canvas without points', () => {
    const pointless = { ...artifact, points: [] }
    for (const points of [false, true]) {
      if (points) {
        pointsRail(pointless)
      } else {
        document.body.innerHTML = renderRail(pointless, state)
      }
      expect(document.querySelector('.rail-view')).toBeNull()
      expect(document.querySelector('.grp-lbl')?.textContent).toBe('Layers')
      expect(document.querySelector('.layers')).not.toBeNull()
    }
  })
})
