// @vitest-environment node
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type CliIo,
  EXIT,
  parsePrepareTarget,
  reportFailure,
  runExport,
  runImport,
  runInstallSkill,
  runPrepare,
  runPublish,
  runValidate,
  splitCommonFlags,
  UsageError,
} from './commands.js'
import { ConfigError } from './config.js'
import { GitError } from './git/git.js'
import { HostCliError } from './host/client.js'
import { PrNotFoundError } from './host/pr.js'
import { SkillDirExistsError } from './review/install-skill.js'
import { artifactToModelOutput } from './review/normalize.js'
import { ModelInvalidError, PublishError } from './review/publish.js'
import { makeTempDir, makeTestContext, type TestContext } from './testing/fakes.js'
import { ghFor42, gitFor42, HEAD_SHA, syntheticArtifact } from './testing/synthetic.js'

interface FakeIo extends CliIo {
  out: string[]
  err: string[]
}

function fakeIo(): FakeIo {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: l => out.push(l), stderr: l => err.push(l) }
}

function lastJson(io: FakeIo): unknown {
  return JSON.parse(io.out[io.out.length - 1] ?? 'null')
}

let t: TestContext
afterEach(() => t?.cleanup())

describe('prepare, publish, validate through the CLI layer', () => {
  it('prints one JSON line per command and drives the whole generation round trip', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const io = fakeIo()
    expect(await runPrepare(t.ctx, ['--pr', '42'], io)).toBe(EXIT.ok)
    expect(io.err).toEqual(['fetch-pr', 'fetch-refs', 'collect-diffs', 'prompt'])
    expect(io.out).toHaveLength(1)
    const prepared = lastJson(io) as { canvasDir: string; status: string }
    expect(prepared.status).toBe('prepared')
    const canvasDir = prepared.canvasDir

    const output = artifactToModelOutput(syntheticArtifact())
    await writeFile(path.join(canvasDir, 'model.json'), JSON.stringify(output))

    const validate = fakeIo()
    expect(
      await runValidate(t.ctx, [path.join(canvasDir, 'model.json'), '--canvas', canvasDir], validate)
    ).toBe(EXIT.ok)
    expect(lastJson(validate)).toEqual({ ok: true, errors: [] })
    const human = fakeIo()
    expect(
      await runValidate(t.ctx, [path.join(canvasDir, 'model.json'), '--canvas', canvasDir, '--human'], human)
    ).toBe(EXIT.ok)
    expect(human.out).toEqual(['ok: model.json passes against 7 files'])

    const publishIo = fakeIo()
    expect(
      await runPublish(
        t.ctx,
        [canvasDir, '--agent', 'claude', '--model', 'opus', '--harness', 'claude-code'],
        publishIo
      )
    ).toBe(EXIT.ok)
    expect(lastJson(publishIo)).toEqual({
      status: 'published',
      sharing: expect.objectContaining({ status: 'failed', zipPath: expect.stringMatching(/\.zip$/) }),
      headSha: HEAD_SHA,
      reviewJsonPath: path.join(canvasDir, 'review.json'),
      attempts: 1,
      reviewUrl: 'http://localhost:3010/review/42',
    })
    // validate also reads a stored review.json, converting it back to the model's shape.
    const reviewIo = fakeIo()
    expect(
      await runValidate(t.ctx, [path.join(canvasDir, 'review.json'), '--canvas', canvasDir], reviewIo)
    ).toBe(EXIT.ok)
    expect(lastJson(reviewIo)).toEqual({ ok: true, errors: [] })

    const again = fakeIo()
    expect(await runPrepare(t.ctx, ['--pr', '42'], again)).toBe(EXIT.ok)
    expect((lastJson(again) as { status: string }).status).toBe('exists')
    const forced = fakeIo()
    expect(await runPrepare(t.ctx, ['--pr', '42', '--force'], forced)).toBe(EXIT.ok)
    expect((lastJson(forced) as { status: string }).status).toBe('prepared')
  })

  it('--fix trims an over-cap title in place, reports it, and leaves the rest to the author', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const io = fakeIo()
    await runPrepare(t.ctx, ['--base', 'main', '--head', 'feat/b'], io)
    const { canvasDir } = lastJson(io) as { canvasDir: string }
    const model = path.join(canvasDir, 'model.json')
    const output = artifactToModelOutput(syntheticArtifact())
    const layer = output.layers[0]
    if (layer === undefined) {
      throw new Error('fixture changed')
    }
    const long = `${layer.title}: one active-SHL query, tracked uploads, and the manifest file swap`
    layer.title = long
    await writeFile(model, JSON.stringify(output))

    const human = fakeIo()
    expect(await runValidate(t.ctx, [model, '--canvas', canvasDir, '--human', '--fix'], human)).toBe(EXIT.ok)
    expect(human.out).toEqual([
      `fixed layers.0.title: "${long}" -> "Run path"`,
      'ok: model.json passes against 7 files',
    ])
    // The trim is written back, so the next publish sends the shortened title.
    const saved = JSON.parse(await readFile(model, 'utf8')) as typeof output
    expect(saved.layers[0]?.title).toBe('Run path')

    // A second run has nothing left to fix and says so.
    const again = fakeIo()
    expect(await runValidate(t.ctx, [model, '--canvas', canvasDir, '--fix'], again)).toBe(EXIT.ok)
    expect(lastJson(again)).toMatchObject({ ok: true, fixed: [] })
  })

  it('--fix clips and drops folds with one right answer, reports each, and is idempotent', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const io = fakeIo()
    await runPrepare(t.ctx, ['--base', 'main', '--head', 'feat/b'], io)
    const { canvasDir } = lastJson(io) as { canvasDir: string }
    const model = path.join(canvasDir, 'model.json')
    const output = artifactToModelOutput(syntheticArtifact())
    const file = output.layers[1]?.files[0]
    if (file?.path !== 'src/app.ts') {
      throw new Error('fixture changed')
    }
    // Hunk #2 spans new 11-14.
    file.folds = [
      { title: 'other()', side: 'new', startLine: 11, endLine: 20, level: 'moderate' },
      { title: 'other() again', side: 'new', startLine: 11, endLine: 14, level: 'aggressive' },
    ]
    await writeFile(model, JSON.stringify(output))

    const human = fakeIo()
    expect(await runValidate(t.ctx, [model, '--canvas', canvasDir, '--human', '--fix'], human)).toBe(EXIT.ok)
    expect(human.out).toEqual([
      'fixed layers.1.files.0.folds.0: fold "other()" new 11-20 -> new 11-14, clipped to the chunk it starts in',
      'fixed layers.1.files.0.folds.1: dropped fold "other() again" at new 11-14: it repeats the range of "other()"',
      'ok: model.json passes against 7 files',
    ])
    const saved = JSON.parse(await readFile(model, 'utf8')) as typeof output
    expect(saved.layers[1]?.files[0]?.folds).toEqual([
      { title: 'other()', side: 'new', startLine: 11, endLine: 14, level: 'moderate' },
    ])

    const again = fakeIo()
    expect(await runValidate(t.ctx, [model, '--canvas', canvasDir, '--fix'], again)).toBe(EXIT.ok)
    expect(lastJson(again)).toMatchObject({ ok: true, fixed: [] })
  })

  it('--fix reports an unfixable title in human and JSON output without rewriting the file', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const prepare = fakeIo()
    await runPrepare(t.ctx, ['--base', 'main', '--head', 'feat/b'], prepare)
    const { canvasDir } = lastJson(prepare) as { canvasDir: string }
    const model = path.join(canvasDir, 'model.json')
    const output = artifactToModelOutput(syntheticArtifact())
    output.layers[0]!.title = 'x'.repeat(61)
    const original = JSON.stringify(output)
    await writeFile(model, original)
    const human = fakeIo()
    expect(await runValidate(t.ctx, [model, '--canvas', canvasDir, '--human', '--fix'], human)).toBe(
      EXIT.invalid
    )
    expect(human.out[0]).toBe(
      'unfixable layers.0.title: 61 visible chars, cap 60, no explainer separator (:, —, – or -) to drop; rewrite by hand'
    )
    expect(await readFile(model, 'utf8')).toBe(original)
    const json = fakeIo()
    expect(await runValidate(t.ctx, [model, '--canvas', canvasDir, '--fix'], json)).toBe(EXIT.invalid)
    expect(lastJson(json)).toMatchObject({
      fixed: [{ outcome: 'unfixable', where: 'layers.0.title', length: 61, cap: 60 }],
    })
  })

  it('prints the report lines and exits 5 for an invalid model, through validate and publish', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const io = fakeIo()
    await runPrepare(t.ctx, ['--base', 'main', '--head', 'feat/b'], io)
    const { canvasDir } = lastJson(io) as { canvasDir: string }
    const output = artifactToModelOutput(syntheticArtifact())
    output.layers[1]?.files.pop()
    await writeFile(path.join(canvasDir, 'model.json'), JSON.stringify(output))
    const human = fakeIo()
    expect(
      await runValidate(t.ctx, [path.join(canvasDir, 'model.json'), '--canvas', canvasDir, '--human'], human)
    ).toBe(EXIT.invalid)
    expect(human.out).toEqual([
      'HUNK_UNASSIGNED src_gone_ts#1 in src/gone.ts (@@ -1,2 +0,0 @@) is in no layer',
    ])
    const asJson = fakeIo()
    expect(
      await runValidate(t.ctx, [path.join(canvasDir, 'model.json'), '--canvas', canvasDir], asJson)
    ).toBe(EXIT.invalid)
    expect(lastJson(asJson)).toEqual({
      ok: false,
      errors: [
        {
          code: 'HUNK_UNASSIGNED',
          where: 'hunk:src_gone_ts#1',
          message: 'src_gone_ts#1 in src/gone.ts (@@ -1,2 +0,0 @@) is in no layer',
        },
      ],
    })
    const publishIo = fakeIo()
    const code = await runPublish(t.ctx, [canvasDir, '--agent', 'x', '--harness', 'other'], publishIo).catch(
      e => reportFailure(publishIo, e)
    )
    expect(code).toBe(EXIT.invalid)
    expect(publishIo.out).toEqual([
      'HUNK_UNASSIGNED src_gone_ts#1 in src/gone.ts (@@ -1,2 +0,0 @@) is in no layer',
      JSON.stringify({
        error: {
          code: 'MODEL_INVALID',
          message: 'model.json has 1 problem',
          hint: 'fix model.json and run publish again',
        },
      }),
    ])
    await writeFile(path.join(canvasDir, 'model.json'), 'not json')
    const bad = fakeIo()
    expect(
      await runValidate(t.ctx, [path.join(canvasDir, 'model.json'), '--canvas', canvasDir, '--human'], bad)
    ).toBe(EXIT.invalid)
    expect(bad.out[0]).toMatch(/^SCHEMA model\.json is not valid JSON: /)
  })

  it('rejects bad flags as usage errors and missing files as NOT_FOUND', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const io = fakeIo()
    await expect(runPrepare(t.ctx, [], io)).rejects.toThrow(
      'prepare needs a target: pass one of --pr <n>, --branch, --uncommitted, or --base <ref> --head <ref>'
    )
    await expect(runPrepare(t.ctx, ['--pr', 'x'], io)).rejects.toThrow(
      '--pr must be a positive integer, got "x"'
    )
    await expect(runPrepare(t.ctx, ['--pr', '1', '--head', 'h'], io)).rejects.toThrow(/pass one of --pr/)
    await expect(runPrepare(t.ctx, ['--base', 'main'], io)).rejects.toThrow(/prepare needs/)
    await expect(runPrepare(t.ctx, ['--nope'], io)).rejects.toMatchObject({
      code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
    })
    expect(parsePrepareTarget({ base: 'a', head: 'b' })).toEqual({ kind: 'refs', base: 'a', head: 'b' })
    expect(parsePrepareTarget({ branch: true })).toEqual({
      kind: 'local',
      source: 'branch',
      base: undefined,
    })
    // The base the user named is carried through; `prepare` resolves an absent one from the clone.
    expect(parsePrepareTarget({ uncommitted: true, base: 'main' })).toEqual({
      kind: 'local',
      source: 'uncommitted',
      base: 'main',
    })
    expect(() => parsePrepareTarget({ pr: '1', branch: true })).toThrow(/pass one of --pr/)
    expect(() => parsePrepareTarget({ uncommitted: true, head: 'HEAD' })).toThrow(/takes no --head/)
    expect(() => parsePrepareTarget({ branch: true, uncommitted: true })).toThrow(
      /two reviews; ask for one of them/
    )
    await expect(runValidate(t.ctx, [], io)).rejects.toThrow(/validate takes one file/)
    await expect(runValidate(t.ctx, ['a', 'b', '--canvas', 'c'], io)).rejects.toThrow(
      /validate takes one file/
    )
    await expect(runValidate(t.ctx, ['a.json'], io)).rejects.toThrow(/needs --canvas/)
    await expect(
      runValidate(t.ctx, ['a.json', '--canvas', path.join(t.dataDir, 'nope')], io)
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await runPrepare(t.ctx, ['--pr', '42'], io)
    const { canvasDir } = lastJson(io) as { canvasDir: string }
    await expect(
      runValidate(t.ctx, [path.join(canvasDir, 'zzz.json'), '--canvas', canvasDir], io)
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: `${path.join(canvasDir, 'zzz.json')} does not exist`,
    })
    await expect(runPublish(t.ctx, [], io)).rejects.toThrow(/publish takes one directory/)
    await expect(runPublish(t.ctx, [canvasDir, '--harness', 'other'], io)).rejects.toThrow(
      'publish needs --agent <id>'
    )
    await expect(runPublish(t.ctx, [canvasDir, '--agent', 'a'], io)).rejects.toThrow(
      /publish needs --harness/
    )
    await expect(runPublish(t.ctx, [canvasDir, '--agent', 'a', '--harness', 'vim'], io)).rejects.toThrow(
      '--harness must be one of claude-code, codex, other, got "vim"'
    )
  })

  it('maps every failure to an envelope line and an exit code', () => {
    const cases: Array<[unknown, number, string, string?]> = [
      [new UsageError('bad'), EXIT.usage, 'BAD_REQUEST', 'run pr-review --help'],
      [
        Object.assign(new Error('unknown option'), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' }),
        EXIT.usage,
        'BAD_REQUEST',
      ],
      [
        new PublishError('CANVAS_STALE', 'moved', 'prepare again'),
        EXIT.error,
        'CANVAS_STALE',
        'prepare again',
      ],
      [new HostCliError('gh', 'x', 'HTTP 401', 1), EXIT.gh, 'GH_UNAUTHENTICATED'],
      [new HostCliError('gh', 'x', 'gh: command not found', 127, true), EXIT.gh, 'GH_MISSING'],
      [new HostCliError('gh', 'x', 'HTTP 500', 1), EXIT.error, 'GITHUB_API_ERROR'],
      [new HostCliError('glab', 'x', '401 Unauthorized', 1), EXIT.gh, 'GLAB_UNAUTHENTICATED'],
      [new HostCliError('glab', 'x', 'glab: command not found', 127, true), EXIT.gh, 'GLAB_MISSING'],
      [new HostCliError('glab', 'x', 'HTTP 500', 1), EXIT.error, 'GITLAB_API_ERROR'],
      [new PrNotFoundError(9), EXIT.error, 'PR_NOT_FOUND'],
      [new GitError(['fetch'], 'boom', 128), EXIT.error, 'GIT_ERROR'],
      [new ConfigError('NOT_A_REPO', 'nope', 'cd somewhere'), EXIT.error, 'NOT_A_REPO', 'cd somewhere'],
      [
        new SkillDirExistsError('/r/.claude/skills/pr-review-canvas'),
        EXIT.error,
        'SKILL_DIR_EXISTS',
        'remove it, or pass --force to replace it',
      ],
      [new Error('other'), EXIT.error, 'INTERNAL'],
      ['string', EXIT.error, 'INTERNAL'],
    ]
    for (const [err, exit, code, hint] of cases) {
      const io = fakeIo()
      expect(reportFailure(io, err), code).toBe(exit)
      const envelope = lastJson(io) as { error: { code: string; hint?: string } }
      expect(envelope.error.code).toBe(code)
      if (hint !== undefined) {
        expect(envelope.error.hint).toBe(hint)
      }
    }
    const io = fakeIo()
    const report = { ok: false, errors: [{ code: 'LAYER_EMPTY' as const, message: 'layer x has no hunks' }] }
    expect(reportFailure(io, new ModelInvalidError(report, 2))).toBe(EXIT.invalid)
    expect(io.out).toEqual([
      'LAYER_EMPTY layer x has no hunks',
      JSON.stringify({
        error: {
          code: 'MODEL_INVALID',
          message: 'model.json has 1 problem',
          hint: 'fix model.json and run publish again',
        },
      }),
    ])
  })
})

describe('splitCommonFlags', () => {
  it('lifts --repo and --data-dir out and keeps every other token in order', () => {
    const cases: Array<[string[], ReturnType<typeof splitCommonFlags>]> = [
      [
        ['--pr', '42', '--repo', 'x', '--force'],
        { repo: 'x', dataDir: undefined, rest: ['--pr', '42', '--force'] },
      ],
      [
        ['dir', '--repo', '../..', '--agent', 'claude', '--model=opus'],
        { repo: '../..', dataDir: undefined, rest: ['dir', '--agent', 'claude', '--model=opus'] },
      ],
      [
        ['--data-dir=/d', '--agent', 'a', 'dir'],
        { repo: undefined, dataDir: '/d', rest: ['--agent', 'a', 'dir'] },
      ],
      [
        ['--repo=r', '--data-dir', 'd', '--harness', 'other'],
        { repo: 'r', dataDir: 'd', rest: ['--harness', 'other'] },
      ],
      [['--allow-stale', 'dir'], { repo: undefined, dataDir: undefined, rest: ['--allow-stale', 'dir'] }],
      [[], { repo: undefined, dataDir: undefined, rest: [] }],
      [['--repo'], { repo: undefined, dataDir: undefined, rest: [] }],
    ]
    for (const [argv, expected] of cases) {
      expect(splitCommonFlags(argv), argv.join(' ')).toEqual(expected)
    }
  })
})

describe('install-skill through the CLI layer', () => {
  it.each([
    [undefined, '.pr-review/settings.yml\n'],
    ['# Local files\nnode_modules/', '# Local files\nnode_modules/\n.pr-review/settings.yml\n'],
    ['node_modules/\r\n', 'node_modules/\r\n.pr-review/settings.yml\r\n'],
    ['.pr-review/settings.yml\n', '.pr-review/settings.yml\n'],
    ['/.pr-review/settings.yml\n', '/.pr-review/settings.yml\n'],
  ])('preserves existing ignore rules and adds local settings once (%j)', async (before, expected) => {
    const repoRoot = await makeTempDir()
    try {
      const file = path.join(repoRoot, '.gitignore')
      if (before !== undefined) {
        await writeFile(file, before)
      }
      const cwd = path.join(repoRoot, 'nested')
      await mkdir(cwd)
      const env = { repoRoot, cwd }
      await runInstallSkill(env, [], fakeIo())
      await runInstallSkill(env, [], fakeIo())
      expect(await readFile(file, 'utf8')).toBe(expected)
      await expect(readFile(path.join(cwd, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('installs under the repo root by default and where the flags say otherwise', async () => {
    const repoRoot = await makeTempDir()
    const io = fakeIo()
    expect(await runInstallSkill({ repoRoot, cwd: repoRoot }, [], io)).toBe(EXIT.ok)
    const result = lastJson(io) as { targets: Array<{ kind: string; path: string; status: string }> }
    expect(result.targets).toEqual([
      {
        kind: 'claude',
        path: expect.stringMatching(/\.claude\/skills\/pr-review-canvas$/),
        status: 'copied',
      },
      { kind: 'codex', path: expect.stringMatching(/\.agents\/skills\/pr-review-canvas$/), status: 'copied' },
    ])
    expect(
      await readFile(path.join(repoRoot, '.claude', 'skills', 'pr-review-canvas', 'SKILL.md'), 'utf8')
    ).toContain('pr-review-canvas')
    await mkdir(path.join(repoRoot, 'custom'))
    const custom = fakeIo()
    await runInstallSkill(
      { repoRoot, cwd: repoRoot },
      ['--claude-dir', 'custom/a', '--codex-dir', path.join(repoRoot, 'custom', 'b')],
      custom
    )
    const paths = (lastJson(custom) as { targets: Array<{ path: string }> }).targets.map(
      target => target.path
    )
    const root = await realpath(repoRoot)
    expect(paths.map(p => path.relative(root, p))).toEqual([
      'custom/a/pr-review-canvas',
      'custom/b/pr-review-canvas',
    ])
    await rm(repoRoot, { recursive: true, force: true })
  })
})

describe('export and import through the CLI layer', () => {
  const manifestFor = (headSha: string) => ({
    formatVersion: 1 as const,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: { owner: 'acme', name: 'widgets' },
    headSha,
    mergeBaseSha: 'b'.repeat(40),
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code' as const, attempts: 1 },
  })

  it('exports for a PR and imports the same file back as an existing canvas', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const artifact = { ...syntheticArtifact(), generatedAt: '2026-09-10T11:00:00.000Z' }
    await t.ctx.canvases.write(HEAD_SHA, artifact, manifestFor(HEAD_SHA))
    const io = fakeIo()
    expect(await runExport(t.ctx, ['--pr', '42'], io)).toBe(EXIT.ok)
    const exported = lastJson(io) as { path: string; name: string; prNumber: number }
    expect(exported.name).toBe('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip')
    expect(exported.prNumber).toBe(42)
    expect(io.err[0]).toContain('drag')

    const back = fakeIo()
    expect(await runImport(t.ctx, [exported.path, '--pr', '42'], back)).toBe(EXIT.ok)
    expect(lastJson(back)).toMatchObject({ status: 'exists', headSha: HEAD_SHA, currentHeadSha: HEAD_SHA })
  })

  it('exports for a ref without a PR number', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), manifestFor(HEAD_SHA))
    const io = fakeIo()
    expect(await runExport(t.ctx, ['--head', 'feat/b'], io)).toBe(EXIT.ok)
    expect(lastJson(io)).toMatchObject({ name: 'ref-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip' })
  })

  it('exports the named commit and stamps the number when both flags are given', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), manifestFor(HEAD_SHA))
    const io = fakeIo()
    // This is what the generation skill runs right after publishing a canvas for a PR.
    expect(await runExport(t.ctx, ['--head', HEAD_SHA, '--pr', '42'], io)).toBe(EXIT.ok)
    expect(lastJson(io)).toMatchObject({
      name: 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      headSha: HEAD_SHA,
      prNumber: 42,
    })
  })

  it('refuses a target that names neither a PR nor a ref', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await expect(runExport(t.ctx, [], fakeIo())).rejects.toThrow(/--pr <n> or --head/)
  })

  it('refuses a zip that is larger than the canvas size cap', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const big = path.join(t.dataDir, 'big.zip')
    await writeFile(big, Buffer.alloc(21 * 1024 * 1024))
    await expect(runImport(t.ctx, [big], fakeIo())).rejects.toMatchObject({ code: 'CANVAS_TOO_LARGE' })
  })

  it('reports a missing zip and a wrong argument count on import', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await expect(runImport(t.ctx, [path.join(t.dataDir, 'nope.zip')], fakeIo())).rejects.toThrow(
      /does not exist/
    )
    await expect(runImport(t.ctx, [], fakeIo())).rejects.toThrow(/takes one zip/)
  })

  it('imports a zip with no PR context and reports the canvas as current', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), manifestFor(HEAD_SHA))
    const exported = fakeIo()
    await runExport(t.ctx, ['--head', 'feat/b'], exported)
    const { path: zip } = lastJson(exported) as { path: string }
    const fresh = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    try {
      const io = fakeIo()
      expect(await runImport(fresh.ctx, [zip], io)).toBe(EXIT.ok)
      expect(lastJson(io)).toMatchObject({ status: 'ready', headSha: HEAD_SHA, currentHeadSha: HEAD_SHA })
    } finally {
      await fresh.cleanup()
    }
  })
})
