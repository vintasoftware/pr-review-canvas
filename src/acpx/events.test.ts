// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../paths.js'
import {
  type AgentEvent,
  detailCodeToAgentCode,
  exitCodeMessage,
  exitCodeToAgentCode,
  mapAcpxMessage,
  scrubForLog,
} from './events.js'

const FIXTURES = path.join(PACKAGE_ROOT, '__fixtures__', 'acpx')

/** The fixtures were captured from a real `acpx 0.13.2 --format json` run in the phase 6 spike. */
async function fixtureLines(name: string): Promise<unknown[]> {
  const text = await readFile(path.join(FIXTURES, name), 'utf8')
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as unknown)
}

function eventsOf(messages: unknown[]): AgentEvent[] {
  return messages.map(mapAcpxMessage).filter((e): e is AgentEvent => e !== null)
}

describe('mapAcpxMessage', () => {
  it('shows dcg’s denial in the failed tool status without retaining unrelated output', () => {
    const reason = 'Blocked by dcg (cloud.aws:s3-rb): aws s3 rb removes the entire S3 bucket.'
    expect(
      mapAcpxMessage({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'guarded',
            status: 'failed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: `Private tool output\n${reason}\nMore private output` },
              },
            ],
          },
        },
      })
    ).toEqual({ type: 'tool', id: 'guarded', status: 'failed', title: reason })
  })

  it('keeps the tool title when a failed tool carries no dcg denial', () => {
    const failed = (content: unknown) => ({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'x',
          title: 'Bash',
          status: 'failed',
          content,
        },
      },
    })
    const expected = { type: 'tool', id: 'x', status: 'failed', title: 'Bash' }
    expect(mapAcpxMessage(failed('not a list'))).toEqual(expected)
    expect(mapAcpxMessage(failed(['not a block']))).toEqual(expected)
    expect(mapAcpxMessage(failed([{ type: 'content', content: { type: 'text', text: 'exit 1' } }]))).toEqual(
      expected
    )
  })

  it('maps a real claude turn to chunks, tool calls, usage, and the stop reason', async () => {
    const events = eventsOf(await fixtureLines('claude-turn.ndjson'))
    const kinds = events.map(e => e.type)
    expect(kinds).toEqual([
      'usage',
      'tool',
      'tool',
      'tool',
      'usage',
      'tool',
      'tool',
      'usage',
      'chunk',
      'chunk',
      'chunk',
      'usage',
      'usage',
      'done',
    ])
    expect(events.filter(e => e.type === 'chunk').map(e => e.text)).toEqual([
      '`',
      '@vinta-bb/',
      'building-blocks`',
    ])
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
    expect(events.find(e => e.type === 'tool')).toEqual({
      type: 'tool',
      id: 'toolu_01VZijugNKKcARRYqgz87fHG',
      title: 'Read File',
      status: 'pending',
    })
  })

  it('maps a real codex auth failure to AGENT_AUTH_REQUIRED', async () => {
    const events = eventsOf(await fixtureLines('codex-auth-required.ndjson'))
    expect(events).toEqual([
      {
        type: 'error',
        code: 'AGENT_AUTH_REQUIRED',
        message: 'agent advertised auth methods [api-key, chat-gpt] but no matching credentials found',
      },
    ])
  })

  it('ignores a session update whose params are not an object', () => {
    expect(mapAcpxMessage({ method: 'session/update', params: 'oops' })).toBeNull()
  })

  it('maps a thought chunk and a plan', () => {
    const update = (u: unknown) => ({ jsonrpc: '2.0', method: 'session/update', params: { update: u } })
    expect(
      mapAcpxMessage(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }))
    ).toEqual({ type: 'thought', text: 'hmm' })
    expect(mapAcpxMessage(update({ sessionUpdate: 'plan', entries: [1, 2, 3] }))).toEqual({
      type: 'plan',
      entries: 3,
    })
    expect(mapAcpxMessage(update({ sessionUpdate: 'plan' }))).toEqual({ type: 'plan', entries: 0 })
    expect(mapAcpxMessage(update({ sessionUpdate: 'usage_update' }))).toEqual({
      type: 'usage',
      used: 0,
      size: 0,
    })
  })

  it('reads a tool call that names only its kind, and content that is not text', () => {
    const update = (u: unknown) => ({ method: 'session/update', params: { update: u } })
    expect(mapAcpxMessage(update({ sessionUpdate: 'tool_call', kind: 'read' }))).toEqual({
      type: 'tool',
      id: '',
      title: 'read',
      status: 'pending',
    })
    expect(mapAcpxMessage(update({ sessionUpdate: 'agent_message_chunk', content: 'plain' }))).toEqual({
      type: 'chunk',
      text: '',
    })
    expect(
      mapAcpxMessage(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } }))
    ).toEqual({
      type: 'chunk',
      text: '',
    })
  })

  it('ignores the handshake, the command list, and results without a stop reason', () => {
    expect(mapAcpxMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} })).toBeNull()
    expect(mapAcpxMessage({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1 } })).toBeNull()
    expect(
      mapAcpxMessage({
        method: 'session/update',
        params: { update: { sessionUpdate: 'session_info_update' } },
      })
    ).toBeNull()
    expect(mapAcpxMessage({ method: 'session/update', params: {} })).toBeNull()
    expect(mapAcpxMessage({ method: 'session/cancel', params: {} })).toBeNull()
  })

  it('reports a line that is not a message as a protocol failure', () => {
    expect(mapAcpxMessage('nope')).toEqual({
      type: 'error',
      code: 'AGENT_PROTOCOL_INVALID',
      message: 'the agent wrote a line that is not a message',
    })
    expect(mapAcpxMessage([1, 2])).toEqual({
      type: 'error',
      code: 'AGENT_PROTOCOL_INVALID',
      message: 'the agent wrote a line that is not a message',
    })
  })

  it('falls back to AGENT_FAILED for an error it has no detail code for', () => {
    expect(mapAcpxMessage({ error: { code: -1 } })).toEqual({
      type: 'error',
      code: 'AGENT_FAILED',
      message: 'the agent reported an error',
    })
  })
})

describe('detailCodeToAgentCode', () => {
  it('maps every detail code the runner acts on', () => {
    expect(detailCodeToAgentCode('AUTH_REQUIRED')).toBe('AGENT_AUTH_REQUIRED')
    expect(detailCodeToAgentCode('PERMISSION_DENIED')).toBe('AGENT_PERMISSION_DENIED')
    expect(detailCodeToAgentCode('TIMEOUT')).toBe('AGENT_TIMEOUT')
    expect(detailCodeToAgentCode('NO_SESSION')).toBe('AGENT_NO_SESSION')
    expect(detailCodeToAgentCode('SOMETHING_ELSE')).toBe('AGENT_FAILED')
    expect(detailCodeToAgentCode(undefined)).toBe('AGENT_FAILED')
  })
})

describe('exitCodeToAgentCode', () => {
  it('covers the table acpx documents', () => {
    expect(exitCodeToAgentCode(0)).toBeNull()
    expect(exitCodeToAgentCode(1)).toBe('AGENT_FAILED')
    expect(exitCodeToAgentCode(2)).toBe('AGENT_USAGE')
    expect(exitCodeToAgentCode(3)).toBe('AGENT_TIMEOUT')
    expect(exitCodeToAgentCode(4)).toBe('AGENT_NO_SESSION')
    expect(exitCodeToAgentCode(5)).toBe('AGENT_PERMISSION_DENIED')
    expect(exitCodeToAgentCode(130)).toBe('AGENT_INTERRUPTED')
  })

  it('says what each exit code means', () => {
    expect([1, 2, 3, 4, 5, 130].map(exitCodeMessage)).toEqual([
      'acpx exited with code 1',
      'acpx rejected the command line',
      'acpx timed out waiting for the agent',
      'the chat session no longer exists',
      'the agent was denied a permission it needed',
      'the agent was interrupted',
    ])
  })
})

describe('scrubForLog', () => {
  it('drops the file content --suppress-reads leaves under _meta', () => {
    const line = {
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          content: [{ type: 'content', content: { type: 'text', text: '[read output suppressed]' } }],
          _meta: { claudeCode: { toolResponse: { file: { content: 'SECRET' } } } },
        },
      },
    }
    expect(scrubForLog(line)).toEqual({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          content: [{ type: 'content', content: { type: 'text', text: '[read output suppressed]' } }],
        },
      },
    })
  })

  it('keeps the signed-in account out of the log entirely', async () => {
    const lines = await fixtureLines('codex-auth-required.ndjson')
    const logged = lines.map(scrubForLog).filter(l => l !== null)
    expect(JSON.stringify(logged)).not.toContain('example.com')
  })

  it('drops the command list and anything that is not a message', () => {
    expect(
      scrubForLog({
        method: 'session/update',
        params: { update: { sessionUpdate: 'available_commands_update' } },
      })
    ).toBeNull()
    expect(scrubForLog('nope')).toBeNull()
  })

  it('keeps an ordinary chunk as it is, arrays included', () => {
    const line = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'plan', entries: [{ n: 1 }] } },
    }
    expect(scrubForLog(line)).toEqual(line)
  })
})

describe('scrubForLog and the prompt echo', () => {
  it('drops the prompt acpx echoes back, which carries the lines the reader selected', () => {
    const echoed = {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 's1', prompt: [{ type: 'text', text: '42: const secret = readKey()' }] },
    }
    expect(scrubForLog(echoed)).toBeNull()
  })
})
