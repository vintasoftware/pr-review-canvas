// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentPath, createSandbox, hostCommand } from './sandbox.js'

it('denies dangerous remote commands and evaluator failures with a reason', () => {
  const command = hostCommand('node', [agentPath(fileURLToPath(new URL('../testing/dcg-guard-probe.mjs', import.meta.url)))])
  expect(execFileSync(command.file, command.args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })).toContain('override isolation passed')
}, 45_000)

it.each(['codex', 'claude'])('%s blocks a real native tool call before the harmless fixture executable runs', agent => {
  const command = hostCommand('node', [agentPath(fileURLToPath(new URL('../testing/native-guard-probe.mjs', import.meta.url))), agent])
  expect(execFileSync(command.file, command.args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] })).toContain('explained the denial to the model')
}, 120_000)

it('activates both native guards inside filesystem containment', async () => {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chat hooks-')))
  try {
    const sandbox = createSandbox({ stateRoot: path.join(fixture, 'runtime'), home: fixture })
    for (const agent of ['codex', 'claude']) {
      const script = agentPath(fileURLToPath(new URL(`./${agent}-chat.mjs`, import.meta.url)))
      const command = sandbox('node', [script, '--check'], fixture)
      const output = execFileSync(command.file, command.args, { cwd: fixture, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      expect(output).toContain(agent === 'codex' ? 'hook enabled and trusted' : 'launch hooks verified')
    }
  } finally { await rm(fixture, { recursive: true, force: true }) }
}, 150_000)
