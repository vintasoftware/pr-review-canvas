// Turns a validated ModelOutput into the ReviewArtifact the server stores: ids, fingerprints,
// isTest, config risk tags, the points that missing tests add, and the generator stamp.
import { createHash } from 'node:crypto'
import type {
  FileEntry,
  Generator,
  Layer,
  ModelLayer,
  ModelOutput,
  ModelPoint,
  Point,
  Pr,
  ReviewArtifact,
  RiskTag,
  Side,
  TextCaps,
} from '../contract/review-artifact.js'
import { POINT_LEVELS } from '../contract/review-artifact.js'
import { chunkForLine } from '../git/patch-lines.js'
import type { HighRiskRule } from '../project-config.js'
import { matchesGlob } from './glob.js'
import { DEFAULT_TEST_PATTERNS, isTestPath } from './test-paths.js'

export interface NormalizeInput {
  pr: Pr
  files: readonly FileEntry[]
  highRisk: readonly HighRiskRule[]
  /** The caps in force; a generated `tests` point title is cut to `caps.pointTitle`. */
  caps: TextCaps
  generatedAt: string
  generator: Generator
  /** The globs that make a file a test; the project config's list, or the built-in one. */
  testPatterns?: readonly string[] | undefined
}

/** Lowercase, one space between words, so a retitled point keeps its fingerprint when only spacing changed. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function fingerprint(point: { kind: string; path: string; title: string }): string {
  return createHash('sha1')
    .update(`${point.kind}\n${point.path}\n${normalizeTitle(point.title)}`)
    .digest('hex')
}

function layerRisk(layer: ModelLayer, highRisk: readonly HighRiskRule[]): RiskTag[] {
  const tags: RiskTag[] = []
  const seen = new Set<string>()
  for (const rule of highRisk) {
    if (!seen.has(rule.label) && layer.files.some(f => matchesGlob(rule.pattern, f.path))) {
      seen.add(rule.label)
      tags.push({ label: rule.label, source: 'config' })
    }
  }
  for (const tag of layer.risk ?? []) {
    if (!seen.has(tag.label)) {
      seen.add(tag.label)
      tags.push({ label: tag.label, source: 'model', reason: tag.reason })
    }
  }
  return tags
}

function unionRisk(layers: readonly Layer[]): RiskTag[] {
  const out: RiskTag[] = []
  const seen = new Set<string>()
  for (const layer of layers) {
    for (const tag of layer.risk) {
      if (!seen.has(tag.label)) {
        seen.add(tag.label)
        out.push(tag)
      }
    }
  }
  return out
}

function toLayer(
  layer: ModelLayer,
  index: number,
  highRisk: readonly HighRiskRule[],
  testPatterns: readonly string[]
): Layer {
  const { risk: _modelRisk, files, ...rest } = layer
  return {
    ...rest,
    id: `layer-${index + 1}`,
    risk: layerRisk(layer, highRisk),
    files: files.map(f => ({ ...f, isTest: isTestPath(f.path, testPatterns) })),
  }
}

/** The layer that lists the chunk covering `path:line`, or undefined when no chunk covers it. */
export function layerIdForLine(
  layers: readonly Layer[],
  files: readonly FileEntry[],
  path: string,
  side: Side,
  line: number
): string | undefined {
  const entry = files.find(f => f.path === path)
  const chunk = entry === undefined ? null : chunkForLine(entry.chunks, side, line)
  if (chunk === null) {
    return undefined
  }
  return layers.find(l => l.files.some(f => f.chunks.includes(chunk.id)))?.id
}

type Unassigned = Omit<Point, 'id'>

function modelPoint(p: ModelPoint, layers: readonly Layer[], files: readonly FileEntry[]): Unassigned {
  const point: Unassigned = { ...p, fingerprint: fingerprint(p), origin: 'model' }
  const layerId = layerIdForLine(layers, files, p.path, p.side ?? 'new', p.line)
  if (layerId !== undefined) {
    point.layerId = layerId
  }
  return point
}

/** One `tests` point per missing test entry, anchored on the layer's first chunk. */
function testPoints(layer: Layer, files: readonly FileEntry[], titleCap: number): Unassigned[] {
  const out: Unassigned[] = []
  const first = layer.files[0]
  const entry = first === undefined ? undefined : files.find(f => f.path === first.path)
  const chunk = entry?.chunks.find(h => h.id === first?.chunks[0])
  if (first === undefined || chunk === undefined) {
    return out
  }
  const side: Side = chunk.newLines === 0 ? 'old' : 'new'
  const line = side === 'new' ? chunk.newStart : chunk.oldStart
  for (const t of layer.tests) {
    if (t.status !== 'missing') {
      continue
    }
    const title = t.behavior.length > titleCap ? `${t.behavior.slice(0, titleCap - 1)}…` : t.behavior
    const note = t.note === undefined ? '' : ` ${t.note}`
    const point: Unassigned = {
      kind: 'tests',
      level: 'check',
      title,
      path: first.path,
      line,
      side,
      body: `The layer "${layer.title}" lists this behavior without a test.${note}`,
      fingerprint: fingerprint({ kind: 'tests', path: first.path, title }),
      origin: 'tests',
      layerId: layer.id,
    }
    out.push(point)
  }
  return out
}

const LEVEL_ORDER = new Map(POINT_LEVELS.map((l, i) => [l, i]))

function sortPoints(points: Unassigned[]): Point[] {
  const sorted = [...points].sort((a, b) => {
    const level = (LEVEL_ORDER.get(a.level) ?? 0) - (LEVEL_ORDER.get(b.level) ?? 0)
    if (level !== 0) {
      return level
    }
    return a.path.localeCompare(b.path) || a.line - b.line
  })
  return sorted.map((p, i) => ({ ...p, id: `p-${i + 1}` }))
}

export function normalize(output: ModelOutput, input: NormalizeInput): ReviewArtifact {
  const testPatterns = input.testPatterns ?? DEFAULT_TEST_PATTERNS
  const layers = output.layers.map((l, i) => toLayer(l, i, input.highRisk, testPatterns))
  const points = [
    ...output.points.map(p => modelPoint(p, layers, input.files)),
    ...layers.flatMap(l => testPoints(l, input.files, input.caps.pointTitle)),
  ]
  return {
    version: 1,
    pr: input.pr,
    files: [...input.files],
    summary: output.summary,
    risk: unionRisk(layers),
    layers,
    points: sortPoints(points),
    generatedAt: input.generatedAt,
    generator: input.generator,
    source: 'local',
  }
}

/**
 * The model's view of a stored artifact: server-assigned fields removed, config risk dropped,
 * `tests` points dropped (publish recreates them). `pr-review validate review.json` uses this.
 */
export function artifactToModelOutput(artifact: ReviewArtifact): ModelOutput {
  return {
    summary: artifact.summary,
    layers: artifact.layers.map(layer => {
      const { id: _id, risk, files, ...rest } = layer
      const modelRisk = risk
        .filter(r => r.source === 'model')
        .map(r => ({ label: r.label, reason: r.reason ?? '' }))
      const out: ModelLayer = { ...rest, files: files.map(({ isTest: _isTest, ...f }) => f) }
      if (modelRisk.length > 0) {
        out.risk = modelRisk
      }
      return out
    }),
    points: artifact.points
      .filter(p => p.origin === 'model')
      .map(({ id: _id, fingerprint: _fp, origin: _origin, layerId: _layerId, ...p }) => p),
  }
}
