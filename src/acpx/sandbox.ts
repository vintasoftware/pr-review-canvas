import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const RUNTIME = `/run/pr-review-runtime-${process.getuid?.() ?? 0}`
export const DCG_INSTALL_HINT =
  'Install Destructive Command Guard from https://github.com/Dicklesworthstone/destructive_command_guard and verify `dcg --version`'
export const SANDBOX_INSTALL_HINT =
  'AI Chat requires working bubblewrap on Linux/Ubuntu WSL2, or /usr/bin/sandbox-exec on macOS; see README AI Chat setup'

export class SandboxError extends Error {}
export class DcgPolicyError extends SandboxError {}
export const DCG_POLICY_HINT =
  'Chat enables remote-service rules automatically in src/acpx/dcg-policy.toml; no personal dcg configuration is needed. Check `node --version` in the chat environment (Node 22.18+ or 24+). Install or upgrade dcg using https://github.com/Dicklesworthstone/destructive_command_guard#quick-install (tested: 0.6.5). If that version is already installed, restore or reinstall the app’s bundled policy. Then run `pr-review doctor --all-checks`.'

function copyOnce(source: string, target: string): void {
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Quote the canonical runtime path as a Seatbelt string literal. */
export function macosProfile(stateDir: string): string {
  const state = JSON.stringify(stateDir)
  return `(version 1)
(deny default)
(allow file-read* process-exec process-fork sysctl-read user-preference-read)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.securityd.xpc"))
(allow network-outbound (remote ip "*:*"))
(allow system-socket (socket-domain AF_INET) (socket-domain AF_INET6) (socket-domain AF_UNIX))
(allow network-bind (local unix-socket (subpath ${state})))
(allow network-outbound (remote unix-socket (subpath ${state})))
(allow file-write* (subpath ${state}) (literal "/dev/null") (literal "/dev/zero"))
(deny file-write-unlink (literal ${state}) (literal ${JSON.stringify(path.join(stateDir, 'home'))}) (literal ${JSON.stringify(path.join(stateDir, 'home/.codex'))}))
(deny file-write* (literal ${JSON.stringify(path.join(stateDir, 'home/.codex/config.toml'))}) (literal ${JSON.stringify(path.join(stateDir, 'home/.codex/hooks.json'))}))`
}

function runtimeEnv(root: string): string[] {
  return [
    '-u', 'SSH_AUTH_SOCK', '-u', 'DBUS_SESSION_BUS_ADDRESS',
    `HOME=${root}/home`, `CODEX_HOME=${root}/home/.codex`, `CLAUDE_CONFIG_DIR=${root}/home/.claude`,
    `XDG_CONFIG_HOME=${root}/home/.config`, `XDG_CACHE_HOME=${root}/cache`,
    `XDG_STATE_HOME=${root}/state`, `XDG_DATA_HOME=${root}/data`, `XDG_RUNTIME_DIR=${root}/run`,
    `TMPDIR=${root}/tmp`, `npm_config_cache=${root}/cache/npm`,
  ]
}

function wslArgs(): string[] {
  const distro = process.env['PR_REVIEW_WSL_DISTRO']
  return [...(distro ? ['--distribution', distro] : []), '--exec']
}

/** Auth and version probes must inspect the same installation that runs chat. */
export function hostCommand(file: string, args: string[]): { file: string; args: string[] } {
  return process.platform === 'win32' ? { file: 'wsl.exe', args: [...wslArgs(), file, ...args] } : { file, args }
}

export function agentPath(file: string): string {
  if (process.platform !== 'win32') return file
  try {
    return execFileSync('wsl.exe', [...wslArgs(), 'wslpath', '-a', '-u', file], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    throw new SandboxError('Cannot translate the review path into WSL. Install Ubuntu WSL2 and check PR_REVIEW_WSL_DISTRO.')
  }
}

function windowsSandboxCommand(file: string, args: string[], cwd: string, action = 'launch', options: SandboxOptions = {}): { file: string; args: string[] } {
  const linuxCwd = agentPath(cwd)
  const linuxArgs = args.map((arg, index) => args[index - 1] === '--cwd' ? linuxCwd : arg)
  const sandbox = {
    ...(options.stateRoot ? { stateRoot: agentPath(options.stateRoot) } : {}),
    ...(options.home ? { home: agentPath(options.home) } : {}),
  }
  const request = Buffer.from(JSON.stringify({ action, file: path.isAbsolute(file) ? agentPath(file) : file, args: linuxArgs, cwd: linuxCwd, sandbox })).toString('base64')
  // Node's built-in type stripping lets this dependency-free module run inside WSL without
  // loading Windows node_modules. Arguments and prompt stdin never pass through a shell.
  return { file: 'wsl.exe', args: [...wslArgs(), 'node', agentPath(fileURLToPath(new URL('./wsl-sandbox.mjs', import.meta.url))), '--pr-review-sandbox', request] }
}

export function dcgVersion(): string {
  let version: string
  try {
    const command = hostCommand('dcg', ['--version'])
    version = execFileSync(command.file, command.args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (!version) throw new Error('empty version')
  } catch {
    throw new SandboxError(DCG_INSTALL_HINT)
  }
  try {
    const probe = hostCommand('node', [agentPath(fileURLToPath(new URL('./dcg-guard.mjs', import.meta.url))), '--check'])
    execFileSync(probe.file, probe.args, { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return `${version}; required chat policy verified`
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim().slice(0, 2000)
    throw new DcgPolicyError(`${version} is installed, but the required chat policy failed. ${stderr || 'Could not evaluate the bundled remote-service rules.'}`)
  }
}

/** Host paths stay read-only, including worktree git directories and external snapshots. */
export function sandboxArgs(stateDir: string, cwd: string): string[] {
  if (process.platform !== 'linux') throw new SandboxError(SANDBOX_INSTALL_HINT)
  const args = [
    '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/run', '--bind', stateDir, RUNTIME,
    '--setenv', 'HOME', `${RUNTIME}/home`,
    '--setenv', 'CODEX_HOME', `${RUNTIME}/home/.codex`,
    '--setenv', 'CLAUDE_CONFIG_DIR', `${RUNTIME}/home/.claude`,
    '--setenv', 'XDG_CONFIG_HOME', `${RUNTIME}/home/.config`,
    '--setenv', 'XDG_CACHE_HOME', `${RUNTIME}/cache`,
    '--setenv', 'XDG_STATE_HOME', `${RUNTIME}/state`,
    '--setenv', 'XDG_DATA_HOME', `${RUNTIME}/data`,
    '--setenv', 'XDG_RUNTIME_DIR', `${RUNTIME}/run`,
    '--setenv', 'TMPDIR', `${RUNTIME}/tmp`,
    '--setenv', 'npm_config_cache', `${RUNTIME}/cache/npm`,
    '--unsetenv', 'SSH_AUTH_SOCK', '--unsetenv', 'DBUS_SESSION_BUS_ADDRESS',
    '--unsetenv', 'WSL_INTEROP',
    '--chdir', cwd,
  ]
  // WSL's interop interpreter can launch an unsandboxed Windows process. Mask it as well
  // as /run (which contains the interop sockets), even if a caller restores WSL_INTEROP.
  if (existsSync('/init')) args.push('--ro-bind', '/dev/null', '/init')
  return args
}

/** Reject links in runtime paths before the host creates or writes anything through them. */
function privateDirectory(dir: string): void {
  if (dir === path.dirname(dir)) return
  privateDirectory(path.dirname(dir))
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
    throw new SandboxError(`Chat runtime directory must not be a symlink: ${dir}`)
  }
}

export interface SandboxOptions {
  stateRoot?: string
  home?: string
}

/** acpx 0.13.2 puts its IPC socket under /tmp regardless of TMPDIR. Redirect just that
 * directory into scratch; never make all of /tmp writable. */
function queueDirectory(runtimeRoot: string): void {
  const key = createHash('sha256').update(`${runtimeRoot}/home`).digest('hex').slice(0, 10)
  const alias = `/tmp/acpx-${key}`
  const target = `${runtimeRoot}/ipc`
  try {
    symlinkSync(target, alias)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!lstatSync(alias).isSymbolicLink() || readlinkSync(alias) !== target) {
      throw new SandboxError(`Chat IPC path is already occupied: ${alias}`)
    }
  }
}

/** Obtain the installed Codex version's exact hook hash without starting a model session. */
function codexPolicy(): string {
  const temporaryHome = mkdtempSync(path.join(os.tmpdir(), 'pr-review-codex-policy-'))
  try {
    return execFileSync(process.execPath, [fileURLToPath(new URL('./codex-chat.mjs', import.meta.url)), '--policy'], {
      cwd: temporaryHome, env: { ...process.env, CODEX_HOME: temporaryHome },
      encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    // Claude remains usable without Codex. The Codex launcher/doctor rejects missing trust.
    return '# Codex hook trust unavailable. Install a supported Codex and reset the chat runtime.\n'
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true })
  }
}

/** One persistent runtime per checkout, separate from the user's normal agent sessions. */
export function createSandbox(options: SandboxOptions = {}): (file: string, args: string[], cwd: string) => { file: string; args: string[] } {
  const home = options.home ?? os.homedir()
  const root = options.stateRoot ?? path.join(home, '.local', 'state', 'pr-review-canvas', 'chat')
  const codexHome = options.home ? path.join(home, '.codex') : process.env['CODEX_HOME'] ?? path.join(home, '.codex')
  const claudeHome = options.home ? path.join(home, '.claude') : process.env['CLAUDE_CONFIG_DIR'] ?? path.join(home, '.claude')
  const configHome = options.home ? path.join(home, '.config') : process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config')
  const prepared = new Map<string, { file: string; args: string[] }>()
  return (file, args, cwd) => {
    if (process.platform === 'win32') return windowsSandboxCommand(file, args, cwd, 'launch', options)
    dcgVersion()
    const repo = realpathSync(cwd)
    let prefix = prepared.get(repo)
    if (!prefix) {
      checkSandbox()
      const key = createHash('sha256').update(`dcg-v1:${repo}`).digest('hex')
      const stateDir = path.join(root, key)
      privateDirectory(root)
      let fresh = false
      try {
        mkdirSync(stateDir, { mode: 0o700 })
        fresh = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (!lstatSync(stateDir).isDirectory() || lstatSync(stateDir).isSymbolicLink()) {
        throw new SandboxError(`Chat runtime directory must not be a symlink: ${stateDir}`)
      }
      if (!fresh && !existsSync(path.join(stateDir, '.initialized'))) {
        throw new SandboxError(`Chat runtime initialization is incomplete: ${stateDir}. Stop the server and remove this directory before retrying.`)
      }
      // Only initialize new storage. Once an agent has run, its files and links are untrusted:
      // the host must never write through them, including on a later server restart.
      if (fresh) {
        for (const dir of ['home', 'home/.acpx', 'home/.codex', 'home/.claude', 'home/.config/dcg', 'cache', 'state', 'data', 'run', 'tmp', 'ipc']) {
          privateDirectory(path.join(stateDir, dir))
        }
      }
      const protectedConfigs = new Map([
        ['home/.codex/config.toml', codexPolicy()],
        ['home/.codex/hooks.json', '{"hooks":{}}\n'],
      ])
      for (const [name, content] of protectedConfigs) {
        const target = path.join(stateDir, name)
        if (fresh) writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
        // Existing runtime paths are untrusted; never follow links or repair them from the host.
        const parts = ['home', 'home/.codex', name].map(part => path.join(stateDir, part))
        if (parts.some(part => !existsSync(part) || lstatSync(part).isSymbolicLink()) || readFileSync(target, 'utf8') !== content) {
          throw new SandboxError('Chat guard configuration changed. Stop the server, remove this checkout’s chat runtime, and retry.')
        }
      }
      const canonicalState = realpathSync(stateDir)
      queueDirectory(process.platform === 'darwin' ? canonicalState : RUNTIME)
      prefix = process.platform === 'darwin'
        ? { file: '/usr/bin/sandbox-exec', args: ['-p', macosProfile(canonicalState), '/usr/bin/env', ...runtimeEnv(canonicalState)] }
        : { file: 'bwrap', args: sandboxArgs(canonicalState, repo) }
      if (process.platform === 'linux') {
        // Make the ancestors mount points too, so a writable parent cannot rename the guard away.
        for (const name of ['home', 'home/.codex']) prefix.args.push('--bind', path.join(canonicalState, name), `${RUNTIME}/${name}`)
        for (const name of protectedConfigs.keys()) prefix.args.push('--ro-bind', path.join(canonicalState, name), `${RUNTIME}/${name}`)
      }
      // Codex uses app-owned hook trust. Login state and sessions stay in the isolated HOME.
      const configs = [
        [path.join(home, '.acpx/config.json'), 'home/.acpx/config.json'],
        [path.join(claudeHome, 'settings.json'), 'home/.claude/settings.json'],
        [path.join(configHome, 'dcg/config.toml'), 'home/.config/dcg/config.toml'],
      ]
      for (const [source, target] of configs) {
        if (source && target && existsSync(source) && statSync(source).isFile()) {
          if (process.platform === 'darwin' && fresh) {
            copyOnce(source, path.join(stateDir, target))
          } else if (process.platform === 'linux') {
            prefix.args.push('--ro-bind', realpathSync(source), `${RUNTIME}/${target}`)
          }
        }
      }
      // Login state may refresh inside the sandbox. Never overwrite an existing runtime file
      // or follow a link planted by an earlier agent turn.
      const loginFiles = [
        [path.join(home, '.claude.json'), 'home/.claude.json'],
        [path.join(claudeHome, '.credentials.json'), 'home/.claude/.credentials.json'],
        [path.join(codexHome, 'auth.json'), 'home/.codex/auth.json'],
      ]
      for (const [source, target] of loginFiles) {
        if (fresh && source && target && existsSync(source) && statSync(source).isFile()) {
          copyOnce(source, path.join(stateDir, target))
        }
      }
      if (fresh) writeFileSync(path.join(stateDir, '.initialized'), '', { flag: 'wx', mode: 0o600 })
      prepared.set(repo, prefix)
    }
    return { file: prefix.file, args: [...prefix.args, ...(process.platform === 'darwin' ? [] : ['--']), file, ...args] }
  }
}

/** Exercise namespaces and mounts, rather than accepting an installed but unusable binary. */
export function checkSandbox(): void {
  try {
    if (process.platform === 'win32') {
      const command = windowsSandboxCommand('', [], process.cwd(), 'check')
      execFileSync(command.file, command.args, { timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
      return
    }
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/sandbox-exec', ['-p', macosProfile('/nonexistent-pr-review-probe'), '/usr/bin/true'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
      return
    }
    if (process.platform !== 'linux') throw new SandboxError(SANDBOX_INSTALL_HINT)
    execFileSync('bwrap', [
      '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/run', '--', '/bin/true',
    ], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    throw new SandboxError(SANDBOX_INSTALL_HINT)
  }
}

/** Check hooks for installed agents using the same contained homes and launchers as chat. */
export function checkChatGuards(cwd: string): string {
  if (process.platform === 'win32') {
    const command = windowsSandboxCommand('', [], cwd, 'checkGuards')
    return execFileSync(command.file, command.args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  }
  const sandbox = createSandbox()
  const results: string[] = []
  for (const agent of ['codex', 'claude']) {
    try {
      execFileSync(agent, ['--version'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      continue
    }
    const command = sandbox(process.execPath, [fileURLToPath(new URL(`./${agent}-chat.mjs`, import.meta.url)), '--check'], cwd)
    try {
      results.push(execFileSync(command.file, command.args, { cwd, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim())
    } catch {
      throw new SandboxError(`${agent} could not activate the required dcg chat hook. Check the supported versions and reset this checkout’s chat runtime after upgrading; see README.`)
    }
  }
  if (!results.length) throw new SandboxError('Install Claude Code or Codex in the chat environment before checking chat hooks.')
  return results.join('; ')
}

// The Windows host launches this module with Linux Node (22.18+ or 24+) inside WSL2.
if (process.argv[2] === '--pr-review-sandbox') {
  try {
    const request = JSON.parse(Buffer.from(process.argv[3] ?? '', 'base64').toString('utf8')) as {
      action: string; file: string; args: string[]; cwd: string; sandbox?: SandboxOptions
    }
    if (request.action === 'check') {
      checkSandbox()
      dcgVersion()
    } else if (request.action === 'checkGuards') {
      process.stdout.write(`${checkChatGuards(request.cwd)}\n`)
    } else {
      const command = createSandbox(request.sandbox)(request.file, request.args, request.cwd)
      execFileSync(command.file, command.args, { cwd: request.cwd, stdio: 'inherit' })
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
