// Offline native-tool integration: the model endpoint and the AWS executable are fixtures.
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const agent = process.argv[2]
const fixture = mkdtempSync(path.join(os.tmpdir(), 'native-guard-'))
// Do not inherit real provider credentials or switches to Bedrock/Vertex/other endpoints.
const env = { PATH: process.env.PATH, HOME: fixture, CODEX_HOME: path.join(fixture, '.codex'), CLAUDE_CONFIG_DIR: path.join(fixture, '.claude'), TMPDIR: fixture }
mkdirSync(env.CODEX_HOME)
mkdirSync(env.CLAUDE_CONFIG_DIR)
if (agent === 'codex') {
  const policy = execFileSync(process.execPath, [fileURLToPath(new URL('../acpx/codex-chat.mjs', import.meta.url)), '--policy'], { env, cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), policy)
}
const marker = path.join(fixture, 'remote-command-ran')
const fakeAws = path.join(fixture, 'aws')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
writeFileSync(fakeAws, `#!/bin/sh\nprintf executed > ${quote(marker)}\n`, { mode: 0o700 })
const command = `${quote(fakeAws)} s3 rb s3://pr-review-disposable-probe --force`
let toolSent = false
let denialSeen = false
let toolOffered = false
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  let body
  try { body = JSON.parse(raw) } catch { response.writeHead(200); response.end('{}'); return }
  const serialized = JSON.stringify(body)
  if (serialized.includes('Blocked by dcg') && serialized.includes('s3-rb')) denialSeen = true
  if (request.url.includes('count_tokens') || (!request.url.includes('messages') && !request.url.includes('responses'))) {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
  const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
  if (agent === 'claude') {
    if (!body.tools?.some(tool => tool.name === 'Bash')) { response.end(); return }
    toolOffered = true
    const call = !toolSent
    toolSent = true
    event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'tool_fixture', name: 'Bash', input: {} } : { type: 'text', text: '' } })
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'Disposable guard probe' }) } : { type: 'text_delta', text: 'Guard probe complete.' } })
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    event('message_stop', { type: 'message_stop' })
  } else {
    const tool = body.tools?.find(tool => ['exec_command', 'shell_command', 'shell'].includes(tool.name))
    if (!tool) { response.end(); return }
    toolOffered = true
    const call = !toolSent
    toolSent = true
    const args = tool.name === 'exec_command' ? { cmd: command } : tool.name === 'shell' ? { command: ['/bin/sh', '-c', command] } : { command }
    const item = call
      ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: tool.name, arguments: JSON.stringify(args), status: 'completed' }
      : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Guard probe complete.', annotations: [] }] }
    event('response.created', { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } })
    event('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item })
    event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
    event('response.completed', { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
  }
  response.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
let child
try {
  if (agent === 'codex') {
    const config = path.join(env.CODEX_HOME, 'config.toml')
    writeFileSync(config, `model_provider = "fixture"\nmodel = "fixture-model"\n${readFileSync(config, 'utf8')}\n[model_providers.fixture]\nname = "fixture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
  }
  const entry = fileURLToPath(new URL('../acpx/chat-acpx.mjs', import.meta.url))
  child = spawn(process.execPath, [entry, '--cwd', fixture, '--format', 'json', '--json-strict', '--approve-reads', '--no-terminal', '--suppress-reads', '--non-interactive-permissions', 'deny', '--timeout', '60', agent, 'exec', 'Run the disposable probe.'], {
    env: { ...env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'fixture-only', OPENAI_API_KEY: 'fixture-only', CODEX_API_KEY: 'fixture-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', npm_config_cache: process.env.npm_config_cache ?? path.join(os.homedir(), '.npm') },
    cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
  clearTimeout(timer)
  const visibleDenial = stdout.split('\n').some(line => {
    try {
      const update = JSON.parse(line).params?.update
      return (update?.status === 'failed' || update?.sessionUpdate === 'agent_message_chunk') && JSON.stringify(update.content).includes('Blocked by dcg')
    } catch { return false }
  })
  if (!toolOffered || !toolSent || !denialSeen || !visibleDenial || existsSync(marker)) {
    throw new Error(`${agent}: toolOffered=${toolOffered}, toolSent=${toolSent}, denialSeen=${denialSeen}, visibleDenial=${visibleDenial}, executed=${existsSync(marker)}\n${stdout.slice(-6000)}\n${stderr.slice(-2000)}`)
  }
  process.stdout.write(`${agent}: dcg denied native AWS tool before execution and explained the denial to the model\n`)
} finally {
  child?.kill()
  server.closeAllConnections()
  server.close()
  rmSync(fixture, { recursive: true, force: true })
}
