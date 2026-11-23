// The local server's /api routes, answered in the browser for one public GitHub pull request. The
// page's modules call fetch as they do against `pr-review serve`; this module answers the read
// routes from GitHub's API and the canvas comment, keeps marks in the browser, and refuses
// everything that needs the local app (posting, chat, generation, import).
import type {
  Capabilities,
  CarriedOverInfo,
  ErrorEnvelope,
  PrBundle,
  StaleInfo,
  StateResponse,
} from '../src/contract/api.js'
import type { CanvasManifest } from '../src/contract/canvas-manifest.js'
import type { CommentsPayload } from '../src/contract/comments.js'
import type { FileEntry, Pr, ReviewArtifact } from '../src/contract/review-artifact.js'
import type { PrState } from '../src/contract/state.js'
import { readCanvasZip } from '../src/canvas/zip.js'
import { parseUnifiedDiff, toFileEntry, toPatchMap } from '../src/git/diff-collector.js'
import { fetchComments } from '../src/github/comments.js'
import { mapPull } from '../src/github/pr.js'
import { toPr } from '../src/host/pr.js'
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
  new ViewerError(501, 'NOT_IMPLEMENTED', `${what} is not available in the read-only viewer`, LOCAL_APP_HINT)

/** The canvas comment's envelope, as src/canvas/comment.ts writes it. */
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

/** The viewer posts nothing yet, signed in or not; the login names who is reading. */
function capabilitiesFor(login: string | null): Capabilities {
  return {
    canComment: false,
    tokenKind: login === null ? 'none' : 'github-app',
    login,
    reason: 'the viewer reads pull requests and posts nothing to GitHub',
    hint: LOCAL_APP_HINT,
  }
}

interface Diff {
  text: string
  files: FileEntry[]
  patches: Record<string, string>
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
    state: ViewerStateStore
    now?: () => Date
    /** Where an owner installs the GitHub App, to name in a not-found answer to a signed-in reader. */
    installUrl?: string
  }
) {
  const { gh, state } = deps
  const now = deps.now ?? (() => new Date())
  const repoPath = `repos/${target.owner}/${target.repo}`
  const diffs = new Map<string, Promise<Diff>>()
  let loading: Promise<Loaded> | null = null
  /** The canvas the bundle keyed its marks to, so a mark lands on the diff the reader saw. */
  let markedCanvas: MarkedCanvas | null = null

  function diffOf(mergeBaseSha: string, headSha: string): Promise<Diff> {
    const key = `${mergeBaseSha}...${headSha}`
    let found = diffs.get(key)
    if (found === undefined) {
      found = gh.diff(target.owner, target.repo, mergeBaseSha, headSha).then(text => {
        const collected = parseUnifiedDiff(text)
        return { text, files: collected.map(toFileEntry), patches: toPatchMap(collected) }
      })
      found.catch(() => diffs.delete(key))
      diffs.set(key, found)
    }
    return found
  }

  /** The newest canvas comment on the pull request, read like `pr-review import` reads a zip. */
  function findCanvas(comments: CommentsPayload, warnings: string[]): SharedCanvas | null {
    const newestFirst = [...comments.issueComments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const comment of newestFirst) {
      const match = CANVAS_ENVELOPE.exec(comment.body)
      if (match === null) continue
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
        warnings.push(
          `the canvas comment at ${comment.url} could not be read: ${err instanceof Error ? err.message : String(err)}`
        )
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
    const canvas = findCanvas(fetched.payload, warnings)
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
    const common = {
      pr,
      comments,
      capabilities: capabilitiesFor(await login()),
      selfReview: false,
      authorSignOffReason: null,
      chat: { enabled: false, acpx: false },
      canvasComment: false,
      mentionCanvas: true,
      skillCommand: `pr-review open ${pr.number}`,
      warnings,
    }

    if (canvas === null) {
      const head = await diffOf(pr.mergeBaseSha, pr.headSha)
      markedCanvas = pr
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
    const sameDiff = manifest.headSha === pr.headSha && manifest.mergeBaseSha === pr.mergeBaseSha
    let status: PrBundle['status'] = 'ready'
    let carriedOver: CarriedOverInfo | undefined
    let stale: StaleInfo | undefined
    if (!sameDiff) {
      const head = await diffOf(pr.mergeBaseSha, pr.headSha)
      if (head.text === own.text) {
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
    throw notInViewer(rest[0] === 'chat' ? 'AI chat' : 'posting to GitHub')
  }

  /** One request, answered as the server would: JSON, or the error envelope. */
  async function handle(method: string, url: URL, body: unknown): Promise<ApiAnswer> {
    try {
      return { status: 200, body: await route(method, url, body) }
    } catch (err) {
      if (err instanceof ViewerError) {
        const error: ErrorEnvelope['error'] = { code: err.code, message: err.message }
        if (err.hint !== undefined) error.hint = err.hint
        return { status: err.status, body: { error } }
      }
      const message = err instanceof Error ? err.message : String(err)
      if (!/HTTP 404/.test(message)) {
        return { status: 502, body: { error: { code: 'GITHUB_API_ERROR', message } } }
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
