// @vitest-environment node
import { execFile } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { makeTempDir } from '../testing/fakes.js'
import { envWithoutRepo, REPO_ENV_VARS } from './environment.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))

describe('development process environments', () => {
  let temp: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    temp = await makeTempDir('pr-review-env-')
    const bin = path.join(temp, 'bin')
    await mkdir(bin)
    // Stand in for pnpm so the real hook can run without recursively starting the test suite.
    await writeFile(path.join(bin, 'pnpm'), '#!/bin/sh\nexec "$NODE" "$PROBE" "$@"\n')
    await chmod(path.join(bin, 'pnpm'), 0o755)
    await writeFile(
      path.join(temp, 'probe.cjs'),
      `console.log(JSON.stringify({
        args: process.argv.slice(2),
        repo: Object.fromEntries(${JSON.stringify(REPO_ENV_VARS)}
          .filter(name => name in process.env).map(name => [name, process.env[name]])),
        kept: process.env['GIT_CONFIG_GLOBAL'],
        ssh: process.env['SSH_AUTH_SOCK']
      }))
      process.exitCode = Number(process.env.PROBE_EXIT || 0)`
    )
    env = {
      ...envWithoutRepo(),
      ...Object.fromEntries(REPO_ENV_VARS.map(name => [name, path.join(temp, name)])),
      PATH: `${bin}${path.delimiter}${process.env['PATH']}`,
      NODE: process.execPath,
      PROBE: path.join(temp, 'probe.cjs'),
      GIT_CONFIG_GLOBAL: path.join(temp, 'gitconfig'),
      SSH_AUTH_SOCK: path.join(temp, 'ssh-agent'),
    }
  })
  afterEach(() => rm(temp, { recursive: true, force: true }))

  it.each(['hook', 'test setup'])('removes repository pointers before %s starts children', async boundary => {
    const result =
      boundary === 'hook'
        ? await run('sh', [path.join(root, '.githooks/pre-commit')], { cwd: temp, env })
        : await run(
            process.execPath,
            [
              '--import',
              'tsx',
              '--input-type=module',
              '-e',
              `import './vitest.setup.ts'
               import { execFileSync } from 'node:child_process'
               process.stdout.write(execFileSync(process.execPath, [process.env.PROBE]))`,
            ],
            { cwd: root, env }
          )
    expect(JSON.parse(result.stdout)).toEqual({
      args: boundary === 'hook' ? ['precommit'] : [],
      repo: {},
      kept: env['GIT_CONFIG_GLOBAL'],
      ssh: env['SSH_AUTH_SOCK'],
    })
  })

  it('propagates a failed precommit command', async () => {
    await expect(
      run('sh', [path.join(root, '.githooks/pre-commit')], {
        cwd: temp,
        env: { ...env, PROBE_EXIT: '42' },
      })
    ).rejects.toMatchObject({ code: 42 })
  })
})
