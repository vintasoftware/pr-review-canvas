// acpx's configurable agent registry cannot replace chat's guarded entry points.
import { fileURLToPath } from 'node:url'
import { checkGuard } from './dcg-guard.mjs'
import { executable, quote, run } from './guard-process.mjs'

try {
  process.env.PR_REVIEW_DCG_BIN = executable('dcg')
  checkGuard()
  const args = process.argv.slice(2)
  let index = args.indexOf('--timeout') + 2
  if (index < 2) throw new Error('Missing chat command options.')
  while (args[index] === '--model' || args[index] === '--max-turns') index += 2
  const agent = args[index]
  if (agent !== 'claude' && agent !== 'codex')
    throw new Error('AI Chat only supports the guarded Claude and Codex adapters.')
  const launcher = fileURLToPath(new URL('./guarded-agent.mjs', import.meta.url))
  args.splice(index, 1, '--agent', `${quote(process.execPath)} ${quote(launcher)} ${agent}`)
  run(executable('acpx'), args)
} catch (error) {
  process.stderr.write(`Chat command guard: ${error.message}\n`)
  process.exitCode = 1
}
