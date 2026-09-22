import type { z } from 'zod'
import type { CanvasManifest } from './canvas-manifest.js'
import type { CommentsPayload, IssueComment, ReviewComment } from './comments.js'
import type { SharedCanvasInfoSchema } from './discovery.js'
import type { FileEntry, Pr, ReviewArtifact } from './review-artifact.js'
import type { LocalKey, ReviewKey } from './review-key.js'
import type { LayerView } from './settings.js'
import type { PrState } from './state.js'

export const ERROR_CODES = [
  'BAD_REQUEST',
  'NOT_FOUND',
  'FORBIDDEN_HOST',
  'CROSS_ORIGIN',
  'NOT_A_REPO',
  'NO_ORIGIN',
  'GIT_ERROR',
  'GH_MISSING',
  'GH_UNAUTHENTICATED',
  'GITHUB_API_ERROR',
  'GLAB_MISSING',
  'GLAB_UNAUTHENTICATED',
  'GITLAB_API_ERROR',
  'PR_NOT_FOUND',
  'CANVAS_NOT_FOUND',
  'CANVAS_INVALID',
  'CANVAS_REPO_MISMATCH',
  'CANVAS_PR_MISMATCH',
  'CANVAS_TOO_LARGE',
  'CANVAS_STALE',
  'MODEL_INVALID',
  'SKILL_DIR_EXISTS',
  'COMMENT_FORBIDDEN',
  'COMMENT_LINE_NOT_IN_DIFF',
  'SIGNOFF_INCOMPLETE',
  'CHAT_BUSY',
  'NOT_IMPLEMENTED',
  'INTERNAL',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorEnvelope {
  /** `issues` names what a rejected file got wrong, one line each, never its content. */
  error: { code: ErrorCode; message: string; hint?: string; issues?: string[] }
}

export type BundleStatus = 'missing' | 'ready' | 'stale' | 'error'

export interface Capabilities {
  canComment: boolean | 'unknown'
  tokenKind: string
  login: string | null
  reason?: string
  hint?: string
}

export interface CanvasInfo {
  headSha: string
  source: 'local' | 'import' | 'fixture'
  manifest: CanvasManifest | null
  importedAt?: string
}

/** How a canvas for another commit relates to the PR head: behind it, or off a discarded branch. */
export type CanvasRelation = 'ancestor' | 'unrelated'

export interface StaleInfo {
  canvasHeadSha: string
  currentHeadSha: string
  relation: CanvasRelation
  commitsBehind?: number
}

/**
 * A ready canvas generated for an earlier commit of the pull request whose diff is identical to
 * the head's, so the page keeps it and says so.
 */
export interface CarriedOverInfo {
  canvasHeadSha: string
  currentHeadSha: string
  /** How many commits the head is ahead of the canvas's commit; absent when the head does not contain it. */
  commitsBehind?: number
}

/** The answer of `POST /import`, of `pr-review import`, and of an imported shared canvas. */
export interface ImportResult {
  status: 'ready' | 'stale' | 'exists'
  headSha: string
  currentHeadSha: string
  relation?: CanvasRelation
  commitsBehind?: number
  /** True when the diffs of this canvas can be rebuilt from the local clone. */
  derivable: boolean
  warnings: string[]
}

/** The answer of `POST /shared-canvas/fetch`. */
export interface SharedCanvasFetchResponse {
  imported: boolean
  status: 'ready' | 'stale' | 'missing'
  sharedCanvas: SharedCanvasInfo | null
  warnings: string[]
}

/** A canvas zip found on the pull request. Shaped by the schema the discovery cache stores. */
export type SharedCanvasInfo = z.infer<typeof SharedCanvasInfoSchema>

/** The forge the server talks to, as the page and the health endpoint learn it. */
export interface PublicHost {
  kind: 'github' | 'gitlab'
  /** `GitHub` or `GitLab`, for the words on the page. */
  label: string
  /** `https://github.com` or the GitLab instance, for links to profiles. */
  webBase: string
}

export interface PrBundle {
  status: BundleStatus
  pr: Pr
  files: FileEntry[]
  derivable: boolean
  artifact?: ReviewArtifact
  canvas?: CanvasInfo
  stale?: StaleInfo
  /** Set on a ready bundle whose canvas was generated for another commit with an identical diff. */
  carriedOver?: CarriedOverInfo
  sharedCanvas?: SharedCanvasInfo
  skillCommand: string
  /** Set on a local review: work that has no pull request, so the forge side of the page is off. */
  local?: LocalKey
  comments: CommentsPayload
  state: PrState
  capabilities: Capabilities
  /** From the project config plus the acpx check; the client hides the pane when either says no. */
  chat: ChatStatus
  /** More than 400 files or 50 000 changed lines: the page says the canvas was capped. */
  largePr: boolean
  error?: ErrorEnvelope['error']
  warnings: string[]
}

/** Every answer of a state route, so the page can replace its copy of the state in one step. */
export interface StateResponse {
  /** The target the state belongs to: a pull request number, or `local`. */
  prNumber: ReviewKey
  state: PrState
}

export type PostCommentResponse = (
  | { kind: 'review'; comment: ReviewComment }
  | { kind: 'issue'; comment: IssueComment }
) & { state: PrState }

/** The review GitHub created, as the page shows it: a link and its state. */
export interface ReviewSummary {
  id: number
  state: string
  url: string
  submittedAt: string | null
}

/** What the sign-off dialog shows before anything is posted. */
export interface ReviewBodyResponse {
  headSha: string
  body: string
  /** The titles of the layers that still need a look; approve is refused while this is not empty. */
  unreviewed: string[]
}

export interface PostReviewResponse {
  review: ReviewSummary
}

export interface PatchesResponse {
  headSha: string
  patches: Record<string, string>
}

export interface ContextResponse {
  path: string
  side: 'new' | 'old'
  from: number
  to: number
  lines: string[]
}

export interface HealthCheck {
  ok: boolean
  detail?: string
}

export interface HealthResponse {
  ok: boolean
  version: string
  checks: {
    git: HealthCheck
    origin: HealthCheck
    gh: HealthCheck
    ghAuth: HealthCheck
    /** Chat only; absent when the project config turns chat off. */
    acpx?: HealthCheck
    agentInstalled?: HealthCheck
    agentAuth?: HealthCheck
  }
  repo: { owner: string; name: string } | null
  host: PublicHost
  dataDir: string
  chat: ChatStatus
}

/** What the page needs to decide whether to draw the AI Chat pane, and what to say when it cannot. */
export interface ChatStatus {
  enabled: boolean
  /** False when acpx is not on PATH: the pane is hidden and a banner says why. */
  acpx: boolean
  agent?: string
  model?: string | null
}

export interface HomeData {
  recentPrs: Array<{ number: number; title: string; updatedAt: string }>
}

/** The JSON the review page carries in its bootstrap script; the app reads it before any request. */
export interface ReviewBootstrap {
  prNumber: ReviewKey
  owner: string
  repo: string
  version: string
  host: PublicHost
  /** Whether the canvas shows every layer, or one at a time, from the settings file. */
  layerView: LayerView
}
