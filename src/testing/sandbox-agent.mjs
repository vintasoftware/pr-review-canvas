// Minimal ACP adapter for testing the real acpx session and queue machinery without a model.
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

let cwd
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  let result = {}
  switch (message.method) {
    case 'initialize':
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }
      break
    case 'session/new':
      cwd = message.params.cwd
      result = { sessionId: 'sandbox-fixture' }
      break
    case 'session/load':
      cwd = message.params.cwd
      break
    case 'session/prompt': {
      let text = 'write unexpectedly succeeded'
      try {
        writeFileSync(path.join(cwd, 'victim.txt'), 'destroyed')
      } catch (error) {
        text = `blocked: ${error.code}`
      }
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      } })
      result = { stopReason: 'end_turn' }
      break
    }
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result })
}
