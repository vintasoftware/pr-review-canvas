// @ts-check
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { toFileEntry } from '../../src/git/diff-collector.js'
import { emptyState } from '../../src/contract/state.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../../src/testing/synthetic.js'
import { stepAnchorId } from './keys.js'
import {
  overviewWayOnHtml,
  POINT_STEPS_ID,
  renderPointSteps,
  stopsOf,
  viewSwitchTarget,
} from './point-view.js'
import { pointSteps } from './point-steps.js'
import { pointCollapses } from './points.js'

const artifact = syntheticArtifact()
const files = SYNTHETIC_FILES.map(toFileEntry)
const state = emptyState('2026-10-21T10:00:00.000Z')

/** @param {string} html */
function draw(html) {
  document.body.innerHTML = html
  return document.body
}

/** @param {string} selector */
function all(selector) {
  return Array.from(document.querySelectorAll(selector))
}

describe('renderPointSteps', () => {
  it('opens each layer with a stop of its own, then its points, layer by layer', () => {
    const root = draw(renderPointSteps(artifact, files, state))
    expect(root.querySelector(`#${POINT_STEPS_ID}`)).not.toBeNull()
    expect(all('section.point-step').map(section => section.id)).toEqual([
      'step-layer-run-path',
      'step-p-1',
      'step-layer-other',
      'step-p-2',
      'step-p-3',
    ])
    expect(all('.step-n').map(el => el.textContent)).toEqual(['Point 1 of 3', 'Point 2 of 3', 'Point 3 of 3'])
  })

  it('shows a layer’s heading, description and tests in its opening stop', () => {
    draw(renderPointSteps(artifact, files, state))
    const stop = document.querySelector('#step-layer-run-path')
    expect(stop?.querySelector('h2')?.textContent).toBe('Layer 1 of 1Run path')
    expect(stop?.querySelector('input[data-reviewed-id="layer:run-path"]')).not.toBeNull()
    expect(stop?.querySelector('.rationale')?.textContent).toContain('The change to')
    expect(stop?.querySelectorAll('table.testmap tbody tr').length).toBeGreaterThan(0)
    // Other has no position among the layers and nothing to mark reviewed.
    expect(document.querySelector('#step-layer-other h2')?.textContent).toBe('Other changes')
    expect(document.querySelector('#step-layer-other input[data-reviewed-id]')).toBeNull()
  })

  it('names the layer each point belongs to, as a link to the layer’s opening stop', () => {
    draw(renderPointSteps(artifact, files, state))
    const link = document.querySelector('#step-p-1 .step-h a')
    expect(link?.textContent).toBe('Layer 1 · Run path')
    expect(link?.getAttribute('href')).toBe('#step-layer-run-path')
  })

  it('draws the point’s card under an id of its own, so the layer’s card keeps the point’s anchor', () => {
    draw(renderPointSteps(artifact, files, state))
    const card = document.querySelector('#step-p-1 li.finding')
    expect(card?.id).toBe('step-p-1-card')
    expect(card?.getAttribute('data-fingerprint')).toBe('fp-1')
  })

  it('draws the point’s card whole, whatever the list density', () => {
    document.documentElement.removeAttribute('data-points')
    draw(renderPointSteps(artifact, files, state))
    const card = document.querySelector('#step-p-1-card')
    if (!(card instanceof HTMLElement)) throw new Error('no card')
    expect(card.parentElement?.classList.contains('step-card')).toBe(true)
    expect(pointCollapses(card)).toBe(false)
  })

  it('names its point on the file card, so only that point marks the lines', () => {
    draw(renderPointSteps(artifact, files, state))
    expect(document.querySelector('#step-p-1-file')?.getAttribute('data-only-point')).toBe('fp-1')
  })

  it('draws the point’s file open, with only the chunk that holds its lines', () => {
    draw(renderPointSteps(artifact, files, state))
    const file = document.querySelector('#step-p-1 article.file')
    expect(file?.id).toBe('step-p-1-file')
    expect(file?.getAttribute('data-path')).toBe('src/app.ts')
    expect(file?.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
    // Its chevron says so, as the toggle reads it.
    expect(file?.querySelector('.file-h > .chev')?.getAttribute('aria-expanded')).toBe('true')
    const hunks = file?.querySelector('.diff-host')?.getAttribute('data-hunks')?.split(',')
    expect(hunks).toHaveLength(1)
  })

  it('leads from each stop to the one before and after, and from the last to the layers', () => {
    draw(renderPointSteps(artifact, files, state))
    const links = (/** @type {string} */ id) =>
      all(`#${id} .step-nav a`).map(a => [a.textContent, a.getAttribute('href')])
    expect(links('step-layer-run-path')).toEqual([
      ['← overview', '#overview'],
      ['go to its 1 attention point →', '#step-p-1'],
    ])
    expect(links(stepAnchorId('p-1'))).toEqual([
      ['← Run path', '#step-layer-run-path'],
      ['next layer: Other changes →', '#step-layer-other'],
    ])
    expect(links('step-layer-other')).toEqual([
      ['← previous point', '#step-p-1'],
      ['go to its 2 attention points →', '#step-p-2'],
    ])
    expect(links('step-p-2')).toEqual([
      ['← Other changes', '#step-layer-other'],
      ['next point →', '#step-p-3'],
    ])
    expect(links('step-p-3')).toEqual([
      ['← previous point', '#step-p-2'],
      ['the rest of the diff, by layer →', '#layer-run-path'],
    ])
  })

  it('keeps a point the reader acted on in its place, and draws nothing for a canvas without points', () => {
    const dismissed = { ...state, dismissed: { 'fp-2': { at: 'x' } } }
    draw(renderPointSteps(artifact, files, dismissed))
    expect(all('section.point-step').map(section => section.id)).toEqual([
      'step-layer-run-path',
      'step-p-1',
      'step-layer-other',
      'step-p-2',
      'step-p-3',
    ])
    expect(document.querySelector('#step-p-2-card')?.classList.contains('is-handled')).toBe(true)
    expect(renderPointSteps({ ...artifact, points: [] }, files, state)).toBe('')
  })

  it('opens a layer with tests and no points, and skips one with neither', () => {
    const [runPath, other] = artifact.layers
    if (runPath === undefined || other === undefined) throw new Error('two layers')
    const testsOnly = { ...artifact, points: artifact.points.filter(p => p.layerId === other.id) }
    expect(stopsOf(testsOnly, pointSteps(testsOnly, testsOnly.points)).map(stop => stop.id)).toEqual([
      'step-layer-run-path',
      'step-layer-other',
      'step-p-2',
      'step-p-3',
    ])
    const bare = {
      ...testsOnly,
      layers: testsOnly.layers.map(layer => (layer.id === runPath.id ? { ...layer, tests: [] } : layer)),
    }
    expect(stopsOf(bare, pointSteps(bare, bare.points)).map(stop => stop.id)).toEqual([
      'step-layer-other',
      'step-p-2',
      'step-p-3',
    ])
  })
})

describe('overviewWayOnHtml', () => {
  it('leads from the overview to the first layer’s opening stop', () => {
    draw(overviewWayOnHtml(artifact))
    const link = document.querySelector('.step-nav a')
    expect(link?.textContent).toBe('start with Layer 1: Run path →')
    expect(link?.getAttribute('href')).toBe('#step-layer-run-path')
  })

  it('has nothing to lead to on a canvas without points', () => {
    expect(overviewWayOnHtml({ ...artifact, points: [] })).toBe('')
  })
})

describe('viewSwitchTarget', () => {
  it('opens the one-point view on the opening stop of the layer being read', () => {
    expect(viewSwitchTarget(artifact, 'points', '#layer-run-path')).toBe('#step-layer-run-path')
    expect(viewSwitchTarget(artifact, 'points', '#step-p-2')).toBe('#step-layer-other')
    expect(viewSwitchTarget(artifact, 'points', '#overview')).toBe('#overview')
    // Any other place starts the view from its first stop.
    expect(viewSwitchTarget(artifact, 'points', '#line:src/app.ts:4')).toBe('')
    expect(viewSwitchTarget(artifact, 'points', '')).toBe('')
  })

  it('opens the layers on the layer of the stop being read, and anywhere else where it was', () => {
    expect(viewSwitchTarget(artifact, 'all', '#step-layer-other')).toBe('#layer-other')
    expect(viewSwitchTarget(artifact, 'all', '#step-p-1')).toBe('#layer-run-path')
    expect(viewSwitchTarget(artifact, 'all', '#overview')).toBe('#overview')
    expect(viewSwitchTarget(artifact, 'all', '')).toBe('')
  })
})
