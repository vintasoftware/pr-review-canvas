import { z } from 'zod'
import { SideSchema } from './review-artifact.js'

// The context helpers live in static/js/chat-context.js so the browser can load them without a
// bundler; the server imports the same code here.
export type { ChatContext } from '../../static/js/chat-context.js'
export {
  chatContextAttrs,
  chatContextFromElement,
  chatContextLabel,
  sameChatContext,
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

export const ChatSendSchema = z.object({
  message: z.string().min(1).max(CHAT_MESSAGE_MAX),
  context: ChatContextSchema,
  /** The thread to answer in; the active one when absent. */
  thread: z.string().min(1).max(200).optional(),
})
export type ChatSendInput = z.infer<typeof ChatSendSchema>

export const ChatThreadInputSchema = z.object({ agent: z.string().min(1).max(40).optional() })

/** One saved turn of a thread, as `chat/<name>.jsonl` stores it. */
export const ChatTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  at: z.string(),
  context: ChatContextSchema.optional(),
  /** Why the turn ended, on an assistant turn that did not finish. */
  incomplete: z.string().optional(),
})
export type ChatTurn = z.infer<typeof ChatTurnSchema>

export interface ChatThreadsResponse {
  threads: Array<{ name: string; agent: string; title: string; createdAt: string }>
  activeThread: string | null
  /** The agent the next thread would use, from the settings plus any flag override. */
  agent: string
}

export interface ChatHistoryResponse {
  name: string
  turns: ChatTurn[]
}

/** The SSE frames the chat route writes, named the same on both sides. */
export const CHAT_EVENTS = ['turn', 'chunk', 'thought', 'tool', 'done', 'error', 'cancelled'] as const
export type ChatEventName = (typeof CHAT_EVENTS)[number]

export type ChatEvent =
  | { event: 'turn'; thread: string; agent: string; seeded: boolean }
  | { event: 'chunk'; text: string }
  | { event: 'thought'; text: string }
  | { event: 'tool'; id: string; title: string; status: string }
  | { event: 'done'; stopReason: string }
  | { event: 'error'; code: string; message: string; hint?: string }
  | { event: 'cancelled' }
