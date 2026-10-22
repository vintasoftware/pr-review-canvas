// `pr-review publish`: validate model.json against context.json, normalize, and store the
// canvas, then share it on the PR/MR. Invalid models are never stored or shared.
import { shareCanvasOnPr } from '../canvas/share.js'
import type { CanvasSharing } from '../contract/self-review.js'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import { type GenerationContext, GenerationContextSchema } from '../contract/generation-context.js'
import type { Generator, ReopenedDecision, ReviewArtifact, Settlement } from '../contract/review-artifact.js'
import { UNCOMMITTED_STATE, resolveLocalHead } from '../git/local-target.js'
import type { ValidationError, ValidationReport } from '../contract/validation.js'
import { fetchPrRefs } from '../git/pr-refs.js'
import type { AppContext } from '../server/context.js'
import { readJson, readText } from '../store/atomic-json.js'
import { standsForHead } from './carry-over.js'
import { normalize } from './normalize.js'
import { keptReopens, keptSettlements } from './self-review.js'
import { coveredTestPaths, type ValidationInput, validateModelOutput } from './validate.js'

export interface PublishOptions {
  agent: string
  model?: string | undefined
  harness: Generator['harness']
  allowStale: boolean
  /** False keeps the canvas off the pull request whatever the sharing settings say. */
  share?: boolean | undefined
}

export interface PublishResult {
  status: 'published'
  headSha: string
  reviewJsonPath: string
  attempts: number
  sharing: CanvasSharing | { status: 'local' }
  /** Where the canvas shows once the server runs; absent only for a `--base/--head` change set. */
  reviewUrl?: string
}

/** The report of a failed publish. The CLI prints one line per error and exits 5. */
export class ModelInvalidError extends Error {
  readonly report: ValidationReport
  readonly attempts: number

  constructor(report: ValidationReport, attempts: number) {
    super(`model.json has ${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`)
    this.name = 'ModelInvalidError'
    this.report = report
    this.attempts = attempts
  }
}

type PublishErrorCode = 'NOT_FOUND' | 'CANVAS_STALE' | 'CANVAS_ELSEWHERE'

export class PublishError extends Error {
  readonly code: PublishErrorCode
  readonly hint: string

  constructor(code: PublishErrorCode, message: string, hint: string) {
    super(message)
    this.name = 'PublishError'
    this.code = code
    this.hint = hint
  }
}

export async function readContext(canvasDir: string): Promise<GenerationContext> {
  const context = await readJson(path.join(canvasDir, 'context.json'), GenerationContextSchema)
  if (context === null) {
    throw new PublishError('NOT_FOUND', `${canvasDir} has no context.json`, 'run `pr-review prepare` first')
  }
  return context
}

/** The file's JSON, or the one SCHEMA error that says it is not JSON. */
export function parseModelText(text: string, name: string): { raw: unknown } | { error: ValidationError } {
  try {
    return { raw: JSON.parse(text) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { error: { code: 'SCHEMA', where: '(root)', message: `${name} is not valid JSON: ${reason}` } }
  }
}

async function readModel(canvasDir: string): Promise<{ raw: unknown } | { error: ValidationError }> {
  const file = path.join(canvasDir, 'model.json')
  const text = await readText(file)
  if (text === null) {
    throw new PublishError(
      'NOT_FOUND',
      `${file} does not exist`,
      'write the model output there and publish again'
    )
  }
  return parseModelText(text, 'model.json')
}

/**
 * The current head of the target; a push, or a move to another base branch, during generation
 * makes the prepared context stale. For a pull request whose head or base branch moved, the head
 * and base are fetched again, and a diff identical to the prepared one still counts as it. For a
 * local target the working tree is snapshotted again, so an edit made while the agent worked is
 * caught the same way a push is.
 */
export async function currentHead(
  ctx: AppContext,
  context: Pick<GenerationContext, 'target' | 'headSha' | 'mergeBaseSha' | 'pr'>
): Promise<{ headSha: string; moved: boolean }> {
  if (context.target.kind === 'pr') {
    const { host, repo } = ctx.config
    const meta = await host.fetchPrMeta(ctx.gh, repo, context.target.number)
    if (meta.headSha === context.headSha && meta.baseRef === context.pr.baseRef) {
      return { headSha: meta.headSha, moved: false }
    }
    if (meta.headSha !== context.headSha && !ctx.projectConfig.config.canvas.keepForIdenticalDiff) {
      return { headSha: meta.headSha, moved: true }
    }
    const head = await fetchPrRefs(ctx.git, host, meta)
    return { headSha: head.headSha, moved: !(await standsForHead(ctx, head, context)) }
  }
  const headSha =
    context.target.kind === 'local'
      ? (await resolveLocalHead(ctx.git, context.target.source)).headSha
      : await ctx.git.revParse(context.target.head)
  return { headSha, moved: headSha !== context.headSha }
}

/** Publish runs since prepare last wrote a context (its `prepared` line), this one included. */
export function attemptsSincePrepare(log: string): number {
  const lines = log.split('\n').filter(l => l !== '')
  const lastPrepared = lines.map(l => l.split(' ')[1] === 'prepared').lastIndexOf(true)
  return lines.length - (lastPrepared + 1)
}

/**
 * Appends one line for this publish run and returns its attempt number. Every field is named, so
 * the file reads without the code: `<time> published attempts=2` and
 * `<time> invalid attempts=1 errors=2 TEXT_TOO_LONG,HUNK_UNASSIGNED`.
 */
export async function recordAttempt(
  file: string,
  now: string,
  result: { ok: boolean; errors: ReadonlyArray<{ code: string }> }
): Promise<number> {
  const attempts = attemptsSincePrepare((await readText(file)) ?? '') + 1
  const codes = result.errors.map(e => e.code).join(',')
  const line = result.ok
    ? `${now} published attempts=${attempts}`
    : `${now} invalid attempts=${attempts} errors=${result.errors.length}${codes === '' ? '' : ` ${codes}`}`
  await appendFile(file, `${line}\n`, 'utf8')
  return attempts
}

/**
 * The validator's input for one canvas. `covered` test paths outside the diff are looked up at the
 * PR head through git, so an untouched test file that covers the change counts as present.
 */
export async function validationInput(
  ctx: AppContext,
  context: GenerationContext,
  raw: unknown
): Promise<ValidationInput> {
  const inDiff = new Set(context.files.map(f => f.path))
  const headPaths = new Set<string>()
  for (const p of coveredTestPaths(raw)) {
    if (!(inDiff.has(p) || headPaths.has(p)) && (await ctx.git.blobSize(context.headSha, p)) !== null) {
      headPaths.add(p)
    }
  }
  return {
    files: context.files,
    patches: (await ctx.derived.ensure(context)).patches,
    caps: context.caps,
    limits: context.limits,
    highRisk: context.highRisk,
    headPaths,
    testPatterns: context.tests.patterns,
  }
}

export function buildManifest(
  context: GenerationContext,
  artifact: ReviewArtifact,
  version: string
): CanvasManifest {
  const manifest: CanvasManifest = {
    formatVersion: 1,
    tool: { name: 'pr-review', version },
    repo: context.repo,
    headSha: context.headSha,
    mergeBaseSha: context.mergeBaseSha,
    baseRef: context.pr.baseRef,
    headRef: context.pr.headRef,
    generatedAt: artifact.generatedAt,
    generator: artifact.generator,
  }
  if (context.target.kind === 'pr') {
    manifest.prNumber = context.target.number
  }
  return manifest
}

/**
 * What the author did on the canvas that still applies to this one: the settlements and reopened
 * decisions of the canvas `prepare` took the resolutions from, read again now, under the points this
 * canvas still has. A context written before that canvas was recorded reads the basis canvas, or
 * the one this run replaces.
 */
async function answersToKeep(
  ctx: AppContext,
  context: GenerationContext,
  artifact: ReviewArtifact
): Promise<{ settled: Record<string, Settlement>; reopened: Record<string, ReopenedDecision> }> {
  const sha = context.resolutions?.canvasSha ?? context.basis?.canvasSha ?? context.headSha
  // A canvas in a format this version no longer reads has no settlement it could keep.
  const source = await ctx.canvases.readArtifact(sha).catch(() => null)
  return { settled: keptSettlements(artifact, source), reopened: keptReopens(artifact, source) }
}

export async function publish(
  ctx: AppContext,
  canvasDir: string,
  opts: PublishOptions
): Promise<PublishResult> {
  const context = await readContext(canvasDir)
  // The canvas is stored by the data dir, not by the directory given: if they disagree, the
  // canvas would land in another data dir than the one it was prepared in.
  const storedDir = ctx.canvases.canvasDir(context.headSha)
  if (path.resolve(canvasDir) !== storedDir) {
    throw new PublishError(
      'CANVAS_ELSEWHERE',
      `${canvasDir} is not the canvas dir of ${context.headSha.slice(0, 7)} in ${ctx.config.dataDir}; publishing would write ${storedDir}`,
      'publish the canvasDir prepare printed, with the --data-dir prepare used or none'
    )
  }
  if (!opts.allowStale) {
    const head = await currentHead(ctx, context)
    if (head.moved) {
      throw new PublishError(
        'CANVAS_STALE',
        head.headSha === context.headSha
          ? `the pull request moved to another base while this canvas was prepared for ${context.headSha.slice(0, 7)}`
          : `the target moved to ${head.headSha.slice(0, 7)} while this canvas was prepared for ${context.headSha.slice(0, 7)}`,
        'run `pr-review prepare` again, or pass --allow-stale to publish for the old commit'
      )
    }
  }
  const model = await readModel(canvasDir)
  const result =
    'error' in model
      ? { ok: false, errors: [model.error], output: null }
      : validateModelOutput(model.raw, await validationInput(ctx, context, model.raw))
  const now = ctx.now().toISOString()
  const attempts = await recordAttempt(path.join(canvasDir, 'publish.log'), now, result)
  if (!result.ok || result.output === null) {
    throw new ModelInvalidError({ ok: false, errors: result.errors }, attempts)
  }
  const generator: Generator = { agent: opts.agent, harness: opts.harness, attempts }
  if (opts.model !== undefined) {
    generator.model = opts.model
  }
  const artifact = normalize(result.output, {
    pr: context.pr,
    files: context.files,
    patches: (await ctx.derived.ensure(context)).patches,
    highRisk: context.highRisk,
    caps: context.caps,
    generatedAt: now,
    generator,
    testPatterns: context.tests.patterns,
    basisCanvasSha: context.basis?.canvasSha,
    decisions: context.decisions,
  })
  // A resolution the author wrote on a canvas stands over a decision's own words. One an earlier
  // publish took from a commit does not: the decisions read now are the current ones. A decision
  // the author reopened stays open until a later commit answers it again.
  const kept = await answersToKeep(ctx, context, artifact)
  const writtenOnCanvas = Object.entries(kept.settled).filter(
    ([, settlement]) => settlement.commit === undefined
  )
  const settled = Object.fromEntries(
    Object.entries({ ...artifact.settled, ...Object.fromEntries(writtenOnCanvas) }).filter(
      ([fp]) => kept.reopened[fp] === undefined
    )
  )
  if (Object.keys(settled).length > 0) {
    artifact.settled = settled
  } else {
    delete artifact.settled
  }
  if (Object.keys(kept.reopened).length > 0) {
    artifact.reopened = kept.reopened
  }
  const manifest = buildManifest(context, artifact, ctx.version)
  // A snapshot commit is on no branch, so it must never be offered as a pull request's canvas.
  const worktree = context.target.kind === 'local' && context.pr.state === UNCOMMITTED_STATE
  await ctx.canvases.write(context.headSha, artifact, manifest, manifest.prNumber, { worktree })
  if (worktree) {
    // The snapshot ref moves with the working tree. This canvas stays, and the page reads its
    // diffs from its own commit, so it gets an anchor that the next edit cannot take away.
    await ctx.git.anchorCommit(context.headSha)
  }
  const published: PublishResult = {
    status: 'published',
    sharing: { status: 'local' },
    headSha: context.headSha,
    reviewJsonPath: path.join(ctx.canvases.canvasDir(context.headSha), 'review.json'),
    attempts,
  }
  if (context.target.kind === 'local') {
    published.reviewUrl = `http://localhost:${ctx.config.port}${ctx.config.basePath}review/${context.target.source}`
  }
  if (context.target.kind === 'pr') {
    published.reviewUrl = `http://localhost:${ctx.config.port}${ctx.config.basePath}review/${context.target.number}`
    published.sharing =
      opts.share === false
        ? { status: 'off' }
        : await shareCanvasOnPr(ctx, context.headSha, context.target.number)
  }
  return published
}
