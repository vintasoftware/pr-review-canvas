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
import { hunkForLine } from '../git/patch-lines.js'
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
  /** The canvas this one was generated from, when the run was incremental. */
  basisCanvasSha?: string | undefined
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

/**
 * A layer's id is its own key, which the validator has already checked is unique here. A reviewed
 * mark is keyed by it, so a regenerated canvas that reorders or renames its layers keeps the
 * reviewer's progress pointing at the same concern; a position could not.
 */
function toLayer(
  layer: ModelLayer,
  highRisk: readonly HighRiskRule[],
  testPatterns: readonly string[]
): Layer {
  const { risk: _modelRisk, files, ...rest } = layer
  return {
    ...rest,
    id: layer.key,
    risk: layerRisk(layer, highRisk),
    files: files.map(f => ({ ...f, isTest: isTestPath(f.path, testPatterns) })),
  }
}

/** The layer that lists the hunk covering `path:line`, or undefined when no hunk covers it. */
export function layerIdForLine(
  layers: readonly Layer[],
  files: readonly FileEntry[],
  path: string,
  side: Side,
  line: number
): string | undefined {
  const entry = files.find(f => f.path === path)
  const hunk = entry === undefined ? null : hunkForLine(entry.hunks, side, line)
  if (hunk === null) {
    return undefined
  }
  return layers.find(l => l.files.some(f => f.hunks.includes(hunk.id)))?.id
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

/** One `tests` point per missing test entry, anchored on the layer's first hunk. */
function testPoints(layer: Layer, files: readonly FileEntry[], titleCap: number): Unassigned[] {
  const out: Unassigned[] = []
  const first = layer.files[0]
  const entry = first === undefined ? undefined : files.find(f => f.path === first.path)
  const hunk = entry?.hunks.find(h => h.id === first?.hunks[0])
  if (first === undefined || hunk === undefined) {
    return out
  }
  const side: Side = hunk.newLines === 0 ? 'old' : 'new'
  const line = side === 'new' ? hunk.newStart : hunk.oldStart
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
  const layers = output.layers.map(l => toLayer(l, input.highRisk, testPatterns))
  const points = [
    ...output.points.map(p => modelPoint(p, layers, input.files)),
    ...layers.flatMap(l => testPoints(l, input.files, input.caps.pointTitle)),
  ]
  const artifact: ReviewArtifact = {
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
  if (input.basisCanvasSha !== undefined) {
    artifact.basisCanvasSha = input.basisCanvasSha
  }
  return artifact
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
