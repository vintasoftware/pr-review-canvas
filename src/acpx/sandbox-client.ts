import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { appendSandboxCommand, hostCommand, SandboxError, type SandboxCommand, type SandboxOptions } from './sandbox.js'

const execute = promisify(execFile)

/** Translate on the WSL side without blocking the Windows server's event loop. */
export async function agentPathAsync(file: string): Promise<string> {
  if (process.platform !== 'win32') return file
  try {
    const command = hostCommand('wslpath', ['-a', '-u', file])
    return (await execute(command.file, command.args, { timeout: 10_000, encoding: 'utf8' })).stdout.trim()
  } catch {
    throw new SandboxError('Cannot translate the review path into WSL. Install Ubuntu WSL2 and check PR_REVIEW_WSL_DISTRO.')
  }
}

/** One shared preparation promise per checkout and runner. Native hooks still attest each launch. */
export function createSandboxClient(options: SandboxOptions = {}) {
  const paths = new Map<string, Promise<string>>()
  const translate = (file: string): Promise<string> => {
    let pending = paths.get(file)
    if (!pending) {
      pending = agentPathAsync(file)
      paths.set(file, pending)
      void pending.catch(() => paths.delete(file))
    }
    return pending
  }
  const prepared = new Map<string, Promise<SandboxCommand>>()
  const prepare = async (cwd: string): Promise<SandboxCommand> => {
    const [directory, bridge, stateRoot, home] = await Promise.all([
      translate(cwd), translate(fileURLToPath(new URL('./wsl-sandbox.mjs', import.meta.url))),
      options.stateRoot ? translate(options.stateRoot) : undefined,
      options.home ? translate(options.home) : undefined,
    ])
    const request = Buffer.from(JSON.stringify({ action: 'prepare', cwd: directory, sandbox: { stateRoot, home } })).toString('base64')
    const command = hostCommand(process.platform === 'win32' ? 'node' : process.execPath, [bridge, '--pr-review-sandbox', request])
    try {
      const { stdout } = await execute(command.file, command.args, { cwd, timeout: 60_000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
      const prefix: SandboxCommand = JSON.parse(stdout)
      if (typeof prefix.file !== 'string' || !Array.isArray(prefix.args) || !prefix.args.every(arg => typeof arg === 'string')) {
        throw new Error('Invalid sandbox preparation response')
      }
      return prefix
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim()
      throw new SandboxError(detail || (error instanceof Error ? error.message : String(error)))
    }
  }
  return async (file: string, args: string[], cwd: string): Promise<SandboxCommand> => {
    let pending = prepared.get(cwd)
    if (!pending) {
      pending = prepare(cwd)
      prepared.set(cwd, pending)
      void pending.catch(() => prepared.delete(cwd))
    }
    const [prefix, executable, directory] = await Promise.all([
      pending, path.isAbsolute(file) ? translate(file) : file, translate(cwd),
    ])
    const command = appendSandboxCommand(prefix, executable, args.map((arg, index) => args[index - 1] === '--cwd' ? directory : arg))
    return hostCommand(command.file, command.args)
  }
}
