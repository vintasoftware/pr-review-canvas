import type { CanvasInfo, PrBundle, SharedCanvasInfo, StaleInfo } from '../contract/api.js'
import type { CommentsPayload } from '../contract/comments.js'
import { isLargePr } from '../contract/generation-context.js'
import type { FileEntry, Pr, ReviewArtifact } from '../contract/review-artifact.js'
import { fetchPrRefs } from '../git/pr-refs.js'
import { toPr } from '../host/pr.js'
import { type CanvasResolution, resolveCanvas, reviewStateFor } from '../review/canvas-lookup.js'
import { discoverSharedCanvas, discoveryFingerprint } from '../host/attachments.js'
import { buildSkillCommand } from '../review/skill-command.js'
import type { AppContext } from './context.js'
import { AppError } from './errors.js'

export interface BundleOptions {
  refresh: boolean
}

export interface DiscoveryRun {
  sharedCanvas: SharedCanvasInfo | null
  imported: boolean
  warnings: string[]
}

/**
 * Scans the pull request for an attached canvas and imports the best one. The scan is skipped
 * while the PR text is the same as at the last scan, unless the caller asks for a fresh run.
 */
export async function runDiscovery(
  ctx: AppContext,
  pr: Pr,
  comments: CommentsPayload,
  opts: { refresh: boolean }
): Promise<DiscoveryRun> {
  if (pr.number === null) {
    return { sharedCanvas: null, imported: false, warnings: [] }
  }
  const fingerprint = discoveryFingerprint(pr.body, comments, pr.headSha)
  const cached = await ctx.prs.readDiscovery(pr.number)
  if (!opts.refresh && cached !== null && cached.fingerprint === fingerprint) {
    return { sharedCanvas: cached.sharedCanvas, imported: false, warnings: [] }
  }
  const outcome = await discoverSharedCanvas(ctx, pr, comments)
  await ctx.prs.writeDiscovery(pr.number, {
    fingerprint,
    checkedAt: ctx.now().toISOString(),
    sharedCanvas: outcome.sharedCanvas,
  })
  return {
    sharedCanvas: outcome.sharedCanvas,
    imported: outcome.imported !== null,
    warnings: outcome.warnings,
  }
}

/**
 * Live PR meta and comments. The first request for a PR in this process always asks GitHub;
 * later ones answer from `prs/<n>/` unless `refresh` is set, so polling stays cheap.
 */
export function createPrLoader(ctx: AppContext) {
  const refreshed = new Set<number>()

  async function refreshPr(
    number: number
  ): Promise<{ pr: Pr; comments: CommentsPayload; warnings: string[] }> {
    const { host, repo } = ctx.config
    const meta = await host.fetchPrMeta(ctx.gh, repo, number)
    const shas = await fetchPrRefs(ctx.git, host, meta)
    const pr = toPr(meta, repo, shas)
    await ctx.prs.writePr(pr)
    const { payload, warnings } = await host.fetchComments(ctx.gh, repo, number, shas.headSha, ctx.now)
    await ctx.prs.writeComments(number, payload)
    refreshed.add(number)
    return { pr, comments: payload, warnings }
  }

  return {
    async load(
      number: number,
      opts: BundleOptions
    ): Promise<{ pr: Pr; comments: CommentsPayload; warnings: string[] }> {
      if (!opts.refresh && refreshed.has(number)) {
        const [pr, comments] = await Promise.all([ctx.prs.readPr(number), ctx.prs.readComments(number)])
        if (pr !== null && comments !== null) {
          return { pr, comments, warnings: [] }
        }
      }
      return refreshPr(number)
    },
    async refreshComments(number: number): Promise<{ comments: CommentsPayload; warnings: string[] }> {
      const pr = (await ctx.prs.readPr(number)) ?? (await refreshPr(number)).pr
      const { host, repo } = ctx.config
      const { payload, warnings } = await host.fetchComments(ctx.gh, repo, number, pr.headSha, ctx.now)
      await ctx.prs.writeComments(number, payload)
      return { comments: payload, warnings }
    },
    async currentPr(number: number): Promise<Pr> {
      return (await ctx.prs.readPr(number)) ?? (await refreshPr(number)).pr
    },
  }
}
export type PrLoader = ReturnType<typeof createPrLoader>

/** Whether the change set on screen is large, counted from the files the page is showing. */
function largePrOf(files: readonly FileEntry[]): boolean {
  return isLargePr({
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  })
}

/** Dev fixture: the committed artifact presented as the canvas of the live PR head. */
export function rekeyFixture(fixture: ReviewArtifact, pr: Pr): ReviewArtifact {
  return { ...fixture, pr, source: 'local' }
}

/**
 * The stored canvas and the block that describes it. Null when review.json was written by an
 * older tool version: the page then offers to generate a new one.
 */
async function loadCanvas(
  ctx: AppContext,
  found: Extract<CanvasResolution, { headSha: string }>
): Promise<{ artifact: ReviewArtifact; canvas: CanvasInfo } | null> {
  let artifact: ReviewArtifact | null
  try {
    artifact = await ctx.canvases.readArtifact(found.headSha)
  } catch {
    return null
  }
  if (artifact === null) {
    throw new AppError('CANVAS_INVALID', `index lists ${found.headSha} but review.json is missing`, 500)
  }
  const canvas: CanvasInfo = {
    headSha: found.headSha,
    source: artifact.source,
    manifest: await ctx.canvases.readManifest(found.headSha),
  }
  if (artifact.importedAt !== undefined) {
    canvas.importedAt = artifact.importedAt
  }
  return { artifact, canvas }
}

export async function resolveBundle(
  ctx: AppContext,
  loader: PrLoader,
  number: number,
  opts: BundleOptions
): Promise<PrBundle> {
  const { pr, comments, warnings } = await loader.load(number, opts)
  const allWarnings = [...ctx.projectConfig.warnings, ...warnings]

  let found = await resolveCanvas(ctx, number, pr)
  const files = found.head?.files ?? []
  if (found.head === null) {
    allWarnings.push('the PR head or merge base is not in the local clone; diffs are not available')
  }

  const chatEnabled = ctx.projectConfig.config.chat.enabled
  const [state, capabilities, settings, acpx] = await Promise.all([
    reviewStateFor(ctx, number, pr, found.head),
    ctx.capabilities.get(),
    chatEnabled ? ctx.chat.effectiveSettings() : Promise.resolve(null),
    chatEnabled ? ctx.preflight.get() : Promise.resolve({ installed: false, version: null }),
  ])
  if (chatEnabled && !acpx.installed) {
    allWarnings.push('acpx is not on PATH, so the AI Chat pane is off; install acpx to turn it on')
  }
  const base = {
    pr,
    files,
    derivable: found.head !== null,
    comments,
    state,
    capabilities,
    chat: {
      enabled: chatEnabled && acpx.installed,
      acpx: acpx.installed,
      ...(settings === null ? {} : { agent: settings.agent, model: settings.model }),
    },
    largePr: largePrOf(files),
    warnings: allWarnings,
  }

  if (ctx.fixtureArtifact !== null) {
    const artifact = rekeyFixture(ctx.fixtureArtifact, pr)
    const canvas: CanvasInfo = { headSha: pr.headSha, source: 'fixture', manifest: null }
    allWarnings.push('showing the --fixture-canvas artifact (dev only)')
    return {
      ...base,
      status: 'ready',
      artifact,
      canvas,
      files: files.length > 0 ? files : artifact.files,
      largePr: largePrOf(files.length > 0 ? files : artifact.files),
      skillCommand: buildSkillCommand(number, { force: true }),
    }
  }

  let sharedCanvas: SharedCanvasInfo | null = null
  // A canvas for this very head beats anything attached to the PR, so discovery runs only
  // when there is none, and its import can turn a stale or missing bundle into a ready one.
  if (found.status !== 'ready') {
    const discovery = await runDiscovery(ctx, pr, comments, { refresh: opts.refresh })
    sharedCanvas = discovery.sharedCanvas
    allWarnings.push(...discovery.warnings)
    if (discovery.imported) {
      found = await resolveCanvas(ctx, number, pr)
    }
  }
  const shared = sharedCanvas === null ? {} : { sharedCanvas }

  if (found.status === 'missing') {
    return {
      ...base,
      ...shared,
      status: 'missing',
      skillCommand: buildSkillCommand(number, { force: false }),
    }
  }
  const loaded = await loadCanvas(ctx, found)
  if (loaded === null) {
    allWarnings.push(
      `the canvas for ${found.headSha.slice(0, 7)} does not match the current format; regenerate it`
    )
    return { ...base, ...shared, status: 'missing', skillCommand: buildSkillCommand(number, { force: true }) }
  }
  // A canvas exists for this PR, so regenerating always needs --force.
  const skillCommand = buildSkillCommand(number, { force: true })
  if (found.status === 'ready') {
    // The head's own diffs are on the page, with the canvas that explains the same change set.
    const since = found.commitsSince > 0 ? { commitsSinceCanvas: found.commitsSince } : {}
    return { ...base, ...shared, ...loaded, ...since, status: 'ready', skillCommand }
  }
  const stale: StaleInfo = {
    canvasHeadSha: found.headSha,
    currentHeadSha: pr.headSha,
    relation: found.relation,
    ...(found.relation === 'ancestor' ? { commitsBehind: found.commitsBehind } : {}),
  }
  // The page shows the canvas of the older commit, so the files and the diffs are that commit's,
  // and they decide whether the notice about large change sets belongs on the page. Without the
  // commits in the clone, the artifact's own file list stands in until they arrive.
  const staleFiles = found.diff?.files ?? loaded.artifact.files
  return {
    ...base,
    ...shared,
    ...loaded,
    files: staleFiles,
    largePr: largePrOf(staleFiles),
    derivable: found.diff !== null,
    status: 'stale',
    stale,
    skillCommand,
  }
}
