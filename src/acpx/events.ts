/**
 * Turns acpx's `--format json` lines into the small event set the chat needs, and decides what
 * may be written to the raw event log.
 *
 * Verified against acpx 0.13.2 in the phase 6 spike: `--format json` prints one ACP JSON-RPC
 * message per line. `session/update` notifications carry `params.update.sessionUpdate`; the
 * `session/prompt` result carries `stopReason`; failures arrive as a JSON-RPC error whose
 * `data.detailCode` names the cause (`AUTH_REQUIRED` and friends).
 */

export const AGENT_ERROR_CODES = [
  'AGENT_AUTH_REQUIRED',
  'AGENT_PROTOCOL_INVALID',
  'AGENT_INCOMPLETE',
  'AGENT_TIMEOUT',
  'AGENT_PERMISSION_DENIED',
  'AGENT_NO_SESSION',
  'AGENT_USAGE',
  'AGENT_INTERRUPTED',
  'AGENT_FAILED',
  'AGENT_MISSING',
] as const
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number]

export type AgentEvent =
  | { type: 'chunk'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool'; id: string; title: string; status: string }
  | { type: 'usage'; used: number; size: number }
  | { type: 'plan'; entries: number }
  | { type: 'done'; stopReason: string }
  | { type: 'error'; code: AgentErrorCode; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One field by name. Reading through a helper keeps the literal-key lint rule happy. */
function read(source: Record<string, unknown>, key: string): unknown {
  return source[key]
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = read(source, key)
  return typeof value === 'string' ? value : undefined
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = read(source, key)
  return typeof value === 'number' ? value : 0
}

/** The text of an ACP content block, which is `{ type: 'text', text }` for everything we show. */
function contentText(value: unknown): string {
  if (!isRecord(value)) {
    return ''
  }
  return readString(value, 'text') ?? ''
}

/**
 * The event one acpx line means, or null for a line the chat ignores (the handshake, the command
 * list, session titles).
 */
export function mapAcpxMessage(message: unknown): AgentEvent | null {
  if (!isRecord(message)) {
    return { type: 'error', code: 'AGENT_PROTOCOL_INVALID', message: 'the agent wrote a line that is not a message' }
  }
  const error = read(message, 'error')
  if (isRecord(error)) {
    return mapErrorObject(error)
  }
  const result = read(message, 'result')
  if (isRecord(result)) {
    const stopReason = readString(result, 'stopReason')
    return stopReason === undefined ? null : { type: 'done', stopReason }
  }
  if (read(message, 'method') !== 'session/update') {
    return null
  }
  const params = read(message, 'params')
  const update = isRecord(params) ? read(params, 'update') : undefined
  return isRecord(update) ? mapUpdate(update) : null
}

function mapUpdate(update: Record<string, unknown>): AgentEvent | null {
  switch (read(update, 'sessionUpdate')) {
    case 'agent_message_chunk':
      return { type: 'chunk', text: contentText(read(update, 'content')) }
    case 'agent_thought_chunk':
      return { type: 'thought', text: contentText(read(update, 'content')) }
    case 'tool_call':
    case 'tool_call_update':
      return {
        type: 'tool',
        id: readString(update, 'toolCallId') ?? '',
        title: readString(update, 'title') ?? readString(update, 'kind') ?? 'tool',
        status: readString(update, 'status') ?? 'pending',
      }
    case 'usage_update':
      return { type: 'usage', used: readNumber(update, 'used'), size: readNumber(update, 'size') }
    case 'plan': {
      const entries = read(update, 'entries')
      return { type: 'plan', entries: Array.isArray(entries) ? entries.length : 0 }
    }
    default:
      return null
  }
}

/** acpx names the cause in `data.detailCode`; the JSON-RPC code alone says only "it failed". */
function mapErrorObject(error: Record<string, unknown>): AgentEvent {
  const data = read(error, 'data')
  const detail = isRecord(data) ? readString(data, 'detailCode') : undefined
  const message = readString(error, 'message') ?? 'the agent reported an error'
  return { type: 'error', code: detailCodeToAgentCode(detail), message }
}

export function detailCodeToAgentCode(detail: string | undefined): AgentErrorCode {
  switch (detail) {
    case 'AUTH_REQUIRED':
      return 'AGENT_AUTH_REQUIRED'
    case 'PERMISSION_DENIED':
      return 'AGENT_PERMISSION_DENIED'
    case 'TIMEOUT':
      return 'AGENT_TIMEOUT'
    case 'NO_SESSION':
      return 'AGENT_NO_SESSION'
    default:
      return 'AGENT_FAILED'
  }
}

/**
 * What an acpx exit code means. Verified in the spike: a usage error exits 2, a failed spawn
 * exits 1, and acpx's own `--timeout` exits 0 with no terminal event at all.
 */
export function exitCodeToAgentCode(code: number): AgentErrorCode | null {
  switch (code) {
    case 0:
      return null
    case 2:
      return 'AGENT_USAGE'
    case 3:
      return 'AGENT_TIMEOUT'
    case 4:
      return 'AGENT_NO_SESSION'
    case 5:
      return 'AGENT_PERMISSION_DENIED'
    case 130:
      return 'AGENT_INTERRUPTED'
    default:
      return 'AGENT_FAILED'
  }
}

export function exitCodeMessage(code: number): string {
  switch (code) {
    case 2:
      return 'acpx rejected the command line'
    case 3:
      return 'acpx timed out waiting for the agent'
    case 4:
      return 'the chat session no longer exists'
    case 5:
      return 'the agent was denied a permission it needed'
    case 130:
      return 'the agent was interrupted'
    default:
      return `acpx exited with code ${code}`
  }
}

/**
 * Lines the raw event log may keep, with everything sensitive taken out.
 *
 * `--suppress-reads` blanks the visible tool output but leaves the file's content under
 * `_meta.claudeCode.toolResponse`, so `_meta` is dropped everywhere. Two whole lines are dropped
 * as well: the auth notification names the signed-in account, and acpx echoes the `session/prompt`
 * request, whose text holds the lines the reader selected.
 */
export function scrubForLog(message: unknown): unknown | null {
  if (!isRecord(message)) {
    return null
  }
  const method = read(message, 'method')
  if (method === '_auth/status_update' || method === 'session/prompt') {
    return null
  }
  const params = read(message, 'params')
  const update = isRecord(params) ? read(params, 'update') : undefined
  if (isRecord(update)) {
    const kind = read(update, 'sessionUpdate')
    if (kind === 'available_commands_update') {
      return null
    }
  }
  return withoutMeta(message)
}

function withoutMeta(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutMeta)
  }
  if (!isRecord(value)) {
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === '_meta') {
      continue
    }
    out[key] = withoutMeta(item)
  }
  return out
}
