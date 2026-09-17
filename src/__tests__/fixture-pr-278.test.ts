// @vitest-environment node
// The committed PR #278 canvas is the reference example of the contract. These checks are the
// layering rules the validator enforces, applied to the fixture by hand, plus a comparison of its
// file list against the live diff when the PR head is in the local clone.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { extractLinks, parseLink, resolveLink } from '../contract/links.js'
import {
  LIMITS,
  POINT_KINDS,
  type ReviewArtifact,
  ReviewArtifactSchema,
  TEXT_CAPS,
} from '../contract/review-artifact.js'
import { collectDiffs, toFileEntry } from '../git/diff-collector.js'
import { createGit } from '../git/git.js'
import { chunkForLine } from '../git/patch-lines.js'
import { diagramNodeIds } from '../review/diagram-nodes.js'
import { PACKAGE_ROOT } from '../server/context.js'

const FIXTURE_DIR = path.join(PACKAGE_ROOT, '__fixtures__', 'pr-278')
const REPO_ROOT = PACKAGE_ROOT

const artifact: ReviewArtifact = ReviewArtifactSchema.parse(
  JSON.parse(await readFile(path.join(FIXTURE_DIR, 'review.json'), 'utf8'))
)
const git = createGit(REPO_ROOT)
const liveHead = await git.revParse('refs/pr/278/head').catch(() => null)
const liveDiffAvailable =
  liveHead === artifact.pr.headSha && (await git.commitExists(artifact.pr.mergeBaseSha))

const isTestPath = (p: string): boolean => /(\.test\.|\.spec\.|__tests__\/)/.test(p)

describe('PR #278 fixture', () => {
  it('describes PR 278 at the recorded head with unique chunk ids', () => {
    expect(artifact.pr.number).toBe(278)
    expect(artifact.pr.headSha).toBe('b8d1e6bf717aeab6c113cc9855e79fb49355760a')
    const ids = artifact.files.flatMap(f => f.chunks.map(h => h.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('puts every chunk in exactly one layer', () => {
    const seen = new Map<string, string>()
    for (const layer of artifact.layers) {
      for (const f of layer.files) {
        for (const id of f.chunks) {
          expect(seen.has(id), `${id} appears in ${seen.get(id)} and ${layer.key}`).toBe(false)
          seen.set(id, layer.key)
        }
      }
    }
    const allIds = artifact.files.flatMap(f => f.chunks.map(h => h.id))
    expect([...seen.keys()].sort()).toEqual([...allIds].sort())
  })

  it('has one Other layer, last, with no test files in it', () => {
    const others = artifact.layers.filter(l => l.kind === 'other')
    expect(others).toHaveLength(1)
    expect(artifact.layers[artifact.layers.length - 1]?.kind).toBe('other')
    expect(others[0]?.files.filter(f => f.isTest)).toEqual([])
  })

  it('marks test files by path and keeps them after the code they cover in every layer', () => {
    for (const layer of artifact.layers) {
      let sawTest = false
      for (const f of layer.files) {
        expect(f.isTest).toBe(isTestPath(f.path))
        if (f.isTest) {
          sawTest = true
        } else {
          expect(sawTest, `${layer.key}: ${f.path} comes after a test file`).toBe(false)
        }
      }
    }
  })

  it('has two to eight semantic layers with unique keys, and a header risk union taken from them', () => {
    const semantic = artifact.layers.filter(l => l.kind !== 'other')
    expect(semantic.length).toBeGreaterThanOrEqual(2)
    expect(semantic.length).toBeLessThanOrEqual(8)
    expect(new Set(artifact.layers.map(l => l.key)).size).toBe(artifact.layers.length)
    // The header lists the union of the layer tags, so no tag is invented and none is dropped.
    const fromLayers = new Set(artifact.layers.flatMap(l => l.risk.map(r => r.label)))
    expect(new Set(artifact.risk.map(r => r.label))).toEqual(fromLayers)
    expect(artifact.risk.map(r => r.label).length).toBe(fromLayers.size)
    expect(artifact.layers.find(l => l.kind === 'other')?.risk).toEqual([])
  })

  it('keeps the summary as plain prose and each layer down to a rationale, with judgment in the points', () => {
    expect(artifact.summary).not.toMatch(/^#/m)
    expect(artifact.summary.length).toBeLessThanOrEqual(TEXT_CAPS.summary)
    // The surfacing format carries decisions and manual checks as attention points, so the layer
    // fields of the same name stay empty and each item is explained in one place.
    for (const layer of artifact.layers) {
      expect(layer.decisions, layer.key).toBeUndefined()
      expect(layer.checkByHand, layer.key).toBeUndefined()
      expect(layer.rationale.length, layer.key).toBeGreaterThan(0)
    }
    for (const point of artifact.points) {
      expect(
        artifact.layers.some(l => l.id === point.layerId),
        point.id
      ).toBe(true)
    }
  })

  it('draws one lifecycle diagram, within the cap, with states linked to the code', () => {
    const drawn = artifact.layers.filter(l => l.diagram !== undefined)
    // One diagram in the canvas, on a semantic layer. Which layer earns it is the model's call.
    expect(drawn).toHaveLength(1)
    expect(drawn[0]?.kind).toBe('layer')
    const diagram = drawn[0]?.diagram
    expect(diagram?.mermaid.startsWith('stateDiagram-v2\n')).toBe(true)
    expect(diagram?.mermaid.length).toBeLessThanOrEqual(TEXT_CAPS.diagram)
    const links = Object.entries(diagram?.links ?? {})
    expect(links.length).toBeGreaterThanOrEqual(2)
    expect(links.length).toBeLessThanOrEqual(LIMITS.maxDiagramLinks)
    const nodes = diagramNodeIds(diagram?.mermaid ?? '')
    for (const [nodeId, href] of links) {
      expect(nodes.has(nodeId), nodeId).toBe(true)
      const parsed = parseLink(href)
      expect(parsed, href).not.toBeNull()
      if (parsed) {
        expect(resolveLink(parsed, artifact), href).toEqual({ ok: true })
      }
    }
    // No fenced diagram anywhere else: one source, the `diagram` field.
    const texts = [
      artifact.summary,
      ...artifact.layers.flatMap(l => [l.rationale, l.decisions, l.checkByHand]),
    ]
    expect(texts.filter(t => t?.includes('```mermaid'))).toEqual([])
  })

  it('keeps every test map entry consistent: covered needs a real test path, missing yields a tests-kind point', () => {
    const paths = new Set(artifact.files.map(f => f.path))
    const missing = artifact.layers.flatMap(l => l.tests.filter(t => t.status === 'missing'))
    for (const layer of artifact.layers) {
      for (const t of layer.tests) {
        if (t.status === 'covered') {
          expect(t.testPath, `${layer.key}: ${t.behavior}`).toBeDefined()
          expect(paths.has(t.testPath ?? '')).toBe(true)
          expect(isTestPath(t.testPath ?? '')).toBe(true)
        }
      }
    }
    expect(artifact.points.filter(p => p.origin === 'tests')).toHaveLength(missing.length)
  })

  it('anchors every attention point and annotation inside a chunk of its layer', () => {
    const byPath = new Map(artifact.files.map(f => [f.path, f]))
    expect(artifact.points.length).toBeGreaterThanOrEqual(6)
    expect(artifact.points.length).toBeLessThanOrEqual(LIMITS.maxPoints)
    // The mix of kinds follows the diff; the contract only fixes the vocabulary and the levels.
    expect(artifact.points.every(p => (POINT_KINDS as readonly string[]).includes(p.kind))).toBe(true)
    expect(new Set(artifact.points.map(p => p.kind)).size).toBeGreaterThanOrEqual(2)
    expect(new Set(artifact.points.map(p => p.level))).toEqual(new Set(['decide', 'check', 'fyi']))
    for (const p of artifact.points) {
      const file = byPath.get(p.path)
      expect(file, p.path).toBeDefined()
      const chunk = chunkForLine(file?.chunks ?? [], p.side ?? 'new', p.line)
      expect(chunk, `${p.id} ${p.path}:${p.line}`).not.toBeNull()
      const layer = artifact.layers.find(l => l.id === p.layerId)
      expect(
        layer?.files.some(f => f.chunks.includes(chunk?.id ?? '')),
        `${p.id} layer ${p.layerId}`
      ).toBe(true)
      expect(new Set(artifact.points.map(x => x.fingerprint)).size).toBe(artifact.points.length)
    }
    for (const layer of artifact.layers) {
      for (const f of layer.files) {
        const entry = byPath.get(f.path)
        for (const a of f.annotations) {
          const start = chunkForLine(entry?.chunks ?? [], a.side, a.startLine)
          const end = chunkForLine(entry?.chunks ?? [], a.side, a.endLine)
          expect(start?.id, `${f.path}:${a.startLine}`).toBeDefined()
          expect(end?.id).toBe(start?.id)
          expect(f.chunks).toContain(start?.id)
        }
      }
    }
  })

  it('resolves every link in summary, rationales, decisions, check-by-hand, notes, annotations, and point bodies', () => {
    const texts: string[] = [artifact.summary]
    for (const layer of artifact.layers) {
      texts.push(layer.rationale, layer.decisions ?? '', layer.checkByHand ?? '')
      for (const f of layer.files) {
        texts.push(f.note ?? '', ...f.annotations.map(a => a.text))
      }
      texts.push(...layer.tests.map(t => t.note ?? ''))
    }
    texts.push(...artifact.points.map(p => p.body))
    const links = texts.flatMap(extractLinks)
    expect(links.length).toBeGreaterThanOrEqual(5)
    for (const href of links) {
      const parsed = parseLink(href)
      expect(parsed, href).not.toBeNull()
      if (parsed) {
        expect(resolveLink(parsed, artifact), href).toEqual({ ok: true })
      }
    }
  })

  it.skipIf(!liveDiffAvailable)(
    'lists exactly the files and chunks of the live diff of refs/pr/278/head',
    async () => {
      const live = (await collectDiffs(git, artifact.pr.mergeBaseSha, artifact.pr.headSha)).map(toFileEntry)
      expect(live).toEqual(artifact.files)
    }
  )
})
