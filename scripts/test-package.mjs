import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envWithoutRepo } from '../src/git/environment.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = await mkdtemp(path.join(os.tmpdir(), 'pr-review-package-'))
const env = envWithoutRepo()

const run = (command, args, cwd = temp) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`)
  return result.stdout
}
let server
let stopped
try {
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], root))
  const files = pack.files.map(file => file.path)
  for (const required of [
    'bin/pr-review.mjs',
    'src/cli.ts',
    'static/styles.css',
    'prompts/chat-seed.md',
    'skills/pr-review-canvas/SKILL.md',
    'docs/reference.md',
    'LICENSE',
  ]) {
    assert(files.includes(required), `Missing package file: ${required}`)
  }
  assert(
    !files.some(file =>
      /(?:\.test\.|__tests__|__fixtures__|^src\/testing\/|^\.github\/|^\.pr-review\/)/.test(file)
    ),
    'Package contains development or local data files'
  )
  run('npm', [
    'install',
    '--prefix',
    temp,
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    path.join(temp, pack.filename),
  ])
  const cli = path.join(temp, 'node_modules', '.bin', 'pr-review')
  const help = spawnSync(cli, ['--help'], { cwd: temp, env, encoding: 'utf8', timeout: 15_000 })
  assert.equal(help.status, 0)
  assert.match(help.stderr, /install-skill/)
  const invalid = spawnSync(cli, ['unknown-command'], { cwd: temp, env, encoding: 'utf8', timeout: 15_000 })
  assert.equal(invalid.status, 2, invalid.stderr)
  run('git', ['init', '--quiet'])
  run('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  run(cli, ['install-skill'])
  for (const directory of ['.claude', '.agents']) {
    assert(!(await lstat(path.join(temp, directory, 'skills/pr-review-canvas'))).isSymbolicLink())
    assert.match(
      await readFile(path.join(temp, directory, 'skills/pr-review-canvas/SKILL.md'), 'utf8'),
      /pr-review/
    )
  }
  await appendFile(path.join(temp, '.agents/skills/pr-review-canvas/SKILL.md'), '\nlocal edit\n')
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve, reject) => probe.close(error => (error ? reject(error) : resolve())))
  server = spawn(cli, ['serve', '--port', String(port), '--no-open'], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  stopped = once(server, 'exit')
  let logs = ''
  server.stdout.on('data', chunk => {
    logs += chunk
  })
  server.stderr.on('data', chunk => {
    logs += chunk
  })
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Server startup timed out: ${logs}`)), 15_000)
    const poll = setInterval(() => {
      const match = logs.match(/http:\/\/localhost:\d+/)
      if (match) finish(null, match[0])
    }, 50)
    const onError = error => finish(error)
    const onExit = code => finish(new Error(`Server exited (${code}): ${logs}`))
    function finish(error, value) {
      clearTimeout(timeout)
      clearInterval(poll)
      server.off('error', onError)
      server.off('exit', onExit)
      if (error) reject(error)
      else resolve(value)
    }
    server.once('error', onError)
    server.once('exit', onExit)
  })
  assert.match(logs, /pr-review doctor: outdated or modified skill/)
  assert.match(logs, /pr-review install-skill/)
  for (const route of [
    '/',
    '/static/styles.css',
    '/static/js/app.js',
    '/vendor/marked.js',
    '/vendor/purify.js',
    '/vendor/highlight.js',
    '/vendor/mermaid/mermaid.esm.min.mjs',
  ]) {
    const response = await fetch(`${origin}${route}`, { signal: AbortSignal.timeout(5_000) })
    assert.equal(response.status, 200, `${route}: ${await response.text()}`)
  }
  console.log(`Package smoke test passed: ${pack.filename} (${files.length} files)`)
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM')
    const timeout = setTimeout(() => server.kill('SIGKILL'), 5_000)
    try {
      await stopped
    } finally {
      clearTimeout(timeout)
    }
  }
  await rm(temp, { recursive: true, force: true })
}
