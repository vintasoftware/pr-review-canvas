// @ts-check
// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { emptyState } from '../../src/contract/state.js'
import { PACKAGE_ROOT } from '../../src/server/context.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { renderLayers } from './layers.js'
import { buildNavOrder, layerOf, readingItem, step } from './nav.js'

const all = () => true

const artifact = syntheticArtifact()

describe('buildNavOrder', () => {
  it('lists the overview, each layer with its files, and Other last, mirroring the rendered ids', () => {
    expect(buildNavOrder(artifact)).toEqual([
      { kind: 'overview', id: 'overview' },
      {
        kind: 'layer',
        id: 'layer-run-path',
        layerId: 'run-path',
        layerKey: 'run-path',
        key: 'run-path',
        other: false,
      },
      {
        kind: 'file',
        id: 'file-src_app_ts',
        layerId: 'run-path',
        layerKey: 'run-path',
        key: 'src_app_ts',
        path: 'src/app.ts',
        isTest: false,
        other: false,
      },
      {
        kind: 'file',
        id: 'file-src_new_name_ts',
        layerId: 'run-path',
        layerKey: 'run-path',
        key: 'src_new_name_ts',
        path: 'src/new-name.ts',
        isTest: false,
        other: false,
      },
      {
        kind: 'file',
        id: 'file-src_app_test_ts',
        layerId: 'run-path',
        layerKey: 'run-path',
        key: 'src_app_test_ts',
        path: 'src/app.test.ts',
        isTest: true,
        other: false,
      },
      { kind: 'layer', id: 'layer-other', layerId: 'other', layerKey: 'other', key: 'other', other: true },
      {
        kind: 'file',
        id: 'file-src_app_ts-other',
        layerId: 'other',
        layerKey: 'other',
        key: 'src_app_ts',
        path: 'src/app.ts',
        isTest: false,
        other: true,
      },
      {
        kind: 'file',
        id: 'file-src_new_ts',
        layerId: 'other',
        layerKey: 'other',
        key: 'src_new_ts',
        path: 'src/new.ts',
        isTest: false,
        other: true,
      },
      {
        kind: 'file',
        id: 'file-src_gone_ts',
        layerId: 'other',
        layerKey: 'other',
        key: 'src_gone_ts',
        path: 'src/gone.ts',
        isTest: false,
        other: true,
      },
    ])
  })

  it('names ids that layers.js renders, for the synthetic artifact and the PR #278 fixture', async () => {
    /** @type {import('./contract-types.js').ReviewArtifact} */
    const fixture = JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, '__fixtures__/pr-278/review.json'), 'utf8')
    )
    for (const a of [artifact, fixture]) {
      document.body.innerHTML = renderLayers(a, a.files, emptyState('x'))
      const order = buildNavOrder(a).filter(i => i.kind !== 'overview')
      expect(order.length).toBeGreaterThan(0)
      for (const item of order) {
        expect(document.getElementById(item.id), item.id).not.toBeNull()
      }
      expect(new Set(order.map(i => i.id)).size).toBe(order.length)
    }
  })

  it('works for a canvas without an Other layer', () => {
    const noOther = { ...artifact, layers: artifact.layers.filter(l => l.kind !== 'other') }
    const order = buildNavOrder(noOther)
    expect(order.map(i => i.id)).toEqual([
      'overview',
      'layer-run-path',
      'file-src_app_ts',
      'file-src_new_name_ts',
      'file-src_app_test_ts',
    ])
    expect(order.some(i => i.kind !== 'overview' && i.other)).toBe(false)
    expect(step(order, 'layer-run-path', 'layer', 1, all)).toBeNull()
  })

  it('moves Other to the end even when the artifact lists it first', () => {
    const reversed = { ...artifact, layers: [...artifact.layers].reverse() }
    expect(
      buildNavOrder(reversed)
        .filter(i => i.kind === 'layer')
        .map(i => i.id)
    ).toEqual(['layer-run-path', 'layer-other'])
  })
})

describe('next/prev', () => {
  const order = buildNavOrder(artifact)

  it('steps between layers and files from the current id, from nothing, and from an unknown id', () => {
    expect(step(order, null, 'layer', 1, all)?.id).toBe('layer-run-path')
    expect(step(order, 'overview', 'layer', 1, all)?.id).toBe('layer-run-path')
    expect(step(order, 'layer-run-path', 'layer', 1, all)?.id).toBe('layer-other')
    expect(step(order, 'file-src_app_ts', 'layer', 1, all)?.id).toBe('layer-other')
    expect(step(order, 'layer-other', 'layer', 1, all)).toBeNull()
    expect(step(order, null, 'layer', -1, all)?.id).toBe('layer-other')
    expect(step(order, 'layer-other', 'layer', -1, all)?.id).toBe('layer-run-path')
    expect(step(order, 'layer-run-path', 'layer', -1, all)).toBeNull()
    expect(step(order, null, 'file', 1, all)?.id).toBe('file-src_app_ts')
    expect(step(order, 'file-src_app_test_ts', 'file', 1, all)?.id).toBe('file-src_app_ts-other')
    expect(step(order, 'file-src_gone_ts', 'file', 1, all)).toBeNull()
    expect(step(order, 'file-src_app_ts-other', 'file', -1, all)?.id).toBe('file-src_app_test_ts')
    expect(step(order, 'file-src_app_ts', 'file', -1, all)).toBeNull()
    expect(step(order, null, 'file', -1, all)?.id).toBe('file-src_gone_ts')
    expect(step(order, 'nope', 'layer', 1, all)?.id).toBe('layer-run-path')
    expect(step(order, 'nope', 'layer', -1, all)?.id).toBe('layer-other')
  })

  it('passes over the cards the reader cannot see', () => {
    // The Other layer's files sit inside its closed details, so n stops at none of them.
    const shown = (/** @type {import('./nav.js').NavItem} */ item) => !(item.kind === 'file' && item.other)
    expect(step(order, 'file-src_app_test_ts', 'file', 1, shown)).toBeNull()
    expect(step(order, null, 'file', -1, shown)?.id).toBe('file-src_app_test_ts')
    expect(step(order, 'file-src_app_test_ts', 'layer', 1, shown)?.id).toBe('layer-other')
    expect(step(order, 'file-src_gone_ts', 'layer', -1, shown)?.id).toBe('layer-other')
  })

  it('finds the item at the top of the screen after a scroll', () => {
    /** @type {Record<string, number>} */
    const tops = {
      overview: -1500,
      'layer-run-path': -900,
      'file-src_app_ts': -400,
      'file-src_new_name_ts': 5,
      'file-src_app_test_ts': 300,
      'layer-other': 900,
    }
    const topOf = (/** @type {import('./nav.js').NavItem} */ item) => tops[item.id] ?? null
    expect(readingItem(order, topOf, 16)?.id).toBe('file-src_new_name_ts')
    expect(readingItem(order, topOf, 0)?.id).toBe('file-src_app_ts')
    // Before the first item reaches the top, the reader is on it; when nothing is drawn, on nothing.
    expect(readingItem(order, topOf, -2000)?.id).toBe('overview')
    expect(readingItem(order, id => (id.id === 'layer-other' ? 900 : null), 16)?.id).toBe('layer-other')
    expect(readingItem(order, () => null, 16)).toBeNull()
  })

  it('finds the layer an item belongs to', () => {
    expect(layerOf(order, 'file-src_new_ts')?.id).toBe('layer-other')
    expect(layerOf(order, 'layer-run-path')?.id).toBe('layer-run-path')
    expect(layerOf(order, 'overview')).toBeNull()
    expect(layerOf(order, 'nope')).toBeNull()
  })
})
