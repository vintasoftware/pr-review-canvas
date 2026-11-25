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
  stateForCanvas,
  unreviewedLayers,
  VIEWER_REVIEW_BODY_FOOTER,
} from '../src/review/review-body.js'
import { authorSignOffReason } from '../src/review/self-review.js'
import {
  refuseAuthorSignOff,
  requireLayersReviewed,
  requireSameDiff,
  signOffOnStaleCanvas,
} from '../src/review/sign-off-guards.js'
import { AppError } from '../src/server/app-error.js'
import type { StateStore } from '../src/store/state-store.js'
import type { DiffedCommit } from '../src/store/derived-store.js'
import { readCanvasComment } from '../src/canvas/comment.js'
import { parseCanvasZipName, rankCandidates, sameRepo } from '../src/canvas/name.js'
import { isLargePr } from '../src/contract/generation-context.js'
import { buildSkillCommand } from '../src/review/skill-command.js'
import { draftDiff, sameDiff } from '../static/js/diff-identity.js'
import type { CanvasManifest } from '../src/contract/canvas-manifest.js'
import type { CommentsPayload, IssueComment } from '../src/contract/comments.js'
import type { Pr, ReviewArtifact } from '../src/contract/review-artifact.js'
import type { PrState } from '../src/contract/state.js'
import { readCanvasZip } from '../src/canvas/zip.js'
import { fetchComments } from '../src/github/comments.js'
import { mapPull } from '../src/github/pr.js'
import { type CanvasAuthor, hasGithubRole, isReviewAuthor } from '../src/host/canvas-author.js'
import { HostCliError } from '../src/host/client.js'
import { toPr } from '../src/host/pr.js'
import {
  COMPARE_FILES_MAX,
  diffFromFiles,
  diffFromText,
  explainsLoadedHead,
  ghFiles,
  incompleteWarning,
  type LoadedDiff,
  PULL_FILES_MAX,
} from './diff-fallback.js'
import type { BrowserGithub } from './github-client.js'

export interface ViewerTarget {
  owner: string
  repo: string
  number: number
}

export interface ApiAnswer {
  status: number
  body: unknown
}

const LOCAL_APP_HINT = 'install the CLI and run pr-review serve for this'

const notInViewer = (what: string) =>
  new AppError('NOT_IMPLEMENTED', `${what} is not available in the viewer`, 501, LOCAL_APP_HINT)

/**
 * Whether a comment's author may supply the canvas, by the local app's rule
 * (`src/host/canvas-author.ts`): the pull request's author, or an owner, member, or collaborator.
 */
function trustedAuthor(
  comment: Pick<IssueComment, 'author' | 'authorAssociation'>,
  prAuthor: string
): boolean {
  const author: CanvasAuthor = {
    login: comment.author,
    ...(comment.authorAssociation === undefined ? {} : { association: comment.authorAssociation }),
  }
  return isReviewAuthor(author.login, prAuthor) || hasGithubRole(author)
}

/** Over 400 files or 50 000 changed lines, as the local app counts it. */
function largePr(diff: LoadedDiff): boolean {
  const counts = diff.files.reduce(
    (n, f) => ({ ...n, additions: n.additions + f.additions, deletions: n.deletions + f.deletions }),
    { files: diff.files.length, additions: 0, deletions: 0 }
  )
  return isLargePr(counts)
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
    throw new AppError('BAD_REQUEST', `send a JSON body: ${expected}`, 400, parsed.error.issues[0]?.message)
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
function writeError(err: unknown): AppError {
  if (err instanceof AppError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (/HTTP 401/.test(message)) {
    return new AppError('GH_UNAUTHENTICATED', 'sign in with GitHub to post', 401, 'sign in again')
  }
  if (/HTTP 40[34]/.test(message)) {
    return new AppError(
      'COMMENT_FORBIDDEN',
      `GitHub refused the post: ${githubMessage(err)}`,
      403,
      APP_WRITE_HINT
    )
  }
  return new AppError('GITHUB_API_ERROR', githubMessage(err), 502)
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
     * The review state, keyed per reader: the anonymous reader keeps the pull request's own key,
     * and each GitHub login gets its own, so a browser shared by two people never sends one
     * person's drafts, or counts their marks, under the other's name.
     */
    state: StateStore<string>
    now?: () => Date
    /** Where an owner installs the GitHub App, to name in a not-found answer to a signed-in reader. */
    installUrl?: string
  }
) {
  const { gh, state: store } = deps
  const now = deps.now ?? (() => new Date())
  const repoPath = `repos/${target.owner}/${target.repo}`
  const prKey = `github/${target.owner}/${target.repo}/${target.number}`.toLowerCase()
  const keyOf = (reader: string | null): string =>
    reader === null ? prKey : `${prKey}@${reader.toLowerCase()}`
  const diffs = new Map<string, Promise<Diff>>()
  let loading: Promise<Loaded> | null = null
  /** The canvas the bundle keyed its marks to, so a mark lands on the diff the reader saw. */
  let markedCanvas: DiffedCommit | null = null

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
   * The canvas the pull request carries, read like the local app reads a canvas comment
   * (src/host/attachments.ts): only from the pull request's author or someone with a role on the
   * repository, since anyone can comment on a public one, and ranked the same way, a canvas of the
   * head first, then one exported for this pull request, then the newest. One that cannot be read
   * gives way to the next.
   */
  function findCanvas(comments: CommentsPayload, pr: Pr, warnings: string[]): SharedCanvas | null {
    const repo = { owner: target.owner, name: target.repo }
    const candidates = comments.issueComments.flatMap((comment, order) => {
      const embedded = readCanvasComment(comment.body)
      const parsed = embedded === null ? null : parseCanvasZipName(embedded.name, repo)
      if (embedded === null || parsed === null) return []
      if (!trustedAuthor(comment, pr.author)) {
        warnings.push(
          `the canvas comment at ${comment.url} is by @${comment.author}, who is neither the pull request's author nor an owner, member, or collaborator of ${target.owner}/${target.repo}; skipped`
        )
        return []
      }
      return [{ comment, bytes: embedded.bytes, parsed, postedAt: comment.updatedAt, order }]
    })
    for (const { comment, bytes } of rankCandidates(candidates, {
      headSha: pr.headSha,
      prNumber: target.number,
    })) {
      try {
        const contents = readCanvasZip(bytes)
        const { repo: canvasRepo } = contents.manifest
        if (!sameRepo(canvasRepo, repo)) {
          warnings.push(
            `the canvas comment at ${comment.url} is for ${canvasRepo.owner}/${canvasRepo.name}; skipped`
          )
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

  /**
   * The pull request and the merge base its diff runs from. `read` is the client's cached read, or
   * its fresh one when a write must see the head as GitHub has it now.
   */
  async function readPr(read: (path: string) => Promise<unknown>): Promise<Pr> {
    const meta = mapPull(await read(`${repoPath}/pulls/${target.number}`))
    const compare = (await read(
      `${repoPath}/compare/${await diffBase(meta.baseRef, meta.mergeCommitSha)}...${meta.headSha}`
    )) as { merge_base_commit?: { sha?: unknown } }
    const mergeBaseSha = compare.merge_base_commit?.sha
    if (typeof mergeBaseSha !== 'string') {
      throw new AppError('GITHUB_API_ERROR', 'GitHub did not report the merge base of this pull request', 502)
    }
    return toPr(meta, { owner: target.owner, name: target.repo }, { headSha: meta.headSha, mergeBaseSha })
  }

  async function load(): Promise<Loaded> {
    const pr = await readPr(path => gh.api(path))
    const fetched = await fetchComments(gh, pr.repo, target.number, pr.headSha, now)
    // GraphQL needs a token, so resolved threads read as open; that is expected here, not news.
    const warnings = fetched.warnings.filter(w => !w.startsWith('resolved state unavailable'))
    const canvas = findCanvas(fetched.payload, pr, warnings)
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

  async function bundle(refresh: boolean, reader: string | null): Promise<PrBundle> {
    const { pr, comments, canvas, warnings: loadWarnings } = await loaded(refresh)
    const warnings = [...loadWarnings]
    const stored = await store.read(keyOf(reader))
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
        state: stateForCanvas(stored, pr),
        largePr: largePr(head),
      }
    }

    const { manifest } = canvas
    const artifact: ReviewArtifact = { ...canvas.artifact, source: 'import' }
    const info = { headSha: manifest.headSha, source: 'import' as const, manifest }
    const own = await diffOf(manifest.mergeBaseSha, manifest.headSha)
    let status: PrBundle['status'] = 'ready'
    let carriedOver: CarriedOverInfo | undefined
    let stale: StaleInfo | undefined
    if (!sameDiff(manifest, pr)) {
      const head = await diffOf(pr.mergeBaseSha, pr.headSha)
      if (!explainsLoadedHead(own, head)) {
        status = 'stale'
        stale = await staleRelation(pr, manifest)
      } else if (manifest.headSha !== pr.headSha) {
        // The head's own canvas on another base with the same diff is simply ready, as locally.
        const relation = await staleRelation(pr, manifest)
        carriedOver = {
          canvasHeadSha: manifest.headSha,
          currentHeadSha: pr.headSha,
          ...(relation.relation === 'ancestor' ? { commitsBehind: relation.commitsBehind } : {}),
        }
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
      state: stateForCanvas(stored, markedCanvas),
      largePr: largePr(own),
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
   * The pull request, refusing a write made from a page drawn on another diff. A page that names
   * its diff gets it checked against the head and base GitHub reports now: the copy loaded with the
   * page would still hold the head it was drawn on, however many commits were pushed since. Only
   * the pull request is read again, not its comments.
   */
  async function currentPr(page: { headSha?: string | undefined; mergeBaseSha?: string | undefined }) {
    if (page.headSha === undefined && page.mergeBaseSha === undefined) return (await loaded(false)).pr
    const pr = await readPr(path => gh.apiFresh(path))
    requireSameDiff(page, pr)
    return pr
  }

  /** Refuses a line the diff on screen does not show. */
  async function requireInlineTarget(pr: Pr, line: Parameters<typeof checkInlineTarget>[1]) {
    const problem = checkInlineTarget((await diffOf(pr.mergeBaseSha, pr.headSha)).files, line)
    if (problem !== null) {
      throw new AppError('COMMENT_LINE_NOT_IN_DIFF', problem, 422, 'comment on a line the diff shows')
    }
  }

  function requireLogin(reader: string | null): string {
    if (reader === null) {
      throw new AppError(
        'GH_UNAUTHENTICATED',
        'sign in with GitHub to post',
        401,
        'use sign in with GitHub at the top of the page'
      )
    }
    return reader
  }

  /** The canvas a review signs off on, with the marks made on it: only one that describes the head. */
  async function signOffCanvas(reader: string | null): Promise<{
    artifact: ReviewArtifact
    state: PrState
    comments: CommentsPayload
    pr: Pr
  }> {
    const shown = await bundle(false, reader)
    if (shown.status !== 'ready' || shown.artifact === undefined) throw signOffOnStaleCanvas()
    return { artifact: shown.artifact, state: shown.state, comments: shown.comments, pr: shown.pr }
  }

  async function postOnPr(body: unknown, reader: string | null): Promise<Answer> {
    const input = parseBody(PostCommentInputSchema, body, 'an inline, reply, or issue comment')
    requireLogin(reader)
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
    return new Answer(201, { ...posted, state: await store.addPosted(keyOf(reader), [entry]) })
  }

  async function reviewBody(reader: string | null): Promise<ReviewBodyResponse> {
    const { artifact, state: marks, comments, pr } = await signOffCanvas(reader)
    return {
      headSha: pr.headSha,
      body: viewerReviewBody({ artifact, state: marks, comments, headSha: pr.headSha }),
      unreviewed: unreviewedLayers(artifact, marks).map(l => l.title),
      pending: marks.pending.length,
    }
  }

  async function submitReview(body: unknown, reader: string | null): Promise<Answer> {
    const input = parseBody(PostReviewInputSchema, body, '{ "event": "APPROVE" }')
    const who = requireLogin(reader)
    const pr = await currentPr(input)
    refuseAuthorSignOff(who, pr, 'pull request', input.event)
    const { artifact, state: marks, comments } = await signOffCanvas(reader)
    requireLayersReviewed(artifact, marks, input.event)
    const text = input.body ?? viewerReviewBody({ artifact, state: marks, comments, headSha: pr.headSha })
    const key = keyOf(reader)
    const pending = input.includePending ? (await store.read(key)).pending : []
    // The viewer keeps no older diffs to compare, so a draft goes out only on the diff it was written on.
    if (pending.some(p => !sameDiff(draftDiff(p, pr), pr))) {
      throw new AppError(
        'CANVAS_STALE',
        'pending comments were written on a different diff',
        409,
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
        ? await store.read(key)
        : await store.completePending(
            key,
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

  async function addPending(body: unknown, reader: string | null): Promise<Answer> {
    const input = parseBody(AddPendingInputSchema, body, 'a comment on a line of the diff')
    const pr = await currentPr(input)
    await requireInlineTarget(pr, input)
    return new Answer(201, stateBody(await store.addPending(keyOf(reader), input, pr)))
  }

  async function editPending(id: string, body: unknown, reader: string | null): Promise<StateResponse> {
    const { body: text } = parseBody(EditPendingInputSchema, body, '{ "body": "…" }')
    const key = keyOf(reader)
    if (!(await store.read(key)).pending.some(p => p.id === id)) {
      throw new AppError('NOT_FOUND', `no pending comment ${id}`, 404, 'reload the page')
    }
    return stateBody(await store.editPending(key, id, text))
  }

  async function route(method: string, url: URL, body: unknown, reader: string | null): Promise<unknown> {
    const parts = url.pathname.split('/').filter(Boolean)
    // ['api', 'prs', '<n>', ...rest] or ['api', '<name>']
    if (parts[0] !== 'api') throw new AppError('NOT_FOUND', `no route ${url.pathname}`, 404)
    if (parts[1] !== 'prs') throw notInViewer('this')
    if (parts[2] !== String(target.number)) {
      throw new AppError('NOT_FOUND', 'this viewer shows one pull request', 404)
    }
    const key = keyOf(reader)
    const rest = parts.slice(3)
    const sub = rest.join('/')
    if (method === 'GET' && sub === '') return bundle(url.searchParams.get('refresh') === '1', reader)
    if (method === 'GET' && sub === 'patches') return patches(url.searchParams.get('headSha'))
    if (method === 'GET' && sub === 'state') return stateBody(await store.read(key))
    if (method === 'GET' && sub === 'capabilities') return capabilitiesFor(reader)
    if (method === 'GET' && sub === 'comments') return (await loaded(true)).comments
    if (method === 'GET' && sub === 'chat/threads') return { threads: [] }
    const input = (body ?? {}) as Record<string, unknown>
    if (method === 'PUT' && rest[0] === 'reviewed' && rest.length > 1) {
      const id = decodeURIComponent(rest.slice(1).join('/'))
      const fallback = markedCanvas ?? (await loaded(false)).pr
      const canvas: DiffedCommit = {
        headSha: typeof input['canvasSha'] === 'string' ? input['canvasSha'] : fallback.headSha,
        mergeBaseSha:
          typeof input['canvasMergeBaseSha'] === 'string'
            ? input['canvasMergeBaseSha']
            : fallback.mergeBaseSha,
      }
      return stateBody(await store.setReviewed(key, id, input['reviewed'] === true, { canvas }))
    }
    if (method === 'PUT' && rest[0] === 'points' && rest[2] === 'dismissed') {
      const reason = typeof input['reason'] === 'string' ? input['reason'] : undefined
      const fingerprint = decodeURIComponent(rest[1]!)
      return stateBody(await store.setDismissed(key, fingerprint, input['dismissed'] === true, reason))
    }
    if (method === 'PUT' && rest[0] === 'threads' && rest[2] === 'hidden') {
      return stateBody(await store.setThreadHidden(key, Number(rest[1]), input['hidden'] === true))
    }
    if (method === 'POST' && sub === 'comments') return postOnPr(body, reader)
    if (method === 'POST' && sub === 'pending') return addPending(body, reader)
    if (method === 'DELETE' && sub === 'pending') return stateBody(await store.clearPending(key))
    if (rest[0] === 'pending' && rest.length === 2) {
      const id = decodeURIComponent(rest[1]!)
      if (method === 'PATCH') return editPending(id, body, reader)
      if (method === 'DELETE') return stateBody(await store.removePending(key, id))
    }
    if (method === 'GET' && sub === 'review/body') return reviewBody(reader)
    if (method === 'POST' && sub === 'review') return submitReview(body, reader)
    throw notInViewer(rest[0] === 'chat' ? 'AI chat' : 'this')
  }

  /** One request, answered as the server would: JSON, or the error envelope. */
  async function handle(method: string, url: URL, body: unknown): Promise<ApiAnswer> {
    try {
      const answer = await route(method, url, body, await login())
      return answer instanceof Answer
        ? { status: answer.status, body: answer.body }
        : { status: 200, body: answer }
    } catch (err) {
      if (err instanceof AppError) return { status: err.status, body: err.toEnvelope() }
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
