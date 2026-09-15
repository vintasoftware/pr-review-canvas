import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

export function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue
    const candidate = path.join(directory, name)
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate) } catch { /* Try next directory. */ }
  }
  throw new Error(`AI Chat requires ${name} on PATH inside its containment environment.`)
}

export function quote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
export const guardFile = fileURLToPath(new URL('./dcg-guard.mjs', import.meta.url))
export const guardCommand = `${quote(process.execPath)} ${quote(guardFile)}`
export const preToolUse = [{ matcher: '^Bash$', hooks: [{ type: 'command', command: guardCommand, timeout: 15 }] }]

/** Preserve stdio and cancellation through the CLI wrappers. */
export function run(file, args, env = process.env, transformLine) {
  const child = spawn(file, args, { env, stdio: transformLine ? ['inherit', 'pipe', 'inherit'] : 'inherit' })
  if (transformLine) {
    createInterface({ input: child.stdout }).on('line', line => {
      for (const output of transformLine(line)) process.stdout.write(`${output}\n`)
    })
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('error', error => { process.stderr.write(`Chat command guard: ${error.message}\n`); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
  return child
}
