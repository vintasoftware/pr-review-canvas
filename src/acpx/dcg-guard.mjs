import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const policyDir = fileURLToPath(new URL('.', import.meta.url))

/** Evaluate command text only. Never execute the proposed command. */
export function evaluate(command, binary = process.env.PR_REVIEW_DCG_BIN ?? 'dcg') {
  if (typeof command !== 'string' || !command.trim() || command.length > 128_000) {
    return { allowed: false, reason: 'Chat command guard: missing, empty, or oversized command. Nothing was executed.' }
  }
  const result = spawnSync(binary, ['test', '--robot', '--config', path.join(policyDir, 'dcg-policy.toml'), '--', command], {
    cwd: policyDir,
    // dcg must not inherit bypass flags, agent profiles, or discover writable allowlists.
    env: { PATH: process.env.PATH, HOME: policyDir, XDG_CONFIG_HOME: policyDir, DCG_FAIL_CLOSED: '1' },
    encoding: 'utf8', timeout: 5000, maxBuffer: 1_048_576,
  })
  try {
    if (result.error || result.signal) throw new Error('evaluation failed')
    const verdict = JSON.parse(result.stdout)
    if (verdict.schema_version !== 1 || verdict.command !== command) throw new Error('unexpected dcg schema')
    if (result.status === 0 && verdict.decision === 'allow') return { allowed: true }
    if (result.status === 1 && verdict.decision === 'deny' && typeof verdict.reason === 'string') {
      return { allowed: false, reason: `Blocked by dcg (${verdict.rule_id ?? 'chat policy'}): ${verdict.reason}\n${verdict.explanation ?? ''}\nThis command was not executed. Do not bypass the guard.` }
    }
  } catch { /* Any unexpected evaluator result blocks the command. */ }
  return { allowed: false, reason: 'Chat command guard could not verify this command (dcg unavailable, timed out, or returned an invalid result). Nothing was executed. Repair dcg and run pr-review doctor before retrying.' }
}

export function hookResult(input) {
  if (input?.hook_event_name !== 'PreToolUse' || input?.tool_name !== 'Bash') {
    return deny('Chat command guard received an unsupported hook event. Nothing was executed.')
  }
  const verdict = evaluate(input.tool_input?.command)
  return verdict.allowed ? {} : deny(verdict.reason)
}

function deny(reason) {
  // Keep the common Claude/Codex contract minimal: Codex rejects additional fields.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

export function checkGuard() {
  for (const command of [
    'git reset --hard', 'rm -rf /important',
    'aws s3 rb s3://pr-review-disposable-probe --force',
    'gcloud projects delete pr-review-disposable-probe',
    'az group delete --name pr-review-disposable-probe --yes',
    'kubectl delete namespace pr-review-disposable-probe',
    'terraform destroy -auto-approve',
    'psql -c "DROP DATABASE pr_review_disposable_probe"',
  ]) {
    const verdict = evaluate(command)
    if (verdict.allowed || !verdict.reason.startsWith('Blocked by dcg (')) {
      throw new Error(`Required dcg chat policy failed its non-executing probe for: ${command}. ${verdict.reason ?? ''}`)
    }
  }
  if (!evaluate('git status --short').allowed) throw new Error('Required dcg chat policy rejected its read-only probe.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === '--ready') {
    checkGuard()
    writeFileSync(process.argv[3], process.argv[4], { flag: 'wx', mode: 0o600 })
  } else if (process.argv[2] === '--check') {
    try { checkGuard(); process.stdout.write('dcg chat policy verified\n') }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  } else {
    let output
    try { output = hookResult(JSON.parse(readFileSync(0, 'utf8'))) }
    catch { output = deny('Chat command guard could not read the hook input. Nothing was executed.') }
    process.stdout.write(`${JSON.stringify(output)}\n`)
  }
}
