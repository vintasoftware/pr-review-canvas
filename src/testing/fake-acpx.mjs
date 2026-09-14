#!/usr/bin/env node
// A stand-in for acpx, so the spawn path of the runner is tested against a real child process
// instead of a mock. The scenario comes from FAKE_ACPX_MODE; the argument list is echoed to
// FAKE_ACPX_ARGV_FILE when that variable is set, so a test can assert what was spawned.

import { appendFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_ACPX_MODE ?? 'ok'
const argvFile = process.env.FAKE_ACPX_ARGV_FILE

const write = line => {
  process.stdout.write(`${line}\n`)
}
const json = value => write(JSON.stringify(value))

const update = update_ =>
  json({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: update_ } })
const chunk = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

if (argvFile !== undefined) {
  appendFileSync(argvFile, `${JSON.stringify(argv)}\n`)
}

if (argv.includes('--version')) {
  write('0.13.2-fake')
  process.exit(0)
}

if (argv.includes('cancel')) {
  if (process.env.FAKE_ACPX_CANCEL_FILE !== undefined) {
    writeFileSync(process.env.FAKE_ACPX_CANCEL_FILE, JSON.stringify(argv))
  }
  json({ action: 'cancel_result', cancelled: true })
  process.exit(0)
}

const readStdin = async () => {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const part of process.stdin) {
    text += part
  }
  return text
}

const main = async () => {
  const prompt = argv.includes('-f') ? await readStdin() : ''
  if (process.env.FAKE_ACPX_PROMPT_FILE !== undefined) {
    writeFileSync(process.env.FAKE_ACPX_PROMPT_FILE, prompt)
  }
  switch (mode) {
    case 'ok':
      // A line the chat ignores, which every real turn also carries.
      update({ sessionUpdate: 'session_info_update', title: 'a turn' })
      update({ sessionUpdate: 'usage_update', used: 10, size: 100 })
      chunk('Yes. ')
      chunk('Covered at `src/a.ts:10`.')
      json({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } })
      process.exit(0)
      break
    case 'suppressed-read':
      // What acpx really writes with --suppress-reads: the visible output is blanked but the
      // file content is still under _meta.
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        title: 'Read package.json',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '[read output suppressed]' } }],
        _meta: { claudeCode: { toolResponse: { file: { content: 'SECRET FILE BODY' } } } },
      })
      chunk('done')
      json({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } })
      process.exit(0)
      break
    case 'incomplete':
      chunk('half an ans')
      process.exit(0)
      break
    case 'silent':
      json({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } })
      process.exit(0)
      break
    case 'incomplete-exec':
      // What acpx does when its own --timeout elapses: output, exit 0, no terminal event.
      chunk('half an answer')
      process.exit(0)
      break
    case 'auth':
      json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: 'agent advertised auth methods but no matching credentials found',
          data: { acpxCode: 'RUNTIME', detailCode: 'AUTH_REQUIRED' },
        },
      })
      process.exit(1)
      break
    case 'usage':
      process.stderr.write("error: unknown option '--nope'\n")
      process.exit(2)
      break
    case 'protocol':
      write('this is not json')
      process.exit(0)
      break
    case 'bigline':
      write(`{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`)
      process.exit(0)
      break
    case 'hang':
      chunk('thinking')
      // Stays alive until the runner stops it; the timer keeps the event loop busy.
      setInterval(() => undefined, 1000)
      break
    default:
      process.stderr.write(`unknown FAKE_ACPX_MODE: ${mode}\n`)
      process.exit(1)
  }
}

void main()
