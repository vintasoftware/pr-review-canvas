import { z } from 'zod'
import type { ChatContext } from '../../static/js/chat-context.js'
import { SideSchema } from './review-artifact.js'

// The context helpers live in static/js/chat-context.js so the browser can load them without a
// bundler; the server imports the same code here.
export type { ChatContext } from '../../static/js/chat-context.js'
export {
  chatContextAttrs,
  chatContextFromElement,
  chatContextLabel,
  sameChatContext,
  threadOfPlace,
  tourPlaceLabel,
  WHOLE_PR,
} from '../../static/js/chat-context.js'

export const ChatContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr') }),
  z.object({ kind: z.literal('layer'), layerId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(1024) }),
  z.object({
    kind: z.literal('lines'),
    path: z.string().min(1).max(1024),
    side: SideSchema,
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('point'), fingerprint: z.string().min(1).max(200) }),
])

/** A message longer than this is a paste, not a question. */
export const CHAT_MESSAGE_MAX = 8000

/** How many of a thread's answers the reader has not seen. */
export const ChatUnseenSchema = z.object({ unseen: z.number().int().min(0).max(1000) })

export const ChatSendSchema = z.object({
  message: z.string().min(1).max(CHAT_MESSAGE_MAX),
  context: ChatContextSchema,
  /**
   * The thread to answer in, while it is the chat agent's. Absent, the question goes to its
   * place's thread when the reader keeps a thread per place, or starts a new thread.
   */
  thread: z.string().min(1).max(200).optional(),
})
export type ChatSendInput = z.infer<typeof ChatSendSchema>

const TourDecisionPlace = z.object({ kind: z.literal('tour-decision'), key: z.string().min(1).max(40) })
const TourPlanPlace = z.object({ kind: z.literal('tour-plan') })

/** The contexts a grilling turn may name: one decision the reader wants changed, or the plan as a whole. */
export const TourGrillContextSchema = z.discriminatedUnion('kind', [TourDecisionPlace, TourPlanPlace])
export type TourGrillContext = z.infer<typeof TourGrillContextSchema>

/**
 * The places of a tour a reader asks AI Chat about, one per step: the tour as a whole (the cover),
 * a landmark, a decision, a quiz question, or the plan. Each has its own thread.
 */
export const TourPlaceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tour') }),
  z.object({ kind: z.literal('tour-landmark'), id: z.string().min(1).max(40) }),
  TourDecisionPlace,
  z.object({ kind: z.literal('tour-question'), id: z.string().min(1).max(40) }),
  TourPlanPlace,
])
export type TourPlace = z.infer<typeof TourPlaceSchema>

export const TourChatSendSchema = z.object({
  message: z.string().min(1).max(CHAT_MESSAGE_MAX),
  context: TourPlaceSchema,
  /** The tour thread to answer in, while it is the chat agent's; absent, the place's thread. */
  thread: z.string().min(1).max(200).optional(),
})
export type TourChatSendInput = z.infer<typeof TourChatSendSchema>

export const TourGrillSendSchema = z.object({
  message: z.string().min(1).max(CHAT_MESSAGE_MAX),
  context: TourGrillContextSchema,
})
export type TourGrillSendInput = z.infer<typeof TourGrillSendSchema>

export const ChatThreadInputSchema = z.object({ agent: z.string().min(1).max(40).optional() })

/** One saved turn of a thread, as `chat/<name>.jsonl` stores it. */
export const ChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.string(),
  /** What the turn pointed at: the canvas's contexts in a canvas thread, the tour's in a tour's. */
  context: z.union([ChatContextSchema, TourPlaceSchema]).optional(),
  /** Why the turn ended, on an assistant turn that did not finish. */
  incomplete: z.string().optional(),
  /**
   * On an assistant turn whose review checkout failed: why, and the branch of the reader's
   * checkout it read instead.
   */
  fallback: z.object({ message: z.string(), branch: z.string().nullable() }).optional(),
})
export type ChatTurn = z.infer<typeof ChatTurnSchema>

export interface ChatThreadsResponse {
  threads: Array<{
    name: string
    agent: string
    title: string
    createdAt: string
    /** The turns the thread has taken. */
    turns: number
    anchor?: ChatContext
    /** The answers the reader has not seen there yet. */
    unseen?: number
  }>
  activeThread: string | null
  /** The agent the next thread would use, from the settings plus any flag override. */
  agent: string
}

/** The tour chat's threads of a review: every thread has a place. */
export interface TourChatThreadsResponse {
  threads: Array<{
    name: string
    agent: string
    title: string
    createdAt: string
    /** The turns the thread has taken. */
    turns: number
    place: TourPlace
    /** The answers the reader has not seen there yet. */
    unseen?: number
  }>
  /** The agent the next thread would use, from the settings plus any flag override. */
  agent: string
}

export interface ChatHistoryResponse {
  name: string
  turns: ChatTurn[]
}

/** The SSE frames the chat route writes, named the same on both sides. */
export const CHAT_EVENTS = [
  'turn',
  'checkout',
  'chunk',
  'thought',
  'tool',
  'done',
  'error',
  'cancelled',
] as const
export type ChatEventName = (typeof CHAT_EVENTS)[number]

/**
 * A review checkout for one turn: `preparing` comes before it is created (`creating`) or moved to
 * `sha`; `fallback` says it failed and the reader's checkout, on `branch`, is read instead.
 */
export type ChatCheckoutEvent =
  | { event: 'checkout'; status: 'preparing'; sha: string; creating: boolean }
  | { event: 'checkout'; status: 'fallback'; message: string; branch: string | null }

export type ChatEvent =
  | { event: 'turn'; thread: string; agent: string; seeded: boolean }
  | ChatCheckoutEvent
  | { event: 'chunk'; text: string }
  | { event: 'thought'; text: string }
  | { event: 'tool'; id: string; title: string; status: string }
  | { event: 'done'; stopReason: string }
  | { event: 'error'; code: string; message: string; hint?: string }
  | { event: 'cancelled' }
