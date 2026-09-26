import type {
  BundleStatus,
  CanvasInfo,
  Capabilities,
  CarriedOverInfo,
  PrBundle,
  SharedCanvasInfo,
  StaleInfo,
} from '../contract/api.js'
import type { CommentsPayload } from '../contract/comments.js'
import { isLargePr, type LocalPrepareTarget } from '../contract/generation-context.js'
import type { FileEntry, Pr, ReviewArtifact } from '../contract/review-artifact.js'
import { isLocalKey, type LocalKey, type ReviewKey } from '../contract/review-key.js'
import { describeLocalWork, resolveLocalBase } from '../git/local-target.js'
import { fetchPrRefs } from '../git/pr-refs.js'
import { toPr } from '../host/pr.js'
import { lookupCanvas } from '../review/carry-over.js'
import { marksForCanvas } from '../review/carry-marks.js'
import { reviewedCommit, stateForCanvas } from '../review/review-body.js'
import { discoverSharedCanvas, discoveryFingerprint } from '../host/attachments.js'
import { buildSkillCommand } from '../review/skill-command.js'
import type { CanvasLookup } from '../store/canvas-store.js'
import type { AppContext } from './context.js'
import { AppError } from './errors.js'

export interface BundleOptions {
  refresh: boolean
  /**
   * The background poller asked, rather than a reader opening or refreshing the page. A local
   * review answers a poll from the head it last resolved: snapshotting the working tree every few
   * seconds would stat the whole tree again and again, and every edit in between would leave
   * another commit and another `derived/` tree behind it.
   */
  poll?: boolean
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
  /**
   * The head each local review was last resolved at in this process, with the head `prepare` had
   * on file at the time. A poll answers from it, so it can never report a status the page's own
   * load contradicts; a later `prepare` files another head, and that is the one answer a waiting
   * page is polling for, so it resolves again.
   */
  const localHeads = new Map<LocalKey, { head: Pr; preparedSha: string | null }>()

  /** One local review's cached meta, which `prepare` wrote. */
  async function localPr(key: LocalKey): Promise<Pr> {
    const stored = await ctx.prs.readPr(key)
    if (stored === null) {
      throw new AppError(
        'CANVAS_NOT_FOUND',
        `no ${key} review has been prepared in this repository yet`,
        404,
        `run /pr-review-canvas ${key} to generate one`
      )
    }
    return stored
  }

  async function refreshPr(
    number: number
  ): Promise<{ pr: Pr; comments: CommentsPayload; warnings: string[] }> {
    const { host, repo } = ctx.config
    const meta = await host.fetchPrMeta(ctx.gh, repo, number)
    const shas = await fetchPrRefs(ctx.git, host, meta)
    const pr = toPr(meta, repo, shas)
    await ctx.prs.writePr(number, pr)
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
    /**
     * The head a local review describes. Every request but a poll reads the work again, so opening
     * or refreshing the page catches an edit made since the canvas was generated. A poll reads it
     * again only when this process has not resolved a head yet, or when `prepare` has filed one
     * since: the rest of the time it answers about the head the page is showing, at no cost.
     */
    async localHead(key: LocalKey, opts: BundleOptions): Promise<Pr> {
      const stored = await ctx.prs.readPr(key)
      const preparedSha = stored?.headSha ?? null
      const seen = localHeads.get(key)
      if (opts.poll === true && seen !== undefined && seen.preparedSha === preparedSha) {
        return seen.head
      }
      const head = await currentLocalPr(ctx, key, stored)
      localHeads.set(key, { head, preparedSha })
      return head
    },
    /** The head of either kind of target, so the routes both kinds serve need no branch. */
    async currentTarget(key: ReviewKey): Promise<Pr> {
      return isLocalKey(key) ? localPr(key) : ((await ctx.prs.readPr(key)) ?? (await refreshPr(key)).pr)
    },
  }
}
export type PrLoader = ReturnType<typeof createPrLoader>

/** The diffstat of the files the page is showing. */
function countDiff(files: readonly FileEntry[]): {
  additions: number
  deletions: number
  changedFiles: number
} {
  return {
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
  }
}

/** Whether the change set on screen is large, counted from the files the page is showing. */
function largePrOf(files: readonly FileEntry[]): boolean {
  const counts = countDiff(files)
  return isLargePr({ files: counts.changedFiles, ...counts })
}

/** Dev fixture: the committed artifact presented as the canvas of the live PR head. */
export function rekeyFixture(fixture: ReviewArtifact, pr: Pr): ReviewArtifact {
  return { ...fixture, pr, source: 'local' }
}

/**
 * The stored canvas and the block that describes it. Null when review.json was written by an
 * older tool version: the page then offers to generate a new one.
 */
export interface LoadedCanvas {
  artifact: ReviewArtifact
  canvas: CanvasInfo
}

async function loadCanvas(
  ctx: AppContext,
  found: Extract<CanvasLookup, { headSha: string }>
): Promise<LoadedCanvas | null> {
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

/** The shape of an empty comment payload: a local review has no forge thread to read. */
function noComments(headSha: string, now: () => Date): CommentsPayload {
  return { fetchedAt: now().toISOString(), headSha, reviewComments: [], issueComments: [], reviews: [] }
}

/** Posting is a forge operation, and local work is on no forge. The page hides every post button. */
export const LOCAL_CAPABILITIES: Capabilities = {
  canComment: false,
  tokenKind: 'none',
  login: null,
  reason: 'this work is not on a pull request yet, so there is nothing to comment on',
  hint: 'open the pull request, then review it at /review/<number>',
}

/** Which diffs the page shows, and what to say when their commits are not in the clone. */
interface ShownDiff {
  files: FileEntry[]
  derivable: boolean
  warning: string | null
}

/**
 * The diffs of the canvas on screen, which is the one `found` names rather than the target's
 * current head: a stale canvas describes an older commit, and its own files are what the reader
 * is looking at.
 */
async function shownDiff(
  ctx: AppContext,
  pr: Pr,
  found: CanvasLookup,
  loaded: LoadedCanvas | null
): Promise<ShownDiff> {
  const mergeBaseSha = loaded?.canvas.manifest?.mergeBaseSha ?? pr.mergeBaseSha
  const derived = await ctx.derived.readOrBuild(reviewedCommit(found, pr), mergeBaseSha)
  if (derived !== null) {
    return { files: derived.files, derivable: true, warning: null }
  }
  return {
    files: loaded?.artifact.files ?? [],
    derivable: false,
    warning:
      loaded === null
        ? 'the head or merge base is not in the local clone; diffs are not available'
        : 'the commits behind this canvas are not in the clone; diffs are not available',
  }
}

/**
 * The screen a canvas lookup produces: its status, the notice a stale one carries, and the command
 * that regenerates it. Both targets go through this, so neither can drift from the other.
 */
function canvasScreen(
  key: ReviewKey,
  pr: Pr,
  found: CanvasLookup,
  loaded: LoadedCanvas | null
): {
  status: BundleStatus
  skillCommand: string
  stale?: StaleInfo
  carriedOver?: CarriedOverInfo
  warning?: string
} {
  if (found.status === 'missing') {
    return { status: 'missing', skillCommand: buildSkillCommand(key, { force: false }) }
  }
  // A canvas exists for this target, so regenerating always needs --force.
  const skillCommand = buildSkillCommand(key, { force: true })
  if (loaded === null) {
    return {
      status: 'missing',
      skillCommand,
      warning: `the canvas for ${found.headSha.slice(0, 7)} does not match the current format; regenerate it`,
    }
  }
  if (found.status === 'ready') {
    return found.carriedOver === undefined
      ? { status: 'ready', skillCommand }
      : { status: 'ready', skillCommand, carriedOver: found.carriedOver }
  }
  const stale: StaleInfo = {
    canvasHeadSha: found.headSha,
    currentHeadSha: pr.headSha,
    relation: found.relation,
  }
  if (found.relation === 'ancestor') {
    stale.commitsBehind = found.commitsBehind
  }
  return { status: 'stale', skillCommand, stale }
}

/** Everything a bundle holds that does not depend on which canvas was found. */
async function bundleBase(
  ctx: AppContext,
  key: ReviewKey,
  input: {
    pr: Pr
    comments: CommentsPayload
    /** A promise, so probing the forge runs alongside the chat and state reads. */
    capabilities: Promise<Capabilities>
    diff: ShownDiff
    /** The commit of the canvas on screen: the marks the page shows are the ones made on it. */
    canvasSha: string
    /** The canvas on screen, when there is one: marks may follow the line of descent onto it. */
    artifact: ReviewArtifact | null
    warnings: string[]
  }
): Promise<Omit<PrBundle, 'status' | 'skillCommand'>> {
  const chatEnabled = ctx.projectConfig.config.chat.enabled
  const [stored, capabilities, settings, acpx] = await Promise.all([
    ctx.state.read(key),
    input.capabilities,
    chatEnabled ? ctx.chat.effectiveSettings() : Promise.resolve(null),
    chatEnabled ? ctx.preflight.get() : Promise.resolve({ installed: false, version: null }),
  ])
  if (chatEnabled && !acpx.installed) {
    input.warnings.push('acpx is not on PATH, so the AI Chat pane is off; install acpx to turn it on')
  }
  // With no canvas to read, a mark counts only when it was made on this very commit. With one,
  // marks made on a canvas it descends from follow it wherever the diff is untouched.
  const marks =
    input.artifact === null
      ? { state: stateForCanvas(stored, input.canvasSha), carriedFrom: undefined }
      : await marksForCanvas(ctx, input.artifact, input.canvasSha, stored)
  return {
    pr: input.pr,
    files: input.diff.files,
    derivable: input.diff.derivable,
    comments: input.comments,
    state: marks.state,
    ...(marks.carriedFrom === undefined ? {} : { marksCarriedFrom: marks.carriedFrom }),
    capabilities,
    chat: {
      enabled: chatEnabled && acpx.installed,
      acpx: acpx.installed,
      ...(settings === null ? {} : { agent: settings.chatAgent, model: settings.chatModel }),
    },
    largePr: largePrOf(input.diff.files),
    warnings: input.warnings,
  }
}

/**
 * The head the local review describes right now, resolved the way `prepare` would.
 *
 * `source` is what decides whether the working tree is snapshotted, so an unprepared review asks
 * for the branch tip: there is no canvas for a snapshot to be stale against yet, and that screen
 * is the one the page polls until one exists.
 */
async function currentLocalPr(ctx: AppContext, key: LocalKey, stored: Pr | null): Promise<Pr> {
  const target: LocalPrepareTarget | null = await ctx.prs.readLocalTarget(key)
  return describeLocalWork(ctx.git, {
    base: target?.base ?? (await resolveLocalBase(ctx.git, stored?.baseRef)),
    source: stored === null ? 'branch' : (target?.source ?? key),
    repo: ctx.config.repo,
    now: ctx.now,
  })
}

/**
 * The bundle for `/review/branch` and `/review/uncommitted`: the same screen over work that has no
 * pull request. There is no forge side to it, so no comments, no capabilities, no attachment
 * discovery and no import.
 */
export async function resolveLocalBundle(
  ctx: AppContext,
  loader: PrLoader,
  key: LocalKey,
  opts: BundleOptions
): Promise<PrBundle> {
  const head = await loader.localHead(key, opts)
  const warnings = [...ctx.projectConfig.warnings]

  const found = await ctx.canvases.findForLocal(key, head.headSha)
  const loaded = found.status === 'missing' ? null : await loadCanvas(ctx, found)
  const diff = await shownDiff(ctx, head, found, loaded)
  if (diff.warning !== null && loaded !== null) {
    warnings.push(diff.warning)
  }
  const screen = canvasScreen(key, head, found, loaded)
  if (screen.warning !== undefined) {
    warnings.push(screen.warning)
  }
  // Local work is on no forge, so the only diffstat there is is the one in the diff on screen.
  const pr: Pr = { ...head, ...countDiff(diff.files) }
  const base = await bundleBase(ctx, key, {
    pr,
    comments: noComments(pr.headSha, ctx.now),
    capabilities: Promise.resolve(LOCAL_CAPABILITIES),
    diff,
    canvasSha: reviewedCommit(found, pr),
    artifact: loaded?.artifact ?? null,
    warnings,
  })
  const { warning: _screenWarning, ...screenFields } = screen
  return { ...base, local: key, ...(loaded ?? {}), ...screenFields }
}

export async function resolveBundle(
  ctx: AppContext,
  loader: PrLoader,
  number: number,
  opts: BundleOptions
): Promise<PrBundle> {
  const { pr, comments, warnings: fetched } = await loader.load(number, opts)
  const warnings = [...ctx.projectConfig.warnings, ...fetched]
  const capabilities = ctx.capabilities.get()

  if (ctx.fixtureArtifact !== null) {
    const artifact = rekeyFixture(ctx.fixtureArtifact, pr)
    const live = await shownDiff(ctx, pr, { status: 'missing' }, null)
    if (live.warning !== null) {
      warnings.push(live.warning)
    }
    warnings.push('showing the --fixture-canvas artifact (dev only)')
    const diff = live.files.length > 0 ? live : { ...live, files: artifact.files }
    const base = await bundleBase(ctx, number, {
      pr,
      comments,
      capabilities,
      diff,
      canvasSha: pr.headSha,
      artifact: null,
      warnings,
    })
    const canvas: CanvasInfo = { headSha: pr.headSha, source: 'fixture', manifest: null }
    return {
      ...base,
      status: 'ready',
      artifact,
      canvas,
      skillCommand: buildSkillCommand(number, { force: true }),
    }
  }

  let found = await lookupCanvas(ctx, number, pr)
  let sharedCanvas: SharedCanvasInfo | null = null
  // A canvas for this very head beats anything attached to the PR, so an ordinary load runs
  // discovery only when there is none, a carried-over canvas included, and its import can turn a
  // stale, missing, or carried-over bundle into one with the head's own canvas. Refresh runs it
  // whatever was found, to pick up a newer generation at the same head.
  if (found.status !== 'ready' || found.carriedOver !== undefined || opts.refresh) {
    const discovery = await runDiscovery(ctx, pr, comments, { refresh: opts.refresh })
    sharedCanvas = discovery.sharedCanvas
    warnings.push(...discovery.warnings)
    if (discovery.imported) {
      found = await lookupCanvas(ctx, number, pr)
    }
  }

  const loaded = found.status === 'missing' ? null : await loadCanvas(ctx, found)
  const diff = await shownDiff(ctx, pr, found, loaded)
  if (diff.warning !== null) {
    warnings.push(diff.warning)
  }
  const screen = canvasScreen(number, pr, found, loaded)
  if (screen.warning !== undefined) {
    warnings.push(screen.warning)
  }
  const base = await bundleBase(ctx, number, {
    pr,
    comments,
    capabilities,
    diff,
    canvasSha: reviewedCommit(found, pr),
    artifact: loaded?.artifact ?? null,
    warnings,
  })
  const shared = sharedCanvas === null ? {} : { sharedCanvas }
  const { warning: _screenWarning, ...screenFields } = screen
  return { ...base, ...shared, ...(loaded ?? {}), ...screenFields }
}
