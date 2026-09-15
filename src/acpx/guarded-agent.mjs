import { fileURLToPath } from 'node:url'
import { executable, run } from './guard-process.mjs'

try {
  const agent = process.argv[2]
  if (agent !== 'codex' && agent !== 'claude') throw new Error('Unsupported chat agent.')
  const env = { ...process.env, PR_REVIEW_DCG_BIN: executable('dcg') }
  // Prevent inherited adapter overrides from disabling the app-owned launch policy.
  delete env.CODEX_CONFIG
  if (agent === 'codex') {
    env.PR_REVIEW_CODEX_BIN = executable('codex')
    env.CODEX_PATH = fileURLToPath(new URL('./codex-chat.mjs', import.meta.url))
  } else {
    env.PR_REVIEW_CLAUDE_BIN = executable('claude')
    env.CLAUDE_CODE_EXECUTABLE = fileURLToPath(new URL('./claude-chat.mjs', import.meta.url))
  }
  const adapter = agent === 'codex' ? '@agentclientprotocol/codex-acp@1.11.0' : '@agentclientprotocol/claude-agent-acp@0.60.0'
  run(executable('npx'), ['--yes', adapter], env)
} catch (error) {
  process.stderr.write(`Chat command guard: ${error.message}\n`)
  process.exitCode = 1
}
