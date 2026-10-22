// Turns a validated ModelOutput into the ReviewArtifact the server stores: ids, fingerprints,
// isTest, config risk tags, the points that missing tests and settled decisions add, and the
// generator stamp.
import { missingTestAnchor } from './missing-tests.js'
import { createHash } from 'node:crypto'
import { type SettledDecision, statedDecision } from '../contract/generation-context.js'
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
  Settlement,
  Side,
  TextCaps,
} from '../contract/review-artifact.js'
import { isGeneratorPoint, POINT_IMPACTS, POINT_LEVELS } from '../contract/review-artifact.js'
import { hunkForLine } from '../git/patch-lines.js'
import type { HighRiskRule } from '../project-config.js'
import { matchesGlob } from './glob.js'
import { DEFAULT_TEST_PATTERNS, isTestPath } from './test-paths.js'

export interface NormalizeInput {
  pr: Pr
  files: readonly FileEntry[]
  patches?: Readonly<Record<string, string>>
  highRisk: readonly HighRiskRule[]
  /** The caps in force; a generated `tests` point title is cut to `caps.pointTitle`. */
  caps: TextCaps
  generatedAt: string
  generator: Generator
  /** The canvas this one was generated from, when the run was incremental. */
  basisCanvasSha?: string | undefined
  /** The globs that make a file a test; the project config's list, or the built-in one. */
  testPatterns?: readonly string[] | undefined
  /** The author's settled decisions; each one in the diff becomes a resolved point. */
  decisions?: readonly SettledDecision[] | undefined
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

/** One attention point for each missing behavior, with the writer's routing and anchor. */
function testPoints(
  layer: Layer,
  files: readonly FileEntry[],
  titleCap: number,
  patches: Readonly<Record<string, string>>
): { layer: Layer; points: Unassigned[] } {
  const points: Unassigned[] = []
  const tests = layer.tests.map(t => {
    if (t.status !== 'missing') {
      return t
    }
    const anchor = missingTestAnchor(t, layer, files, patches)
    if (anchor === null) return t
    const title =
      t.title ??
      shortTitle(t.behavior, titleCap, titleCap >= 13 ? 'Missing test' : titleCap >= 5 ? 'Test' : '')
    const note = t.note === undefined ? '' : ` ${t.note}`
    const point: Unassigned = {
      kind: 'tests',
      level: 'check',
      title,
      ...anchor,
      body: `The layer "${layer.title}" lists this behavior without a test.${note}`,
      audience: t.audience ?? 'reviewer',
      fingerprint: fingerprint({ kind: 'tests', path: anchor.path, title }),
      origin: 'tests',
      layerId: layer.id,
    }
    points.push(point)
    return { ...t, title, audience: point.audience, anchor }
  })
  return { layer: { ...layer, tests }, points }
}

/** `text` when it fits `cap`, else its words up to the cap and an ellipsis; `fallback` stands in for no word. */
function shortTitle(text: string, cap: number, fallback: string): string {
  if (text.length <= cap) {
    return text
  }
  return `${
    text
      .slice(0, cap - 1)
      .replace(/\S*$/, '')
      .trimEnd() || fallback
  }…`
}

/**
 * One resolved point for each settled decision in the diff, on its line, titled by the question it
 * answers (or by the decision itself when the line states no question) and resolved with the
 * decision and its reason. Publish writes these, not the generator, so a decision costs the
 * generator none of its points and reads the same in every canvas built from its commit.
 */
function decisionPoints(
  decisions: readonly SettledDecision[],
  layers: readonly Layer[],
  files: readonly FileEntry[],
  titleCap: number
): { points: Unassigned[]; settled: Record<string, Settlement> } {
  const points: Unassigned[] = []
  const settled: Record<string, Settlement> = {}
  for (const decision of decisions) {
    // A question raised without an answer is only ever context.
    if (decision.line === null || decision.text === undefined) {
      continue
    }
    const asked = decision.question ?? decision.text
    const title = shortTitle(asked, titleCap, 'Settled decision')
    const commit = `Commit \`${decision.commit.slice(0, 7)}\``
    const on = decision.date.slice(0, 10)
    // The body states what the commit said, true whether the point is resolved or the author
    // reopened it, so a copy of the point or what AI Chat is told about it keeps the answer. A
    // question or a decision cut to fit the title is given whole.
    const said =
      decision.question === undefined
        ? title === asked
          ? `${commit} decided this on ${on}.`
          : `${commit} decided this on ${on}: ${decision.text}`
        : `${title === asked ? '' : `${asked}\n\n`}${commit} answered this on ${on}: ${decision.text}`
    const point: Unassigned = {
      kind: 'decision',
      level: 'fyi',
      title,
      path: decision.path,
      line: decision.line,
      side: decision.side,
      body: said,
      audience: 'author',
      // The whole line, not the title, names the decision: two decisions asking one question are
      // two points, and a revised answer is a new one, so a reason written on the canvas for the
      // old answer does not cover it.
      fingerprint: fingerprint({ kind: 'decision', path: decision.path, title: statedDecision(decision) }),
      origin: 'model',
      decisionCommit: decision.commit,
    }
    const layerId = layerIdForLine(layers, files, decision.path, decision.side, decision.line)
    if (layerId !== undefined) {
      point.layerId = layerId
    }
    points.push(point)
    settled[point.fingerprint] = { reason: decision.text, at: decision.date, commit: decision.commit }
  }
  return { points, settled }
}

const LEVEL_ORDER = new Map(POINT_LEVELS.map((l, i) => [l, i]))
/** Worst impact first; a point without one sorts after every point with one. */
function impactRank(p: Unassigned): number {
  return p.impact === undefined ? POINT_IMPACTS.length : POINT_IMPACTS.indexOf(p.impact)
}

function sortPoints(points: Unassigned[]): Point[] {
  const sorted = [...points].sort((a, b) => {
    const level = (LEVEL_ORDER.get(a.level) ?? 0) - (LEVEL_ORDER.get(b.level) ?? 0)
    if (level !== 0) {
      return level
    }
    const impact = impactRank(a) - impactRank(b)
    if (impact !== 0) {
      return impact
    }
    return a.path.localeCompare(b.path) || a.line - b.line
  })
  return sorted.map((p, i) => ({ ...p, id: `p-${i + 1}` }))
}

export function normalize(output: ModelOutput, input: NormalizeInput): ReviewArtifact {
  const testPatterns = input.testPatterns ?? DEFAULT_TEST_PATTERNS
  const generated = output.layers.map(l =>
    testPoints(
      toLayer(l, input.highRisk, testPatterns),
      input.files,
      input.caps.pointTitle,
      input.patches ?? {}
    )
  )
  const layers = generated.map(g => g.layer)
  const decided = decisionPoints(input.decisions ?? [], layers, input.files, input.caps.pointTitle)
  const points = [
    ...output.points.map(p => modelPoint(p, layers, input.files)),
    ...generated.flatMap(g => g.points),
    ...decided.points,
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
  if (Object.keys(decided.settled).length > 0) {
    artifact.settled = decided.settled
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
      // Before missing entries stored their point properties, all generated points in a layer
      // used its first hunk. Stable point sorting therefore kept the missing-entry order.
      const legacyPoints = artifact.points.filter(p => p.origin === 'tests' && p.layerId === layer.id)
      let missingIndex = 0
      const tests = layer.tests.map(test => {
        if (test.status !== 'missing') return test
        const point = legacyPoints[missingIndex++]
        if (test.title !== undefined || point === undefined) return test
        return {
          ...test,
          title: point.title,
          audience: point.audience,
          anchor: { path: point.path, line: point.line, side: point.side ?? 'new' },
        }
      })
      const out: ModelLayer = { ...rest, tests, files: files.map(({ isTest: _isTest, ...f }) => f) }
      if (modelRisk.length > 0) {
        out.risk = modelRisk
      }
      return out
    }),
    points: artifact.points
      .filter(isGeneratorPoint)
      .map(({ id: _id, fingerprint: _fp, origin: _origin, layerId: _layerId, ...p }) => p),
  }
}
