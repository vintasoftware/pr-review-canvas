// Every rule the client relies on, checked here and nowhere else. Pure: the caller passes the
// hunk index and the config; the report lists one line per problem and never fixes anything.
import type { z } from 'zod'
import { extractLinks, type LinkTargets, parseLink, resolveLink } from '../contract/links.js'
import { diagramKind, mermaidBlocks, withoutMermaid } from '../contract/mermaid-fences.js'
import {
  type FileEntry,
  type Hunk,
  type Limits,
  type ModelLayer,
  type ModelOutput,
  modelOutputSchema,
  type Side,
  type TextCaps,
} from '../contract/review-artifact.js'
import type { ValidationCode, ValidationError, ValidationReport } from '../contract/validation.js'
import { hunkForLine, hunkLineRanges } from '../git/patch-lines.js'
import type { HighRiskRule } from '../project-config.js'
import { diagramNodeIds } from './diagram-nodes.js'
import { matchesGlob } from './glob.js'
import { coveredStem, DEFAULT_TEST_PATTERNS, isTestPath, sourceStem } from './test-paths.js'
import { visibleLength } from './text-length.js'
import { visiblePrefix } from './trim-caps.js'
import { validateFolds } from './validate-folds.js'

export interface ValidationInput {
  files: readonly FileEntry[]
  caps: TextCaps
  limits: Limits
  highRisk: readonly HighRiskRule[]
  /** Paths that exist at the PR head without being in the diff (for `covered` test paths). */
  headPaths?: ReadonlySet<string>
  /** The globs that make a file a test; the project config's list, or the built-in one. */
  testPatterns?: readonly string[] | undefined
  /**
   * The output was read back from a stored `review.json`, whose generator may predate the rules
   * about what a canvas must hide. Only the correctness rules apply then: coordinates, and the
   * ranges no fold may cover. A fresh `model.json` is held to the full shape.
   */
  storedArtifact?: boolean | undefined
}

export type ValidationResult = ValidationReport & { output: ModelOutput | null }

function valueAt(root: unknown, keys: readonly PropertyKey[]): unknown {
  let cur: unknown = root
  for (const k of keys) {
    if (typeof cur !== 'object' || cur === null) {
      return undefined
    }
    cur = Reflect.get(cur, k)
  }
  return cur
}

/**
 * The `covered` test paths of a raw output, read before validation so the caller can look them up
 * at the PR head. Anything that is not the expected shape is skipped; the schema names it later.
 */
export function coveredTestPaths(raw: unknown): string[] {
  const out: string[] = []
  const layers = valueAt(raw, ['layers'])
  if (!Array.isArray(layers)) {
    return out
  }
  for (const layer of layers) {
    const tests = valueAt(layer, ['tests'])
    if (!Array.isArray(tests)) {
      continue
    }
    for (const t of tests) {
      const testPath = valueAt(t, ['testPath'])
      if (valueAt(t, ['status']) === 'covered' && typeof testPath === 'string') {
        out.push(testPath)
      }
    }
  }
  return out
}

function schemaErrors(raw: unknown, issues: readonly z.core.$ZodIssue[]): ValidationError[] {
  return issues.map(issue => {
    const where = issue.path.map(String).join('.') || '(root)'
    const value = valueAt(raw, issue.path)
    if (issue.code === 'too_big' && typeof value === 'string' && typeof issue.maximum === 'number') {
      return {
        code: 'TEXT_TOO_LONG',
        message: `${where}: ${value.length} raw chars, hard limit ${issue.maximum}`,
        where,
      }
    }
    return { code: 'SCHEMA', message: `${where}: ${issue.message}`, where }
  })
}

class Report {
  readonly errors: ValidationError[] = []
  add(code: ValidationCode, where: string, message: string): void {
    this.errors.push({ code, message, where })
  }
}

interface Index {
  byPath: Map<string, FileEntry>
  byHunkId: Map<string, { file: FileEntry; hunk: Hunk }>
}

function indexFiles(files: readonly FileEntry[]): Index {
  const byPath = new Map<string, FileEntry>()
  const byHunkId = new Map<string, { file: FileEntry; hunk: Hunk }>()
  for (const file of files) {
    byPath.set(file.path, file)
    for (const hunk of file.hunks) {
      byHunkId.set(hunk.id, { file, hunk })
    }
  }
  return { byPath, byHunkId }
}

function layerLabel(layer: ModelLayer): string {
  return layer.kind === 'other' ? 'other' : `layer ${layer.key}`
}

/**
 * Every capped field, measured as the reader sees it: link targets and code markers do not count.
 * The two fields that draw diagrams are measured without their mermaid source, since the reader
 * sees a drawing there; the source answers to the diagram cap instead.
 */
function checkLengths(output: ModelOutput, caps: TextCaps, report: Report): void {
  const check = (where: string, key: keyof TextCaps, text: string | undefined, drawn = false): void => {
    if (text === undefined) {
      return
    }
    const measured = drawn ? withoutMermaid(text) : text
    const length = visibleLength(measured)
    if (length > caps[key]) {
      // Name where the cap falls in their own words, so the rewrite is not guessed at twice.
      const fits = visiblePrefix(measured, caps[key])
      report.add(
        'TEXT_TOO_LONG',
        where,
        `${where}: ${length} visible chars, cap ${caps[key]}; what fits ends at "...${fits.slice(-40)}"`
      )
    }
  }
  check('summary', 'summary', output.summary, true)
  output.layers.forEach((layer, i) => {
    const at = `layers.${i}`
    check(`${at}.title`, 'layerTitle', layer.title)
    check(`${at}.rationale`, 'rationale', layer.rationale, true)
    check(`${at}.decisions`, 'decisions', layer.decisions)
    check(`${at}.checkByHand`, 'checkByHand', layer.checkByHand)
    layer.tests.forEach((t, j) => {
      check(`${at}.tests.${j}.behavior`, 'testBehavior', t.behavior)
    })
    layer.files.forEach((f, j) => {
      check(`${at}.files.${j}.note`, 'annotation', f.note)
      f.folds?.forEach((fold, k) => {
        const where = `${at}.files.${j}.folds.${k}.title`
        if (fold.title.length > caps.pointTitle) {
          report.add(
            'TEXT_TOO_LONG',
            where,
            `${where}: ${fold.title.length} visible chars, cap ${caps.pointTitle}`
          )
        }
      })
      f.annotations.forEach((a, k) => {
        check(`${at}.files.${j}.annotations.${k}.text`, 'annotation', a.text)
      })
    })
  })
  output.points.forEach((p, i) => {
    check(`points.${i}.title`, 'pointTitle', p.title)
    check(`points.${i}.body`, 'pointBody', p.body)
  })
}

/**
 * A diagram per layer and one for the summary, each within the diagram cap. A layer draws its
 * `diagram` field and a ```mermaid block in its rationale; the summary draws a block of its own.
 * Those are the places the page renders, so those are the places counted.
 */
function checkDiagrams(output: ModelOutput, caps: TextCaps, limits: Limits, report: Report): void {
  const measure = (field: string, sources: readonly string[]): void => {
    sources.forEach((source, i) => {
      if (source.length > caps.diagram) {
        const at = sources.length === 1 ? field : `${field}.${i + 1}`
        report.add('TEXT_TOO_LONG', at, `${at}: ${source.length} raw chars, cap ${caps.diagram}`)
      }
    })
  }
  const count = (where: string, label: string, n: number): void => {
    if (n > limits.maxDiagramsPerLayer) {
      report.add('DIAGRAM_LIMIT', where, `${label}: ${n} diagrams, at most ${limits.maxDiagramsPerLayer}`)
    }
  }
  const summaryBlocks = mermaidBlocks(output.summary)
  measure('summary.diagram', summaryBlocks)
  count('summary', 'summary', summaryBlocks.length)
  output.layers.forEach((layer, i) => {
    const at = `layers.${i}`
    const blocks = mermaidBlocks(layer.rationale)
    measure(`${at}.rationale.diagram`, blocks)
    let n = blocks.length
    if (layer.diagram !== undefined) {
      measure(`${at}.diagram.mermaid`, [layer.diagram.mermaid])
      n += 1
    }
    count(`layer:${layer.key}`, layerLabel(layer), n)
  })
}

function checkHunks(output: ModelOutput, index: Index, report: Report): Map<string, ModelLayer> {
  const owner = new Map<string, ModelLayer>()
  for (const layer of output.layers) {
    const where = `layer:${layer.key}`
    for (const file of layer.files) {
      const entry = index.byPath.get(file.path)
      if (entry === undefined) {
        report.add('PATH_UNKNOWN', where, `${layerLabel(layer)}: ${file.path} is not in the diff`)
      }
      for (const id of file.hunks) {
        const hit = index.byHunkId.get(id)
        if (hit === undefined) {
          const hint = entry === undefined ? '' : ` (${file.path} has ${entry.hunks.length} chunks)`
          report.add('HUNK_UNKNOWN', where, `${layerLabel(layer)}: ${id} does not exist${hint}`)
          continue
        }
        if (hit.file.path !== file.path) {
          report.add(
            'HUNK_UNKNOWN',
            where,
            `${layerLabel(layer)}: ${id} belongs to ${hit.file.path}, not ${file.path}`
          )
          continue
        }
        const first = owner.get(id)
        if (first !== undefined) {
          report.add(
            'HUNK_DUPLICATE',
            where,
            `${id} (${hit.hunk.header}) is in ${layerLabel(first)} and ${layerLabel(layer)}`
          )
          continue
        }
        owner.set(id, layer)
      }
    }
  }
  for (const { file, hunk } of index.byHunkId.values()) {
    if (!owner.has(hunk.id)) {
      report.add(
        'HUNK_UNASSIGNED',
        `hunk:${hunk.id}`,
        `${hunk.id} in ${file.path} (${hunk.header}) is in no layer`
      )
    }
  }
  return owner
}

function checkLayers(output: ModelOutput, report: Report): void {
  const keys = new Map<string, number>()
  output.layers.forEach((layer, i) => {
    const where = `layer:${layer.key}`
    const seen = keys.get(layer.key)
    if (seen !== undefined) {
      report.add(
        'LAYER_KEY_DUPLICATE',
        where,
        `layer ${i + 1}: key "${layer.key}" is also used by layer ${seen + 1}`
      )
    } else {
      keys.set(layer.key, i)
    }
    if (layer.files.length === 0) {
      report.add('LAYER_EMPTY', where, `${layerLabel(layer)} has no chunks`)
    }
  })
  // Other is optional: at most one, and last when present.
  const others = output.layers.filter(l => l.kind === 'other')
  const [first, ...extra] = others
  for (const other of extra) {
    report.add(
      'OTHER_DUPLICATE',
      `layer:${other.key}`,
      `layer ${other.key} is a second Other layer; layer ${first?.key ?? ''} already is one`
    )
  }
  const last = output.layers[output.layers.length - 1]
  if (first !== undefined && first !== last) {
    report.add(
      'OTHER_NOT_LAST',
      `layer:${first.key}`,
      `layer ${first.key} (kind other) must be the last layer`
    )
  }
}

function checkTests(
  output: ModelOutput,
  index: Index,
  headPaths: ReadonlySet<string>,
  testPatterns: readonly string[],
  report: Report
): void {
  const isTest = (p: string): boolean => isTestPath(p, testPatterns)
  const other = output.layers.find(l => l.kind === 'other')
  const sourceOwner = new Map<string, ModelLayer>()
  for (const layer of output.layers) {
    if (layer.kind === 'other') {
      continue
    }
    for (const file of layer.files) {
      if (!isTest(file.path)) {
        sourceOwner.set(sourceStem(file.path), layer)
      }
    }
  }
  for (const layer of output.layers) {
    const where = `layer:${layer.key}`
    let firstTest: string | null = null
    for (const file of layer.files) {
      if (isTest(file.path)) {
        firstTest ??= file.path
      } else if (firstTest !== null) {
        report.add('TEST_NOT_LAST', where, `${layerLabel(layer)}: ${firstTest} precedes ${file.path}`)
        firstTest = null
      }
    }
    for (const t of layer.tests) {
      if (t.status !== 'covered') {
        continue
      }
      if (t.testPath === undefined) {
        report.add(
          'TEST_PATH_UNKNOWN',
          where,
          `${layerLabel(layer)}: "${t.behavior}" is covered but names no testPath`
        )
      } else if (!(index.byPath.has(t.testPath) || headPaths.has(t.testPath))) {
        report.add('TEST_PATH_UNKNOWN', where, `${layerLabel(layer)}: ${t.testPath} is not in the PR head`)
      }
    }
  }
  if (other !== undefined) {
    for (const file of other.files) {
      if (!isTest(file.path)) {
        continue
      }
      const owner = sourceOwner.get(coveredStem(file.path))
      if (owner !== undefined) {
        const source = owner.files.find(f => sourceStem(f.path) === coveredStem(file.path))?.path ?? ''
        report.add(
          'TEST_IN_OTHER',
          `layer:${other.key}`,
          `other: ${file.path} covers ${source}, which is in layer ${owner.key}`
        )
      }
    }
  }
}

function checkRisk(output: ModelOutput, highRisk: readonly HighRiskRule[], report: Report): void {
  const other = output.layers.find(l => l.kind === 'other')
  if (other === undefined) {
    return
  }
  const where = `layer:${other.key}`
  for (const tag of other.risk ?? []) {
    report.add(
      'RISK_IN_OTHER',
      where,
      `other: carries the risk tag "${tag.label}"; move the chunks to a real layer`
    )
  }
  for (const file of other.files) {
    const rule = highRisk.find(r => matchesGlob(r.pattern, file.path))
    if (rule !== undefined) {
      report.add(
        'RISK_IN_OTHER',
        where,
        `other: ${file.path} matches highRisk "${rule.pattern}" (${rule.label})`
      )
    }
  }
}

function hunkAt(file: FileEntry | undefined, side: Side, line: number): Hunk | null {
  return file === undefined ? null : hunkForLine(file.hunks, side, line)
}

function checkAnnotations(output: ModelOutput, index: Index, report: Report): void {
  for (const layer of output.layers) {
    for (const file of layer.files) {
      const entry = index.byPath.get(file.path)
      file.annotations.forEach((a, i) => {
        const where = `layer:${layer.key}/annotation:${file.path}:${i + 1}`
        const range = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`
        const label = `${layerLabel(layer)} ${file.path}:${range} (${a.side})`
        if (a.endLine < a.startLine) {
          report.add('ANNOTATION_OUTSIDE_HUNK', where, `${label}: endLine is before startLine`)
          return
        }
        const start = hunkAt(entry, a.side, a.startLine)
        const end = hunkAt(entry, a.side, a.endLine)
        if (start === null || end === null || start.id !== end.id) {
          report.add(
            'ANNOTATION_OUTSIDE_HUNK',
            where,
            `${label} is not inside one chunk of the diff (${hunkLineRanges(entry?.hunks ?? [], a.side)})`
          )
        } else if (!file.hunks.includes(start.id)) {
          report.add(
            'ANNOTATION_OUTSIDE_HUNK',
            where,
            `${label} is in ${start.id}, which this layer does not list`
          )
        }
      })
    }
  }
}

function checkPoints(output: ModelOutput, index: Index, limits: Limits, report: Report): void {
  const missingTests = output.layers.reduce(
    (n, l) => n + l.tests.filter(t => t.status === 'missing').length,
    0
  )
  const total = output.points.length + missingTests
  if (total > limits.maxPoints) {
    report.add(
      'TOO_MANY_POINTS',
      'points',
      `${total} attention points (${output.points.length} written + ${missingTests} from missing tests), cap ${limits.maxPoints}`
    )
  }
  output.points.forEach((p, i) => {
    const where = `point:${i + 1}`
    const side = p.side ?? 'new'
    const entry = index.byPath.get(p.path)
    const start = hunkAt(entry, side, p.line)
    if (entry === undefined) {
      report.add('POINT_OUTSIDE_DIFF', where, `point ${i + 1} "${p.title}": ${p.path} is not in the diff`)
      return
    }
    if (start === null) {
      report.add(
        'POINT_OUTSIDE_DIFF',
        where,
        `point ${i + 1} "${p.title}": ${p.path}:${p.line} (${side}) is not in the diff (${hunkLineRanges(entry.hunks, side)})`
      )
      return
    }
    if (p.endLine !== undefined && p.endLine < p.line) {
      report.add('POINT_OUTSIDE_DIFF', where, `point ${i + 1} "${p.title}": endLine is before line`)
      return
    }
    if (p.endLine !== undefined && hunkAt(entry, side, p.endLine)?.id !== start.id) {
      report.add(
        'POINT_OUTSIDE_DIFF',
        where,
        `point ${i + 1} "${p.title}": ${p.path}:${p.line}-${p.endLine} (${side}) crosses out of ${start.id} (${hunkLineRanges(entry.hunks, side)})`
      )
    }
  })
}

/** One link, parsed and resolved against the artifact; a problem reads as one line. */
function checkLink(report: Report, targets: LinkTargets, where: string, label: string, href: string): void {
  const parsed = parseLink(href)
  if (parsed === null) {
    report.add('LINK_UNRESOLVED', where, `${label}: ${href} is not one of the four link forms`)
    return
  }
  const resolved = resolveLink(parsed, targets)
  if (!resolved.ok) {
    report.add('LINK_UNRESOLVED', where, `${label}: ${href} ${resolved.message}`)
  }
}

function checkLinks(output: ModelOutput, files: readonly FileEntry[], report: Report): void {
  const targets: LinkTargets = { layers: output.layers, files }
  const check = (where: string, label: string, text: string | undefined): void => {
    for (const href of extractLinks(text ?? '')) {
      checkLink(report, targets, where, label, href)
    }
  }
  check('summary', 'summary', output.summary)
  for (const layer of output.layers) {
    const where = `layer:${layer.key}`
    const label = layerLabel(layer)
    check(where, `${label} rationale`, layer.rationale)
    check(where, `${label} decisions`, layer.decisions)
    check(where, `${label} checkByHand`, layer.checkByHand)
    for (const t of layer.tests) {
      check(where, `${label} test "${t.behavior}"`, t.note)
    }
    for (const file of layer.files) {
      check(where, `${label} ${file.path} note`, file.note)
      file.annotations.forEach((a, i) => {
        check(where, `${label} ${file.path} annotation ${i + 1}`, a.text)
      })
    }
  }
  output.points.forEach((p, i) => {
    check(`point:${i + 1}`, `point ${i + 1} "${p.title}"`, p.body)
  })
}

/**
 * The sidecar map of a layer's diagram: each key names a node of the mermaid source, each value
 * is a canvas link, and a diagram carries at most `maxDiagramLinks` of them.
 */
function checkDiagramLinks(
  output: ModelOutput,
  files: readonly FileEntry[],
  limits: Limits,
  report: Report
): void {
  const targets: LinkTargets = { layers: output.layers, files }
  for (const layer of output.layers) {
    if (layer.diagram === undefined) {
      continue
    }
    const where = `layer:${layer.key}`
    const label = `${layerLabel(layer)} diagram`
    const entries = Object.entries(layer.diagram.links)
    if (entries.length > limits.maxDiagramLinks) {
      report.add(
        'DIAGRAM_LIMIT',
        where,
        `${label}: ${entries.length} node links, at most ${limits.maxDiagramLinks}`
      )
    }
    const kind = diagramKind(layer.diagram.mermaid)
    const nodes = diagramNodeIds(layer.diagram.mermaid)
    for (const [nodeId, href] of entries) {
      if (!nodes.has(nodeId)) {
        const what = kind === '' ? 'the source' : `the ${kind} source`
        report.add('DIAGRAM_NODE_UNKNOWN', where, `${label}: "${nodeId}" is not a node of ${what}`)
      }
      checkLink(report, targets, where, `${label} node "${nodeId}"`, href)
    }
  }
}

/**
 * Schema first (a shape failure ends the run, since the rules need a well-formed output; raw text
 * past the hard limit counts as one), then the caps on the visible text and the layering rules
 * against the hunk index, all reported in one round.
 */
export function validateModelOutput(raw: unknown, input: ValidationInput): ValidationResult {
  const parsed = modelOutputSchema(input.caps).safeParse(raw)
  if (!parsed.success) {
    return { ok: false, errors: schemaErrors(raw, parsed.error.issues), output: null }
  }
  const output = parsed.data
  const report = new Report()
  checkLengths(output, input.caps, report)
  checkDiagrams(output, input.caps, input.limits, report)
  const index = indexFiles(input.files)
  checkHunks(output, index, report)
  checkLayers(output, report)
  checkTests(output, index, input.headPaths ?? new Set(), input.testPatterns ?? DEFAULT_TEST_PATTERNS, report)
  checkRisk(output, input.highRisk, report)
  checkAnnotations(output, index, report)
  for (const error of validateFolds(output, input.files, {
    testPatterns: input.testPatterns ?? DEFAULT_TEST_PATTERNS,
    storedArtifact: input.storedArtifact === true,
  })) {
    report.add(error.code, error.where ?? 'folds', error.message)
  }
  checkPoints(output, index, input.limits, report)
  checkLinks(output, input.files, report)
  checkDiagramLinks(output, input.files, input.limits, report)
  return report.errors.length === 0
    ? { ok: true, errors: [], output }
    : { ok: false, errors: report.errors, output: null }
}
