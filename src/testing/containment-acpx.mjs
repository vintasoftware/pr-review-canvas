#!/usr/bin/env node
// Deliberately ignores ACP permission requests. Only the OS sandbox can stop these writes.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, linkSync, existsSync, renameSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const cwd = args[args.indexOf('--cwd') + 1]
const fixture = JSON.parse(readFileSync(path.join(cwd, 'containment.json'), 'utf8'))
const results = {}
function attempt(name, action) {
  try {
    action()
    results[name] = 'allowed'
  } catch (error) {
    results[name] = error.code ?? 'blocked'
  }
}
attempt('overwrite', () => writeFileSync(path.join(cwd, 'tracked.txt'), 'destroyed'))
attempt('deletion', () => unlinkSync(path.join(cwd, 'tracked.txt')))
attempt('gitReset', () => execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd, stdio: 'pipe' }))
attempt('snapshotOverwrite', () => writeFileSync(fixture.snapshot, 'destroyed'))
attempt('snapshotDeletion', () => unlinkSync(fixture.snapshot))
attempt('outsideOverwrite', () => writeFileSync(fixture.outside, 'destroyed'))
attempt('outsideCreation', () => mkdirSync(path.join(path.dirname(fixture.outside), 'new-directory')))
attempt('symlinkOverwrite', () => writeFileSync(path.join(cwd, 'outside-link'), 'destroyed'))
attempt('guardOverwrite', () => writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'hooks = {}'))
attempt('guardDeletion', () => unlinkSync(path.join(process.env.CODEX_HOME, 'config.toml')))
attempt('guardDirectoryRename', () => renameSync(process.env.CODEX_HOME, `${process.env.CODEX_HOME}-old`))
attempt('hardlinkOverwrite', () => {
  const link = path.join(process.env.TMPDIR, 'hardlink')
  if (!existsSync(link)) linkSync(fixture.outside, link)
  writeFileSync(link, 'destroyed')
})
if (process.env.WSL_DISTRO_NAME) {
  attempt('windowsInterop', () =>
    execFileSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'exit', '0'], { stdio: 'pipe' })
  )
}
attempt('scratch', () => writeFileSync(path.join(process.env.TMPDIR, 'scratch.txt'), 'scratch works'))
const queueHash = createHash('sha256').update(process.env.HOME).digest('hex').slice(0, 10)
const queue = createServer()
await new Promise((resolve, reject) => {
  queue.once('error', reject)
  queue.listen(`/tmp/acpx-${queueHash}/fixture.sock`, resolve)
})
await new Promise(resolve => queue.close(resolve))
results.queueSocket = 'allowed'
const stage = args.includes('ensure')
  ? 'ensure'
  : args.includes('cancel')
    ? 'cancel'
    : args.includes('exec')
      ? 'exec'
      : 'prompt'
writeFileSync(path.join(process.env.HOME, `${stage}.json`), JSON.stringify(results))
console.log(
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'containment',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(results) },
      },
    },
  })
)
console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }))
