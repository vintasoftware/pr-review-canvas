// The local server's /api routes, answered in the browser for one GitHub pull request. The page's
// modules call fetch as they do against `pr-review serve`; this module answers the read routes from
// GitHub's API and the canvas comment, keeps marks and the pending review in the browser, posts
// comments and reviews as the signed-in reader, and refuses what needs the local app (chat,
// generation, import).
import type { z } from 'zod'
import type {
  Capabilities,
  CarriedOverInfo,
  ErrorEnvelope,
  PrBundle,
  ReviewBodyResponse,
  StaleInfo,
  StateResponse,
} from '../src/contract/api.js'
import { PostCommentInputSchema } from '../src/contract/comments.js'
import { AddPendingInputSchema, EditPendingInputSchema } from '../src/contract/pending.js'
import { PostReviewInputSchema } from '../src/contract/reviews.js'
import { checkInlineTarget } from '../src/git/patch-lines.js'
import { postComment } from '../src/github/post-comment.js'
import { postReview } from '../src/github/post-review.js'
import { postedFromPending } from '../src/review/posted-comments.js'
import {
  buildReviewBody,
  type ReviewBodyInput,
  unreviewedLayers,
  VIEWER_REVIEW_BODY_FOOTER,
} from '../src/review/review-body.js'
import { authorSignOffReason } from '../src/review/self-review.js'
import { buildSkillCommand } from '../src/review/skill-command.js'
import { draftDiff, sameDiff } from '../static/js/diff-identity.js'
import type { CanvasManifest } from '../src/contract/canvas-manifest.js'
import type { CommentsPayload, IssueComment } from '../src/contract/comments.js'
import type { FileEntry, Pr, ReviewArtifact } from '../src/contract/review-artifact.js'
import type { PrState } from '../src/contract/state.js'
import { readCanvasZip } from '../src/canvas/zip.js'
import { fetchComments } from '../src/github/comments.js'
import { mapPull } from '../src/github/pr.js'
import { HostCliError } from '../src/host/client.js'
import { toPr } from '../src/host/pr.js'
import {
  COMPARE_FILES_MAX,
  diffFromFiles,
  diffFromText,
  ghFiles,
  incompleteWarning,
  type LoadedDiff,
  PULL_FILES_MAX,
  sameLoadedDiff,
} from './diff-fallback.js'
import type { BrowserGithub } from './github-client.js'
import { type MarkedCanvas, type ViewerStateStore } from './review-state.js'

export interface ViewerTarget {
  owner: string
  repo: string
  number: number
}

export interface ApiAnswer {
  status: number
  body: unknown
}

type ErrorCode = ErrorEnvelope['error']['code']

class ViewerError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly hint: string | undefined

  constructor(status: number, code: ErrorCode, message: string, hint?: string) {
    super(message)
    this.status = status
    this.code = code
    this.hint = hint
  }
}

const LOCAL_APP_HINT = 'install the CLI and run pr-review serve for this'

const notInViewer = (what: string) =>
  new ViewerError(501, 'NOT_IMPLEMENTED', `${what} is not available in the viewer`, LOCAL_APP_HINT)

/** The canvas comment's envelope, as src/canvas/comment.ts writes it. */
/** GitHub's `author_association` values for people with a role on the repository. */
const REPOSITORY_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/**
 * Whether a comment's author may supply the canvas: the pull request's author, or an owner,
 * member, or collaborator. `ghost` stands for any deleted account, so it matches nobody.
 */
function trustedAuthor(
  comment: Pick<IssueComment, 'author' | 'authorAssociation'>,
  prAuthor: string
): boolean {
  if (REPOSITORY_ROLES.has(comment.authorAssociation ?? '')) return true
  return comment.author !== 'ghost' && comment.author.toLowerCase() === prAuthor.toLowerCase()
}

const CANVAS_ENVELOPE = /<!-- pr-review-canvas:v1\n([A-Za-z0-9._-]+\.zip)\n([A-Za-z0-9+/]+={0,2})\n-->/

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Over 400 files or 50 000 changed lines, as src/contract/generation-context.ts counts it. */
function largePr(files: readonly FileEntry[]): boolean {
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0)
  return files.length > 400 || lines > 50_000
}

const APP_WRITE_HINT =
  'the GitHub App needs the Pull requests: read and write permission, and must be installed on this repository'

/**
 * Signed out, the reader cannot post. Signed in, a GitHub App token cannot say what it may do, so
 * posting is offered and GitHub decides, as the local app does with a fine-grained token.
 */
function capabilitiesFor(login: string | null): Capabilities {
  if (login === null) {
    return {
      canComment: false,
      tokenKind: 'none',
      login,
      reason: 'sign in with GitHub to post comments and reviews',
      hint: 'use sign in with GitHub at the top of the page',
    }
  }
  return {
    canComment: 'unknown',
    tokenKind: 'github-app',
    login,
    reason: 'GitHub decides whether the app may post here',
    hint: APP_WRITE_HINT,
  }
}

/** A route's answer with a status other than 200, as a write's 201. */
class Answer {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    this.status = status
    this.body = body
  }
}

/** The page's JSON body, checked against the schema the server reads it with. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown, expected: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ViewerError(
      400,
      'BAD_REQUEST',
      `send a JSON body: ${expected}`,
      parsed.error.issues[0]?.message
    )
  }
  return parsed.data
}

/**
 * What GitHub said, for the reader. The client words its failures like the local app's CLI errors
 * (`gh api <path> failed (1): HTTP 403: …`) so the shared code can read the status; the page names
 * no CLI, so it shows the status and GitHub's message only.
 */
function githubMessage(err: unknown): string {
  return err instanceof HostCliError ? err.stderr.trim() : err instanceof Error ? err.message : String(err)
}

/** GitHub's refusal of a write, as the page's error envelope. */
function writeError(err: unknown): ViewerError {
  if (err instanceof ViewerError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (/HTTP 401/.test(message)) {
    return new ViewerError(401, 'GH_UNAUTHENTICATED', 'sign in with GitHub to post', 'sign in again')
  }
  if (/HTTP 40[34]/.test(message)) {
    return new ViewerError(
      403,
      'COMMENT_FORBIDDEN',
      `GitHub refused the post: ${githubMessage(err)}`,
      APP_WRITE_HINT
    )
  }
  return new ViewerError(502, 'GITHUB_API_ERROR', githubMessage(err))
}

type Diff = LoadedDiff

/** The review body the local app writes, signed as the viewer's: no local app wrote it. */
function viewerReviewBody(input: Omit<ReviewBodyInput, 'mentionCanvas' | 'footer'>): string {
  return buildReviewBody({ ...input, mentionCanvas: true, footer: VIEWER_REVIEW_BODY_FOOTER })
}

interface SharedCanvas {
  manifest: CanvasManifest
  artifact: ReviewArtifact
  commentUrl: string
}

interface Loaded {
  pr: Pr
  comments: CommentsPayload
  canvas: SharedCanvas | null
  warnings: string[]
}

export function createViewerApi(
  target: ViewerTarget,
  deps: {
    gh: BrowserGithub
    /**
     * The review state of one reader: `null` is the anonymous reader. Each GitHub login gets its
     * own, so a browser shared by two people never sends one person's drafts, or counts their
     * marks, under the other's name.
     */
    state: (reader: string | null) => ViewerStateStore
    now?: () => Date
    /** Where an owner installs the GitHub App, to name in a not-found answer to a signed-in reader. */
    installUrl?: string
  }
) {
  const { gh } = deps
  /** The store of the reader making the current request, set as each request starts. */
  let state: ViewerStateStore = deps.state(null)
  const now = deps.now ?? (() => new Date())
  const repoPath = `repos/${target.owner}/${target.repo}`
  const diffs = new Map<string, Promise<Diff>>()
  let loading: Promise<Loaded> | null = null
  /** The canvas the bundle keyed its marks to, so a mark lands on the diff the reader saw. */
  let markedCanvas: MarkedCanvas | null = null

  /**
   * The diff GitHub could not send whole, rebuilt from a file list: the pull request's own when
   * the diff is the pull request's, which lists up to 3000 files, otherwise the comparison's,
   * which lists up to 300.
   */
  async function listedDiff(mergeBaseSha: string, headSha: string): Promise<Diff> {
    const { pr } = await loaded(false)
    if (headSha === pr.headSha && mergeBaseSha === pr.mergeBaseSha) {
      const listed: unknown[] = []
      for (let page = 1; page <= PULL_FILES_MAX / 100; page++) {
        const batch = await gh.api(`${repoPath}/pulls/${target.number}/files`, {
          per_page: '100',
          page: String(page),
        })
        const rows = Array.isArray(batch) ? batch : []
        listed.push(...rows)
        if (rows.length < 100) break
      }
      return diffFromFiles(ghFiles(listed), pr.changedFiles)
    }
    const compare = (await gh.api(`${repoPath}/compare/${mergeBaseSha}...${headSha}`)) as { files?: unknown }
    const files = ghFiles(compare.files)
    return diffFromFiles(files, files.length >= COMPARE_FILES_MAX ? 'unknown' : files.length)
  }

  function diffOf(mergeBaseSha: string, headSha: string): Promise<Diff> {
    const key = `${mergeBaseSha}...${headSha}`
    let found = diffs.get(key)
    if (found === undefined) {
      found = gh.diff(target.owner, target.repo, mergeBaseSha, headSha).then(diffFromText, err => {
        // 422: "The diff is taking too long to generate". 406: a diff over GitHub's own limits.
        if (/HTTP (406|422)/.test(err instanceof Error ? err.message : String(err))) {
          return listedDiff(mergeBaseSha, headSha)
        }
        throw err
      })
      found.catch(() => diffs.delete(key))
      diffs.set(key, found)
    }
    return found
  }

  /**
   * The newest canvas comment on the pull request, read like `pr-review import` reads a zip. Only
   * the pull request's author or someone with a role on the repository can supply it: on a public
   * repository anyone can comment, and the viewer's link always opens the newest canvas.
   */
  function findCanvas(comments: CommentsPayload, prAuthor: string, warnings: string[]): SharedCanvas | null {
    const newestFirst = [...comments.issueComments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const comment of newestFirst) {
      const match = CANVAS_ENVELOPE.exec(comment.body)
      if (match === null) continue
      if (!trustedAuthor(comment, prAuthor)) {
        warnings.push(
          `the canvas comment at ${comment.url} is by @${comment.author}, who is neither the pull request's author nor an owner, member, or collaborator of ${target.owner}/${target.repo}; skipped`
        )
        continue
      }
      try {
        const contents = readCanvasZip(decodeBase64(match[2]!))
        const { repo } = contents.manifest
        if (
          repo.owner.toLowerCase() !== target.owner.toLowerCase() ||
          repo.name.toLowerCase() !== target.repo.toLowerCase()
        ) {
          warnings.push(`the canvas comment at ${comment.url} is for ${repo.owner}/${repo.name}; skipped`)
          continue
        }
        if (contents.prNumber !== undefined && contents.prNumber !== target.number) {
          warnings.push(`the canvas comment at ${comment.url} is for #${contents.prNumber}; skipped`)
          continue
        }
        return { manifest: contents.manifest, artifact: contents.artifact, commentUrl: comment.url }
      } catch (err) {
        warnings.push(`the canvas comment at ${comment.url} could not be read: ${githubMessage(err)}`)
      }
    }
    return null
  }

  /**
   * What the head is diffed from, as src/git/pr-refs.ts picks it: the base branch, or for a merged
   * pull request the base as it was at merge time, the merge commit's first parent. Today's base
   * tip contains a merged head, so it would give an empty diff.
   */
  async function diffBase(baseRef: string, mergeCommitSha: string | null): Promise<string> {
    if (mergeCommitSha === null) return encodeURIComponent(baseRef)
    const commit = (await gh.api(`${repoPath}/commits/${mergeCommitSha}`)) as {
      parents?: Array<{ sha?: unknown }>
    }
    const parent = commit.parents?.[0]?.sha
    return typeof parent === 'string' ? parent : encodeURIComponent(baseRef)
  }

  /** The signed-in reader's login, or null when reading anonymously. */
  async function login(): Promise<string | null> {
    if (!(await gh.authStatus()).authenticated) return null
    const user = (await gh.api('user')) as { login?: unknown }
    return typeof user.login === 'string' ? user.login : null
  }

  async function load(): Promise<Loaded> {
    const meta = mapPull(await gh.api(`${repoPath}/pulls/${target.number}`))
    const compare = (await gh.api(
      `${repoPath}/compare/${await diffBase(meta.baseRef, meta.mergeCommitSha)}...${meta.headSha}`
    )) as { merge_base_commit?: { sha?: unknown } }
    const mergeBaseSha = compare.merge_base_commit?.sha
    if (typeof mergeBaseSha !== 'string') {
      throw new ViewerError(
        502,
        'GITHUB_API_ERROR',
        'GitHub did not report the merge base of this pull request'
      )
    }
    const pr = toPr(meta, { owner: target.owner, name: target.repo }, { headSha: meta.headSha, mergeBaseSha })
    const fetched = await fetchComments(gh, pr.repo, target.number, pr.headSha, now)
    // GraphQL needs a token, so resolved threads read as open; that is expected here, not news.
    const warnings = fetched.warnings.filter(w => !w.startsWith('resolved state unavailable'))
    const canvas = findCanvas(fetched.payload, meta.author, warnings)
    return { pr, comments: fetched.payload, canvas, warnings }
  }

  function loaded(refresh: boolean): Promise<Loaded> {
    if (loading === null || refresh) {
      if (refresh) gh.refresh()
      loading = load()
      loading.catch(() => {
        loading = null
      })
    }
    return loading
  }

  /** How a canvas of another diff relates to the head, as the local app's stale bar says it. */
  async function staleRelation(pr: Pr, manifest: CanvasManifest): Promise<StaleInfo> {
    const base = { canvasHeadSha: manifest.headSha, currentHeadSha: pr.headSha }
    if (manifest.headSha === pr.headSha) {
      return {
        ...base,
        relation: 'other-base',
        canvasMergeBaseSha: manifest.mergeBaseSha,
        currentMergeBaseSha: pr.mergeBaseSha,
      }
    }
    try {
      const compare = (await gh.api(`${repoPath}/compare/${manifest.headSha}...${pr.headSha}`)) as {
        status?: unknown
        ahead_by?: unknown
      }
      if (compare.status === 'ahead' && typeof compare.ahead_by === 'number') {
        return { ...base, relation: 'ancestor', commitsBehind: compare.ahead_by }
      }
    } catch {
      // A force-pushed canvas commit may be gone from GitHub: it is on no line of the head.
    }
    return { ...base, relation: 'unrelated' }
  }

  async function bundle(refresh: boolean): Promise<PrBundle> {
    const { pr, comments, canvas, warnings: loadWarnings } = await loaded(refresh)
    const warnings = [...loadWarnings]
    const reader = await login()
    const common = {
      pr,
      comments,
      capabilities: capabilitiesFor(reader),
      selfReview: false,
      authorSignOffReason: authorSignOffReason(reader, pr, 'pull request'),
      chat: { enabled: false, acpx: false },
      canvasComment: false,
      mentionCanvas: true,
      // The command the local app shows: a canvas of the head itself is written again with --force.
      skillCommand: buildSkillCommand(target.number, { force: canvas?.manifest.headSha === pr.headSha }),
      viewer: true as const,
      warnings,
    }

    if (canvas === null) {
      const head = await diffOf(pr.mergeBaseSha, pr.headSha)
      markedCanvas = pr
      const incomplete = incompleteWarning(head)
      if (incomplete !== null) warnings.push(incomplete)
      return {
        ...common,
        status: 'missing',
        files: head.files,
        derivable: true,
        state: state.forCanvas(pr),
        largePr: largePr(head.files),
      }
    }

    const { manifest } = canvas
    const artifact: ReviewArtifact = { ...canvas.artifact, source: 'import' }
    const info = { headSha: manifest.headSha, source: 'import' as const, manifest }
    const own = await diffOf(manifest.mergeBaseSha, manifest.headSha)
    const ofHead = manifest.headSha === pr.headSha && manifest.mergeBaseSha === pr.mergeBaseSha
    let status: PrBundle['status'] = 'ready'
    let carriedOver: CarriedOverInfo | undefined
    let stale: StaleInfo | undefined
    if (!ofHead) {
      const head = await diffOf(pr.mergeBaseSha, pr.headSha)
      if (sameLoadedDiff(head, own)) {
        const relation = await staleRelation(pr, manifest)
        carriedOver = {
          canvasHeadSha: manifest.headSha,
          currentHeadSha: pr.headSha,
          ...(relation.relation === 'ancestor' ? { commitsBehind: relation.commitsBehind } : {}),
        }
      } else {
        status = 'stale'
        stale = await staleRelation(pr, manifest)
      }
    }
    markedCanvas = { headSha: manifest.headSha, mergeBaseSha: manifest.mergeBaseSha }
    const incomplete = incompleteWarning(own)
    if (incomplete !== null) warnings.push(incomplete)
    return {
      ...common,
      status,
      files: own.files,
      derivable: true,
      artifact,
      canvas: info,
      state: state.forCanvas(markedCanvas),
      largePr: largePr(own.files),
      ...(carriedOver === undefined ? {} : { carriedOver }),
      ...(stale === undefined ? {} : { stale }),
    }
  }

  async function patches(
    headSha: string | null
  ): Promise<{ headSha: string; patches: Record<string, string> }> {
    const { pr, canvas } = await loaded(false)
    const named = headSha ?? pr.headSha
    const diff =
      canvas !== null && named === canvas.manifest.headSha
        ? await diffOf(canvas.manifest.mergeBaseSha, canvas.manifest.headSha)
        : await diffOf(pr.mergeBaseSha, pr.headSha)
    return { headSha: named, patches: diff.patches }
  }

  const stateBody = (s: PrState): StateResponse => ({ prNumber: target.number, state: s })

  /**
   * The pull request as GitHub has it now, refusing a write made from a page drawn on another diff.
   * A page that names its diff gets it checked against a fresh read: the copy loaded with the page
   * would still hold the head the page was drawn on, however many commits were pushed since.
   */
  async function currentPr(page: { headSha?: string | undefined; mergeBaseSha?: string | undefined }) {
    const { pr } = await loaded(page.headSha !== undefined || page.mergeBaseSha !== undefined)
    const moved = (seen: string | undefined, current: string) => seen !== undefined && seen !== current
    if (moved(page.headSha, pr.headSha) || moved(page.mergeBaseSha, pr.mergeBaseSha)) {
      throw new ViewerError(
        409,
        'CANVAS_STALE',
        'the pull request has a new head commit or base since this page was drawn',
        'reload the page and try again'
      )
    }
    return pr
  }

  /** Refuses a line the diff on screen does not show. */
  async function requireInlineTarget(pr: Pr, line: Parameters<typeof checkInlineTarget>[1]) {
    const problem = checkInlineTarget((await diffOf(pr.mergeBaseSha, pr.headSha)).files, line)
    if (problem !== null) {
      throw new ViewerError(422, 'COMMENT_LINE_NOT_IN_DIFF', problem, 'comment on a line the diff shows')
    }
  }

  async function requireLogin(): Promise<string> {
    const who = await login()
    if (who === null) {
      throw new ViewerError(
        401,
        'GH_UNAUTHENTICATED',
        'sign in with GitHub to post',
        'use sign in with GitHub at the top of the page'
      )
    }
    return who
  }

  /** The canvas a review signs off on, with the marks made on it: only one that describes the head. */
  async function signOffCanvas(): Promise<{
    artifact: ReviewArtifact
    state: PrState
    comments: CommentsPayload
    pr: Pr
  }> {
    const shown = await bundle(false)
    if (shown.status !== 'ready' || shown.artifact === undefined) {
      throw new ViewerError(
        409,
        'SIGNOFF_INCOMPLETE',
        'the canvas on screen was generated for another commit or another base',
        'regenerate the canvas for the current head, then review its layers'
      )
    }
    return { artifact: shown.artifact, state: shown.state, comments: shown.comments, pr: shown.pr }
  }

  async function postOnPr(body: unknown): Promise<Answer> {
    const input = parseBody(PostCommentInputSchema, body, 'an inline, reply, or issue comment')
    await requireLogin()
    const pr = await currentPr(input)
    if (input.kind === 'inline') await requireInlineTarget(pr, input)
    let posted: Awaited<ReturnType<typeof postComment>>
    try {
      posted = await postComment(gh, pr.repo, target.number, pr.headSha, input)
    } catch (err) {
      throw writeError(err)
    }
    const entry = {
      commentId: posted.comment.id,
      ...(input.kind === 'inline' && input.pointFingerprint !== undefined
        ? { pointFingerprint: input.pointFingerprint }
        : {}),
      ...(input.kind === 'inline' && input.proposalFingerprint !== undefined
        ? { proposalFingerprint: input.proposalFingerprint }
        : {}),
    }
    return new Answer(201, { ...posted, state: state.addPosted([entry]) })
  }

  async function reviewBody(): Promise<ReviewBodyResponse> {
    const { artifact, state: marks, comments, pr } = await signOffCanvas()
    return {
      headSha: pr.headSha,
      body: viewerReviewBody({ artifact, state: marks, comments, headSha: pr.headSha }),
      unreviewed: unreviewedLayers(artifact, marks).map(l => l.title),
      pending: marks.pending.length,
    }
  }

  async function submitReview(body: unknown): Promise<Answer> {
    const input = parseBody(PostReviewInputSchema, body, '{ "event": "APPROVE" }')
    const who = await requireLogin()
    const pr = await currentPr(input)
    const byAuthor = input.event === 'COMMENT' ? null : authorSignOffReason(who, pr, 'pull request')
    if (byAuthor !== null) {
      throw new ViewerError(
        403,
        'SIGNOFF_BY_AUTHOR',
        byAuthor,
        'ask another reviewer to sign off, or post a comment-only review'
      )
    }
    const { artifact, state: marks, comments } = await signOffCanvas()
    if (input.event === 'APPROVE') {
      const missing = unreviewedLayers(artifact, marks)
      if (missing.length > 0) {
        throw new ViewerError(
          409,
          'SIGNOFF_INCOMPLETE',
          `${missing.length} ${missing.length === 1 ? 'layer is' : 'layers are'} not reviewed yet`,
          missing.map(l => l.title).join(', ')
        )
      }
    }
    const text = input.body ?? viewerReviewBody({ artifact, state: marks, comments, headSha: pr.headSha })
    const pending = input.includePending ? state.read().pending : []
    // The viewer keeps no older diffs to compare, so a draft goes out only on the diff it was written on.
    if (pending.some(p => !sameDiff(draftDiff(p, pr), pr))) {
      throw new ViewerError(
        409,
        'CANVAS_STALE',
        'pending comments were written on a different diff',
        'copy or delete the drafts written on an earlier diff in the pending review, then comment on the current code'
      )
    }
    let posted: Awaited<ReturnType<typeof postReview>>
    try {
      posted = await postReview(gh, pr.repo, target.number, pr.headSha, {
        event: input.event,
        body: text,
        comments: pending,
      })
    } catch (err) {
      throw writeError(err)
    }
    const { comments: submittedComments, warnings, ...review } = posted
    const next =
      pending.length === 0
        ? state.read()
        : state.completePending(
            pending.map(p => ({ ...p, reviewId: review.id })),
            postedFromPending(pending, submittedComments)
          )
    return new Answer(201, {
      review,
      submitted: pending.length,
      state: next,
      comments: submittedComments,
      warnings,
    })
  }

  async function addPending(body: unknown): Promise<Answer> {
    const input = parseBody(AddPendingInputSchema, body, 'a comment on a line of the diff')
    const pr = await currentPr(input)
    await requireInlineTarget(pr, input)
    return new Answer(201, stateBody(state.addPending(input, pr)))
  }

  function editPending(id: string, body: unknown): StateResponse {
    const { body: text } = parseBody(EditPendingInputSchema, body, '{ "body": "…" }')
    if (!state.read().pending.some(p => p.id === id)) {
      throw new ViewerError(404, 'NOT_FOUND', `no pending comment ${id}`, 'reload the page')
    }
    return stateBody(state.editPending(id, text))
  }

  async function route(method: string, url: URL, body: unknown): Promise<unknown> {
    const parts = url.pathname.split('/').filter(Boolean)
    // ['api', 'prs', '<n>', ...rest] or ['api', '<name>']
    if (parts[0] !== 'api') throw new ViewerError(404, 'NOT_FOUND', `no route ${url.pathname}`)
    if (parts[1] === 'appearance' && method === 'PUT') return body
    if (parts[1] !== 'prs') throw notInViewer('this')
    if (parts[2] !== String(target.number))
      throw new ViewerError(404, 'NOT_FOUND', 'this viewer shows one pull request')
    const rest = parts.slice(3)
    const sub = rest.join('/')
    if (method === 'GET' && sub === '') return bundle(url.searchParams.get('refresh') === '1')
    if (method === 'GET' && sub === 'patches') return patches(url.searchParams.get('headSha'))
    if (method === 'GET' && sub === 'state') return stateBody(state.read())
    if (method === 'GET' && sub === 'capabilities') return capabilitiesFor(await login())
    if (method === 'GET' && sub === 'comments') return (await loaded(true)).comments
    if (method === 'GET' && sub === 'chat/threads') return { threads: [] }
    const input = (body ?? {}) as Record<string, unknown>
    if (method === 'PUT' && rest[0] === 'reviewed' && rest.length > 1) {
      const id = decodeURIComponent(rest.slice(1).join('/'))
      const fallback = markedCanvas ?? (await loaded(false)).pr
      const canvas: MarkedCanvas = {
        headSha: typeof input['canvasSha'] === 'string' ? input['canvasSha'] : fallback.headSha,
        mergeBaseSha:
          typeof input['canvasMergeBaseSha'] === 'string'
            ? input['canvasMergeBaseSha']
            : fallback.mergeBaseSha,
      }
      return stateBody(state.setReviewed(id, input['reviewed'] === true, canvas))
    }
    if (method === 'PUT' && rest[0] === 'points' && rest[2] === 'dismissed') {
      const reason = typeof input['reason'] === 'string' ? input['reason'] : undefined
      return stateBody(state.setDismissed(decodeURIComponent(rest[1]!), input['dismissed'] === true, reason))
    }
    if (method === 'PUT' && rest[0] === 'threads' && rest[2] === 'hidden') {
      return stateBody(state.setThreadHidden(Number(rest[1]), input['hidden'] === true))
    }
    if (method === 'POST' && sub === 'comments') return postOnPr(body)
    if (method === 'POST' && sub === 'pending') return addPending(body)
    if (method === 'DELETE' && sub === 'pending') return stateBody(state.clearPending())
    if (rest[0] === 'pending' && rest.length === 2) {
      const id = decodeURIComponent(rest[1]!)
      if (method === 'PATCH') return editPending(id, body)
      if (method === 'DELETE') return stateBody(state.removePending(id))
    }
    if (method === 'GET' && sub === 'review/body') return reviewBody()
    if (method === 'POST' && sub === 'review') return submitReview(body)
    throw notInViewer(rest[0] === 'chat' ? 'AI chat' : 'this')
  }

  /** One request, answered as the server would: JSON, or the error envelope. */
  async function handle(method: string, url: URL, body: unknown): Promise<ApiAnswer> {
    try {
      state = deps.state(await login())
      const answer = await route(method, url, body)
      return answer instanceof Answer
        ? { status: answer.status, body: answer.body }
        : { status: 200, body: answer }
    } catch (err) {
      if (err instanceof ViewerError) {
        const error: ErrorEnvelope['error'] = { code: err.code, message: err.message }
        if (err.hint !== undefined) error.hint = err.hint
        return { status: err.status, body: { error } }
      }
      const message = err instanceof Error ? err.message : String(err)
      if (!/HTTP 404/.test(message)) {
        return { status: 502, body: { error: { code: 'GITHUB_API_ERROR', message: githubMessage(err) } } }
      }
      const name = `${target.owner}/${target.repo}#${target.number}`
      const signedIn = (await gh.authStatus()).authenticated
      const error: ErrorEnvelope['error'] = {
        code: 'PR_NOT_FOUND',
        message: signedIn
          ? `${name} was not found, or the GitHub App is not installed where it can read ${target.owner}/${target.repo}`
          : `${name} was not found, or is not public`,
      }
      if (signedIn && deps.installUrl !== undefined) {
        error.hint = `ask an admin of ${target.owner} to install the app: ${deps.installUrl}`
      } else if (!signedIn) {
        error.hint = 'sign in with GitHub to open a private repository'
      }
      return { status: 404, body: { error } }
    }
  }

  return { handle }
}
