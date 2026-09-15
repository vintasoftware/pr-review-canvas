#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { checkGuard } from './dcg-guard.mjs'
import { executable, preToolUse, run } from './guard-process.mjs'

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, val]) => `${JSON.stringify(key)}=${toml(val)}`).join(',')}}`
  return JSON.stringify(value)
}

/** Query the same app-server binary/configuration that the adapter will use. No model call. */
function listHooks(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    let finished = false
    const finish = (error, data) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      lines.close()
      child.kill()
      if (error) reject(error); else resolve(data)
    }
    const timer = setTimeout(() => finish(new Error('Codex hook verification timed out.')), 15_000)
    child.on('error', error => finish(error))
    child.on('exit', () => finish(new Error('Codex exited before verifying its required chat hook.')))
    child.stderr.resume()
    child.stdin.on('error', error => finish(error))
    lines.on('line', line => {
      try {
        const message = JSON.parse(line)
        if (message.id !== 1 && message.id !== 2) return
        if (message.error) throw new Error(message.error.message)
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [process.cwd()] } })}\n`)
        } else finish(null, message.result)
      } catch (error) { finish(error) }
    })
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'pr-review-guard', version: '1' }, capabilities: { experimentalApi: true } } })}\n`)
  })
}

/** codex-acp 1.11 does not display hook/completed. Forward our denial as a native notice. */
function showGuardDenial(line) {
  const output = [line]
  try {
    const message = JSON.parse(line)
    const hook = message.params?.run
    if (message.method !== 'hook/completed' || hook?.eventName !== 'preToolUse' || hook.source !== 'sessionFlags' || hook.status !== 'blocked') return output
    const reason = hook.entries?.map(entry => entry.text).join('\n').match(/Blocked by dcg \([a-z0-9_.:-]+\): [^\r\n]+|Chat command guard[^\r\n]*/)?.[0]
    if (reason) output.push(JSON.stringify({ method: 'warning', params: { threadId: message.params.threadId, message: reason.slice(0, 350) } }))
  } catch { /* Preserve protocol errors for the adapter to report. */ }
  return output
}

try {
  checkGuard()
  const binary = process.env.PR_REVIEW_CODEX_BIN ?? executable('codex')
  const checking = process.argv[2] === '--check'
  const policy = process.argv[2] === '--policy'
  const args = checking || policy ? ['app-server'] : process.argv.slice(2)
  if (args[0] !== 'app-server') throw new Error('The guarded Codex entry point only supports app-server.')
  args.push('-c', 'features.hooks=true', '-c', `hooks.PreToolUse=${toml(preToolUse)}`)
  const first = await listHooks(binary, args)
  const entry = first.data?.find(entry => entry.cwd === process.cwd())
  const hook = entry?.hooks.find(hook => hook.source === 'sessionFlags' && hook.eventName === 'preToolUse' && hook.command === preToolUse[0].hooks[0].command && hook.matcher === '^Bash$' && hook.async === false)
  if (!hook || entry.errors?.length || typeof hook.currentHash !== 'string' || typeof hook.key !== 'string') {
    throw new Error('Codex does not expose the required chat hook. Install a Codex version supporting PreToolUse and hooks/list (tested with 0.154.0).')
  }
  if (policy) {
    // The host installs this into the fresh isolated HOME and makes it read-only.
    process.stdout.write(`[features]\nhooks = true\n[hooks.state.${JSON.stringify(hook.key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hook.currentHash)}\n`)
  } else {
    if (!hook.enabled || hook.trustStatus !== 'trusted') throw new Error('Codex did not activate its exact dcg hook. Stop the server, remove this checkout’s chat runtime, and retry.')
    if (checking) process.stdout.write('Codex dcg hook enabled and trusted\n')
    else run(binary, args, process.env, showGuardDenial)
  }
} catch (error) {
  process.stderr.write(`Chat command guard: ${error.message}\n`)
  process.exitCode = 1
}
