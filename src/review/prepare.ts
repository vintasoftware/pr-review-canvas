// `pr-review prepare`: fetch the target, build derived/, and write prompt.md + context.json into
// the canvas directory. The agent reads those two files; publish reads context.json back.
import { appendFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { type GenerationContext, isLargePr, type PrepareTarget } from '../contract/generation-context.js'
import { effectiveCaps, LIMITS, type Pr } from '../contract/review-artifact.js'
import { fetchPrRefs } from '../git/pr-refs.js'
import { toPr } from '../host/pr.js'
import type { AppContext } from '../server/context.js'
import { readText, writeJsonAtomic, writeTextAtomic } from '../store/atomic-json.js'
import { loadPromptSources, type PromptSources, renderPrompt } from './prompt.js'

export interface PrepareOptions {
  force: boolean
  /** Progress lines: `fetch-pr`, `fetch-refs`, `collect-diffs`, `prompt`. */
  log: (phase: string) => void
  promptSources?: PromptSources
}

export interface PrepareResult {
  canvasDir: string
  headSha: string
  mergeBaseSha: string
  promptPath: string
  contextPath: string
  status: 'prepared' | 'exists'
}

/** The PR meta, live from GitHub, with the head and base refs fetched into the local clone. */
async function resolvePr(ctx: AppContext, number: number, log: PrepareOptions['log']): Promise<Pr> {
  log('fetch-pr')
  const meta = await ctx.config.host.fetchPrMeta(ctx.gh, ctx.config.repo, number)
  log('fetch-refs')
  const shas = await fetchPrRefs(ctx.git, ctx.config.host, meta)
  const pr = toPr(meta, ctx.config.repo, shas)
  await ctx.prs.writePr(pr)
  return pr
}

/** A change set before a PR exists: the refs must already be in the clone. */
async function resolveRefs(
  ctx: AppContext,
  base: string,
  head: string,
  log: PrepareOptions['log']
): Promise<Pr> {
  log('fetch-refs')
  const headSha = await ctx.git.revParse(head)
  const mergeBaseSha = await ctx.git.mergeBase(base, headSha)
  const author = await ctx.git.commitAuthor(headSha)
  const repo = ctx.config.repo
  return {
    number: null,
    title: head,
    body: '',
    author,
    url: ctx.config.host.compareUrl(repo, base, head),
    state: 'pre-pr',
    draft: false,
    updatedAt: ctx.now().toISOString(),
    baseRef: base,
    headRef: head,
    headSha,
    mergeBaseSha,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    repo,
  }
}

async function readRulebook(ctx: AppContext): Promise<GenerationContext['rulebook']> {
  const rel = ctx.projectConfig.config.rulebook
  if (rel === undefined) {
    return { path: null, text: null }
  }
  const text = await readText(path.resolve(ctx.config.repoRoot, rel))
  return { path: rel, text }
}

/**
 * Files an earlier run left behind (model.json, agent logs, scratch) go. The published canvas
 * (review.json, manifest.json) stays until publish replaces it atomically, so the page and the
 * index keep serving the old canvas while the agent works; derived/ and the log stay too.
 */
export const KEPT_ON_PREPARE = new Set(['derived', 'publish.log', 'review.json', 'manifest.json'])

async function clearCanvasDir(canvasDir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(canvasDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!KEPT_ON_PREPARE.has(name)) {
      await rm(path.join(canvasDir, name), { recursive: true, force: true })
    }
  }
}

export async function prepare(
  ctx: AppContext,
  target: PrepareTarget,
  opts: PrepareOptions
): Promise<PrepareResult> {
  const pr =
    target.kind === 'pr'
      ? await resolvePr(ctx, target.number, opts.log)
      : await resolveRefs(ctx, target.base, target.head, opts.log)
  const canvasDir = ctx.canvases.canvasDir(pr.headSha)
  const promptPath = path.join(canvasDir, 'prompt.md')
  const contextPath = path.join(canvasDir, 'context.json')
  const result = {
    canvasDir,
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
    promptPath,
    contextPath,
  }
  if (!opts.force && (await ctx.canvases.exists(pr.headSha))) {
    return { ...result, status: 'exists' }
  }

  opts.log('collect-diffs')
  const derived = await ctx.derived.ensure(pr.headSha, pr.mergeBaseSha)
  const additions = derived.files.reduce((n, f) => n + f.additions, 0)
  const deletions = derived.files.reduce((n, f) => n + f.deletions, 0)
  const fullPr: Pr =
    target.kind === 'pr' ? pr : { ...pr, additions, deletions, changedFiles: derived.files.length }
  const derivedDir = ctx.derived.derivedDir(pr.headSha)
  const config = ctx.projectConfig.config

  opts.log('prompt')
  const context: GenerationContext = {
    version: 1,
    target,
    repo: ctx.config.repo,
    pr: fullPr,
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
    canvasDir,
    paths: {
      head: path.join(derivedDir, 'head'),
      base: path.join(derivedDir, 'base'),
      patches: path.join(derivedDir, 'patches'),
      model: path.join(canvasDir, 'model.json'),
    },
    files: derived.files,
    defaultLayers: config.layers,
    rulebook: await readRulebook(ctx),
    highRisk: config.highRisk,
    caps: effectiveCaps(config.generation.caps),
    limits: { ...LIMITS },
    generation: {
      mode: config.generation.mode,
      maxRepairRounds: config.generation.maxRepairRounds,
      inlineDiffMaxLines: config.generation.inlineDiffMaxLines,
      smallPrHunks: config.generation.smallPrHunks,
    },
    tests: { patterns: config.tests.patterns },
    smallPr: derived.files.reduce((n, f) => n + f.hunks.length, 0) <= config.generation.smallPrHunks,
    largePr: isLargePr({ files: derived.files.length, additions, deletions }),
    preparedAt: ctx.now().toISOString(),
  }
  const sources =
    opts.promptSources ??
    (await loadPromptSources(undefined, {
      repoRoot: ctx.config.repoRoot,
      overrides: ctx.projectConfig.config.prompts,
    }))
  await clearCanvasDir(canvasDir)
  await writeTextAtomic(promptPath, renderPrompt(context, derived.patches, sources))
  await writeJsonAtomic(contextPath, context)
  // The log keeps the whole history; publish counts attempts from this line on.
  await appendFile(
    path.join(canvasDir, 'publish.log'),
    `${context.preparedAt} prepared ${pr.headSha}\n`,
    'utf8'
  )
  return { ...result, status: 'prepared' }
}
