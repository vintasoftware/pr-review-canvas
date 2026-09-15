#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkGuard } from './dcg-guard.mjs'
import { executable, guardCommand, preToolUse, quote, run } from './guard-process.mjs'

try {
  checkGuard()
  const binary = process.env.PR_REVIEW_CLAUDE_BIN ?? executable('claude')
  const settings = { disableAllHooks: false, hooks: { PreToolUse: preToolUse } }
  const probeDir = mkdtempSync(path.join(os.tmpdir(), 'pr-review-hook-'))
  try {
    const marker = path.join(probeDir, 'ready')
    const nonce = randomUUID()
    const probeSettings = { ...settings, hooks: { ...settings.hooks, SessionStart: [{ hooks: [{ type: 'command', command: `${guardCommand} --ready ${quote(marker)} ${quote(nonce)}`, timeout: 15 }] }] } }
    execFileSync(binary, ['--init-only', '--setting-sources', '', '--settings', JSON.stringify(probeSettings)], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (readFileSync(marker, 'utf8') !== nonce) throw new Error('Claude did not activate its required chat hook.')
  } finally { rmSync(probeDir, { recursive: true, force: true }) }
  if (process.argv[2] === '--check') process.stdout.write('Claude dcg launch hooks verified\n')
  else {
    const args = []
    const input = process.argv.slice(2)
    // The SDK supplies these options too. Use only app-controlled launch settings in chat.
    for (let index = 0; index < input.length; index++) {
      if (input[index] === '--settings' || input[index] === '--setting-sources') { index++; continue }
      if (input[index].startsWith('--settings=') || input[index].startsWith('--setting-sources=')) continue
      args.push(input[index])
    }
    run(binary, [...args, '--setting-sources', '', '--settings', JSON.stringify(settings)])
  }
} catch (error) {
  process.stderr.write(`Chat command guard: ${error.message}\n`)
  process.exitCode = 1
}
