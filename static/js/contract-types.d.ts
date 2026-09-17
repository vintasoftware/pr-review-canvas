// Type-only bridge so the browser modules (JSDoc) see the same contract as the server.

export type {
  CanvasRelation,
  Capabilities,
  ChatStatus,
  ErrorEnvelope,
  ImportResult,
  MergesSinceInfo,
  PatchesResponse,
  PostCommentResponse,
  PostReviewResponse,
  PrBundle,
  PublicHost,
  ReviewBodyResponse,
  ReviewSummary,
  SharedCanvasFetchResponse,
  SharedCanvasInfo,
  StaleInfo,
  StateResponse,
} from '../../src/contract/api.js'
export type {
  ChatEvent,
  ChatHistoryResponse,
  ChatThreadsResponse,
  ChatTurn,
} from '../../src/contract/chat.js'
export type {
  CommentsPayload,
  IssueComment,
  PostCommentInput,
  ReviewComment,
} from '../../src/contract/comments.js'
export type {
  Annotation,
  CodeFold,
  Diagram,
  FileEntry,
  Hunk,
  Layer,
  LayerFile,
  Point,
  Pr,
  ReviewArtifact,
  RiskTag,
  Side,
  TestEntry,
} from '../../src/contract/review-artifact.js'
export type {
  AgentAvailability,
  AgentProbeResult,
  AgentsResponse,
  AppearanceInput,
  AppearanceResponse,
  ChatAgent,
  Settings,
  SettingsInput,
  SettingsResponse,
  Theme,
} from '../../src/contract/settings.js'
export type { PrState } from '../../src/contract/state.js'
