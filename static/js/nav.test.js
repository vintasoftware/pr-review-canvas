// @ts-check
// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { emptyState } from '../../src/contract/state.js'
import { PACKAGE_ROOT } from '../../src/server/context.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { renderLayers } from './layers.js'
import { buildNavOrder, layerOf, nextFile, nextLayer, prevFile, prevLayer } from './nav.js'

const artifact = syntheticArtifact()

describe('buildNavOrder', () => {
  it('lists the overview, each layer with its files, and Other last, mirroring the rendered ids', () => {
    expect(buildNavOrder(artifact)).toEqual([
      { kind: 'overview', id: 'overview' },
      { kind: 'layer', id: 'layer-run-path', layerId: 'run-path', key: 'run-path', other: false },
      {
        kind: 'file',
        id: 'file-src_app_ts',
        layerId: 'run-path',
        key: 'src_app_ts',
        path: 'src/app.ts',
        isTest: false,
        other: false,
      },
      {
        kind: 'file',
        id: 'file-src_new_name_ts',
        layerId: 'run-path',
        key: 'src_new_name_ts',
        path: 'src/new-name.ts',
        isTest: false,
        other: false,
      },
      {
        kind: 'file',
        id: 'file-src_app_test_ts',
        layerId: 'run-path',
        key: 'src_app_test_ts',
        path: 'src/app.test.ts',
        isTest: true,
        other: false,
      },
      { kind: 'layer', id: 'layer-other', layerId: 'other', key: 'other', other: true },
      {
        kind: 'file',
        id: 'file-src_app_ts-other',
        layerId: 'other',
        key: 'src_app_ts',
        path: 'src/app.ts',
        isTest: false,
        other: true,
      },
      {
        kind: 'file',
        id: 'file-src_new_ts',
        layerId: 'other',
        key: 'src_new_ts',
        path: 'src/new.ts',
        isTest: false,
        other: true,
      },
      {
        kind: 'file',
        id: 'file-src_gone_ts',
        layerId: 'other',
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
    expect(nextLayer(order, 'layer-run-path')).toBeNull()
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
    expect(nextLayer(order, null)?.id).toBe('layer-run-path')
    expect(nextLayer(order, 'overview')?.id).toBe('layer-run-path')
    expect(nextLayer(order, 'layer-run-path')?.id).toBe('layer-other')
    expect(nextLayer(order, 'file-src_app_ts')?.id).toBe('layer-other')
    expect(nextLayer(order, 'layer-other')).toBeNull()
    expect(prevLayer(order, null)?.id).toBe('layer-other')
    expect(prevLayer(order, 'layer-other')?.id).toBe('layer-run-path')
    expect(prevLayer(order, 'layer-run-path')).toBeNull()
    expect(nextFile(order, null)?.id).toBe('file-src_app_ts')
    expect(nextFile(order, 'file-src_app_test_ts')?.id).toBe('file-src_app_ts-other')
    expect(nextFile(order, 'file-src_gone_ts')).toBeNull()
    expect(prevFile(order, 'file-src_app_ts-other')?.id).toBe('file-src_app_test_ts')
    expect(prevFile(order, 'file-src_app_ts')).toBeNull()
    expect(prevFile(order, null)?.id).toBe('file-src_gone_ts')
    expect(nextLayer(order, 'nope')?.id).toBe('layer-run-path')
    expect(prevLayer(order, 'nope')?.id).toBe('layer-other')
  })

  it('finds the layer an item belongs to', () => {
    expect(layerOf(order, 'file-src_new_ts')?.id).toBe('layer-other')
    expect(layerOf(order, 'layer-run-path')?.id).toBe('layer-run-path')
    expect(layerOf(order, 'overview')).toBeNull()
    expect(layerOf(order, 'nope')).toBeNull()
  })
})
