import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkGuard, evaluate, hookResult } from '../acpx/dcg-guard.mjs'

const fixture = mkdtempSync(path.join(os.tmpdir(), 'dcg-guard-fixture-'))
try {
  checkGuard()
  const request = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
  const denied = hookResult(request('aws s3 rb s3://pr-review-disposable-probe --force'))
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /cloud.aws:s3-rb/)
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /not executed/)
  assert.deepEqual(hookResult(request('git status --short')), {})
  assert.equal(hookResult(request(null)).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(hookResult({}).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(evaluate('git status', path.join(fixture, 'missing')).allowed, false)
  for (const [name, body] of [
    ['invalid', 'process.stdout.write("invalid JSON")'],
    ['exit', 'process.exit(5)'],
    ['timeout', 'setInterval(() => {}, 1000)'],
    ['wrong-schema', 'console.log(JSON.stringify({decision:"allow"}))'],
  ]) {
    const binary = path.join(fixture, name)
    writeFileSync(binary, `#!${process.execPath}\n${body}\n`, { mode: 0o700 })
    const result = evaluate('git status', binary)
    assert.equal(result.allowed, false, name)
    assert.match(result.reason, /could not verify/, name)
  }
  process.env.DCG_CONFIG = path.join(fixture, 'allow-everything.toml')
  process.env.DCG_PACKS_DISABLE = 'core,cloud,kubernetes,infrastructure,database'
  writeFileSync(process.env.DCG_CONFIG, '[packs]\nenabled=[]\n')
  assert.equal(evaluate('aws s3 rb s3://pr-review-disposable-probe --force').allowed, false)
  process.stdout.write('dcg policy, explanations, invalid input, missing evaluator, invalid output, timeout, and override isolation passed\n')
} finally { rmSync(fixture, { recursive: true, force: true }) }
