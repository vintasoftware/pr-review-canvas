// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { AppError } from '../server/errors.js'
import { createFakeGit, makeTempDir, makeTestContext, TEST_REPO, type TestContext } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA, SYNTHETIC_DIFF, syntheticArtifact } from '../testing/synthetic.js'
import { defaultExportDir, exportCanvas, resolveOutPath } from './export.js'
import { importCanvas } from './import.js'
import { buildCanvasZipName, parseCanvasZipName, repoSlug } from './name.js'
import { buildCanvasZip, CANVAS_ZIP_MAX_BYTES, CanvasZipError, readCanvasZip } from './zip.js'

const OTHER_SHA = 'c'.repeat(40)

function manifest(over: Partial<CanvasManifest> = {}): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: TEST_REPO,
    prNumber: 42,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
    ...over,
  }
}

function artifact(over: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return { ...syntheticArtifact(), generatedAt: '2026-09-10T11:00:00.000Z', ...over }
}

/** A manifest of a canvas generated before the pull request was opened. */
function beforeThePr(over: Partial<CanvasManifest> = {}): CanvasManifest {
  const { prNumber: _none, ...rest } = manifest(over)
  return rest
}

function prWithoutNumber(): ReviewArtifact['pr'] {
  return { ...artifact().pr, number: null }
}

describe('canvas zip name', () => {
  it('builds and parses the PR form and the pre-PR form', () => {
    const withPr = buildCanvasZipName({
      repo: TEST_REPO,
      generatedAt: manifest().generatedAt,
      headSha: HEAD_SHA,
      prNumber: 42,
    })
    const withoutPr = buildCanvasZipName({
      repo: TEST_REPO,
      generatedAt: manifest().generatedAt,
      headSha: HEAD_SHA,
    })
    expect(withPr).toBe('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip')
    expect(withoutPr).toBe('ref-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip')
    expect(parseCanvasZipName(withPr, TEST_REPO)).toEqual({ prNumber: 42, shaPrefix: 'aaaaaaaa' })
    expect(parseCanvasZipName(withoutPr, TEST_REPO)).toEqual({ shaPrefix: 'aaaaaaaa' })
  })

  it('normalizes generation time to UTC seconds and sorts by time before commit hash', () => {
    const opts = { repo: TEST_REPO, headSha: HEAD_SHA, prNumber: 42 }
    const normalized = buildCanvasZipName({ ...opts, generatedAt: '2026-09-10T08:00:00.987-03:00' })
    expect(normalized).toBe('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip')
    const times = ['2027-01-01T00:00:00Z', '2026-12-31T23:59:59Z', '2026-09-10T11:00:01Z']
    const names = times.map((generatedAt, i) =>
      buildCanvasZipName({
        ...opts,
        generatedAt,
        headSha: String(i).repeat(40),
      })
    )
    expect([...names].sort()).toEqual([...names].reverse())
  })

  it('slugs characters a file name should not carry', () => {
    const repo = { owner: 'Vinta.Software', name: 'building_blocks' }
    expect(repoSlug(repo)).toBe('vinta-software-building-blocks')
    const name = buildCanvasZipName({
      repo,
      generatedAt: manifest().generatedAt,
      headSha: HEAD_SHA,
      prNumber: 7,
    })
    expect(name).toBe('pr-7-20260910T110000Z-aaaaaaaa-vinta-software-building-blocks-canvas.zip')
    expect(parseCanvasZipName(name, repo)).toEqual({ prNumber: 7, shaPrefix: 'aaaaaaaa' })
  })

  it('refuses a name for another repo, another tool, a bad sha, or another extension', () => {
    expect(parseCanvasZipName('pr-42-20260910T110000Z-aaaaaaaa-other-repo-canvas.zip', TEST_REPO)).toBeNull()
    expect(parseCanvasZipName('logs-acme-widgets-pr42-aaaaaaa.zip', TEST_REPO)).toBeNull()
    expect(
      parseCanvasZipName('pr-42-20260910T110000Z-zzzzzzzz-acme-widgets-canvas.zip', TEST_REPO)
    ).toBeNull()
    expect(
      parseCanvasZipName('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.tar', TEST_REPO)
    ).toBeNull()
    expect(parseCanvasZipName('ref-20260910T110000Z-aaaaaaaaa-acme-widgets-canvas.zip', TEST_REPO)).toBeNull()
  })
})

describe('canvas zip codec', () => {
  it('round-trips the manifest and the artifact', () => {
    const bytes = buildCanvasZip(manifest(), artifact())
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(readCanvasZip(bytes)).toEqual({ manifest: manifest(), artifact: artifact() })
  })

  it('refuses a file that is not a zip', () => {
    const err = catchZip(() => readCanvasZip(strToU8('not a zip at all')))
    expect(err.code).toBe('CANVAS_INVALID')
    expect(err.issues).toEqual(['the file does not start with the zip signature'])
  })

  it('refuses a zip above the size cap before reading it', () => {
    const bytes = new Uint8Array(CANVAS_ZIP_MAX_BYTES + 1)
    bytes.set([0x50, 0x4b, 0x03, 0x04])
    const err = catchZip(() => readCanvasZip(bytes))
    expect(err.code).toBe('CANVAS_TOO_LARGE')
  })

  it('refuses a zip missing an entry, and ignores names with a directory part', () => {
    const nested = zipSync({
      'canvas/manifest.json': strToU8(JSON.stringify(manifest())),
      '../review.json': strToU8(JSON.stringify(artifact())),
      'manifest.json': strToU8(JSON.stringify(manifest())),
    })
    const err = catchZip(() => readCanvasZip(nested))
    expect(err.code).toBe('CANVAS_INVALID')
    expect(err.issues).toEqual(['review.json is missing from the zip'])
  })

  it('refuses entries that are not JSON, and entries that fail their schema', () => {
    const notJson = zipSync({ 'manifest.json': strToU8('{'), 'review.json': strToU8('{') })
    expect(catchZip(() => readCanvasZip(notJson)).issues).toEqual([
      'manifest.json is not valid JSON',
      'review.json is not valid JSON',
    ])
    const badSchema = zipSync({
      'manifest.json': strToU8(JSON.stringify({ ...manifest(), headSha: 'nope' })),
      'review.json': strToU8(JSON.stringify({ ...artifact(), version: 2 })),
    })
    const issues = catchZip(() => readCanvasZip(badSchema)).issues
    expect(issues.some(i => i.startsWith('manifest.json: headSha'))).toBe(true)
    expect(issues.some(i => i.startsWith('review.json: version'))).toBe(true)
  })

  it('inflates each entry once and stops when the two together pass the cap', () => {
    // Two entries that each fit but together inflate past the cap. Trailing spaces keep the
    // first one valid JSON, so only the size decides what is read.
    const padding = ' '.repeat(11 * 1024 * 1024)
    const bomb = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest()) + padding),
      'review.json': strToU8(JSON.stringify(artifact()) + padding),
    })
    // review.json alone fits, but the pair would inflate past the cap, so it is left out.
    expect(catchZip(() => readCanvasZip(bomb)).issues).toEqual(['review.json is missing from the zip'])
  }, 15_000)

  it('inflates no more than an entry claims, so an understated size cannot expand in memory', () => {
    // fflate reads the declared uncompressed size and stops there, which is what the entry
    // budget above relies on: a header that lies produces a truncated entry, not a huge one.
    // A zip that reads fine untampered: only the forged size makes review.json unreadable.
    const padded = `${JSON.stringify(artifact())}${' '.repeat(200_000)}`
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest())),
      'review.json': strToU8(padded),
    })
    expect(
      readCanvasZip(
        zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest())), 'review.json': strToU8(padded) })
      ).artifact
    ).toEqual(artifact())
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const text = new TextDecoder('latin1').decode(zip)
    for (let i = 0; i < zip.length - 4; i++) {
      // The central directory record of review.json: its name sits 46 bytes past the signature.
      const isRecord = zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02
      if (isRecord && text.startsWith('review.json', i + 46)) {
        view.setUint32(i + 24, 10, true)
      }
    }
    expect(catchZip(() => readCanvasZip(zip)).issues).toEqual(['review.json is not valid JSON'])
  })

  it('names nothing from the file it rejects, whatever the file claims', () => {
    const sentinel = 'PRIVATE-SENTINEL-9f3a'
    const bad = zipSync({
      'manifest.json': strToU8(JSON.stringify({ ...manifest(), formatVersion: sentinel })),
      'review.json': strToU8(
        JSON.stringify({
          ...artifact(),
          generator: { ...artifact().generator, harness: sentinel },
          summary: sentinel,
        })
      ),
    })
    const err = catchZip(() => readCanvasZip(bad))
    expect(err.issues.length).toBeGreaterThan(0)
    expect(err.issues.join(' ')).not.toContain(sentinel)
    expect(err.message).not.toContain(sentinel)
  })

  it('reads a canvas written before the pull request carried an edit time', () => {
    const older = artifact()
    const { updatedAt: _dropped, ...prWithoutEditTime } = older.pr
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest())),
      'review.json': strToU8(JSON.stringify({ ...older, pr: prWithoutEditTime })),
    })
    expect(readCanvasZip(zip).artifact.pr.updatedAt).toBeUndefined()
  })

  it('refuses a zip whose central directory is damaged', () => {
    const bytes = buildCanvasZip(manifest(), artifact())
    bytes.fill(0, bytes.length - 40)
    const err = catchZip(() => readCanvasZip(bytes))
    expect(err.code).toBe('CANVAS_INVALID')
    expect(err.issues).toHaveLength(1)
  })

  it('refuses a zip whose two entries name different pull requests', () => {
    const mismatched = buildCanvasZip(manifest({ prNumber: 7 }), artifact())
    expect(catchZip(() => readCanvasZip(mismatched)).issues).toEqual([
      'review.json is for #42 while manifest.json says #7',
    ])
    // A canvas generated before the pull request existed carries the number on the manifest only.
    expect(
      readCanvasZip(buildCanvasZip(manifest({ prNumber: 7 }), artifact({ pr: prWithoutNumber() }))).manifest
        .prNumber
    ).toBe(7)
  })

  it('refuses a zip whose two entries name different commits', () => {
    const mismatched = buildCanvasZip(manifest({ headSha: OTHER_SHA, mergeBaseSha: BASE_SHA }), artifact())
    expect(catchZip(() => readCanvasZip(mismatched)).issues).toEqual([
      'review.json is for aaaaaaa while manifest.json says ccccccc',
    ])
  })
})

function catchZip(fn: () => unknown): CanvasZipError {
  try {
    fn()
  } catch (err) {
    if (err instanceof CanvasZipError) {
      return err
    }
    throw err
  }
  throw new Error('expected a CanvasZipError')
}

async function catchApp(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof AppError) {
      return err
    }
    throw err
  }
  throw new Error('expected an AppError')
}

describe('importCanvas', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  /** A clone that has both commits of the canvas, so derived/ can be rebuilt. */
  function contextWithCommits(): Promise<TestContext> {
    return makeTestContext({
      git: createFakeGit({
        refs: { head: HEAD_SHA, base: BASE_SHA, other: OTHER_SHA },
        mergeBases: { [`${BASE_SHA}..${HEAD_SHA}`]: BASE_SHA },
        diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF },
        ancestors: { [`${HEAD_SHA}..${OTHER_SHA}`]: true },
        counts: { [`${HEAD_SHA}..${OTHER_SHA}`]: 3 },
      }),
    })
  }

  it('stores a canvas for the current head as ready, with its diffs rebuilt', async () => {
    t = await contextWithCommits()
    const result = await importCanvas(t.ctx, {
      bytes: buildCanvasZip(manifest(), artifact()),
      prNumber: 42,
      currentHeadSha: HEAD_SHA,
    })
    expect(result).toEqual({
      status: 'ready',
      headSha: HEAD_SHA,
      currentHeadSha: HEAD_SHA,
      derivable: true,
      warnings: [],
    })
    const stored = await t.ctx.canvases.readArtifact(HEAD_SHA)
    expect(stored?.source).toBe('import')
    expect(stored?.importedAt).toBe('2026-09-10T12:00:00.000Z')
    expect((await t.ctx.canvases.readIndex()).canvases[HEAD_SHA]?.prNumber).toBe(42)
    expect((await t.ctx.derived.read(HEAD_SHA))?.files.length).toBeGreaterThan(0)
  })

  it('reports a canvas for an ancestor of the head as stale with the distance', async () => {
    t = await contextWithCommits()
    const result = await importCanvas(t.ctx, {
      bytes: buildCanvasZip(manifest(), artifact()),
      prNumber: 42,
      currentHeadSha: OTHER_SHA,
    })
    expect(result).toEqual({
      status: 'stale',
      headSha: HEAD_SHA,
      currentHeadSha: OTHER_SHA,
      relation: 'ancestor',
      commitsBehind: 3,
      derivable: true,
      warnings: [],
    })
  })

  it('reports a canvas from a discarded branch as unrelated', async () => {
    t = await contextWithCommits()
    const result = await importCanvas(t.ctx, {
      bytes: buildCanvasZip(manifest(), artifact()),
      currentHeadSha: 'd'.repeat(40),
    })
    expect(result.status).toBe('stale')
    expect(result.relation).toBe('unrelated')
    expect(result.commitsBehind).toBeUndefined()
  })

  it('keeps the stored canvas when the zip is not newer, and takes it when it is', async () => {
    t = await contextWithCommits()
    const first = buildCanvasZip(beforeThePr(), artifact({ summary: 'first', pr: prWithoutNumber() }))
    await importCanvas(t.ctx, { bytes: first, currentHeadSha: HEAD_SHA })
    const same = await importCanvas(t.ctx, { bytes: first, prNumber: 9, currentHeadSha: HEAD_SHA })
    expect(same.status).toBe('exists')
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.summary).toBe('first')
    // The PR number is still recorded, which is how a pre-PR export joins its pull request.
    expect((await t.ctx.canvases.readIndex()).canvases[HEAD_SHA]?.prNumber).toBe(9)
    const newer = buildCanvasZip(
      manifest({ generatedAt: '2026-09-11T09:00:00.000Z' }),
      artifact({ summary: 'second', generatedAt: '2026-09-11T09:00:00.000Z' })
    )
    const replaced = await importCanvas(t.ctx, { bytes: newer, currentHeadSha: HEAD_SHA })
    expect(replaced.status).toBe('ready')
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.summary).toBe('second')
  })

  it('reports exists for a second import that names no pull request', async () => {
    t = await contextWithCommits()
    const zip = buildCanvasZip(manifest(), artifact())
    await importCanvas(t.ctx, { bytes: zip, currentHeadSha: HEAD_SHA })
    const again = await importCanvas(t.ctx, { bytes: zip, currentHeadSha: HEAD_SHA })
    expect(again.status).toBe('exists')
    expect((await t.ctx.canvases.readIndex()).canvases[HEAD_SHA]?.prNumber).toBe(42)
  })

  it('refuses a canvas from another repository unless force is passed', async () => {
    t = await contextWithCommits()
    const foreign = buildCanvasZip(manifest({ repo: { owner: 'other', name: 'repo' } }), artifact())
    const err = await catchApp(() => importCanvas(t.ctx, { bytes: foreign, currentHeadSha: HEAD_SHA }))
    expect(err.code).toBe('CANVAS_REPO_MISMATCH')
    expect(err.status).toBe(400)
    const forced = await importCanvas(t.ctx, {
      bytes: foreign,
      currentHeadSha: HEAD_SHA,
      force: true,
    })
    expect(forced.status).toBe('ready')
    expect(forced.warnings).toEqual(['imported a canvas exported from other/repo'])
  })

  it('refuses a canvas exported for another pull request unless force is passed', async () => {
    t = await contextWithCommits()
    const zip = buildCanvasZip(manifest(), artifact())
    const err = await catchApp(() =>
      importCanvas(t.ctx, { bytes: zip, prNumber: 7, currentHeadSha: HEAD_SHA })
    )
    expect([err.code, err.status]).toEqual(['CANVAS_PR_MISMATCH', 400])
    expect(err.message).toBe('this canvas was exported for #42, and it is being imported for #7')
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
    const forced = await importCanvas(t.ctx, {
      bytes: zip,
      prNumber: 7,
      currentHeadSha: HEAD_SHA,
      force: true,
    })
    expect(forced.status).toBe('ready')
    expect(forced.warnings).toEqual(['imported a canvas exported for #42'])
  })

  it('reads the pull request from review.json when the manifest names none', async () => {
    t = await contextWithCommits()
    const zip = buildCanvasZip(beforeThePr(), artifact())
    const err = await catchApp(() =>
      importCanvas(t.ctx, { bytes: zip, prNumber: 7, currentHeadSha: HEAD_SHA })
    )
    expect(err.code).toBe('CANVAS_PR_MISMATCH')
  })

  it('takes a canvas exported before the pull request existed, and one imported without a PR', async () => {
    t = await contextWithCommits()
    const prePr = buildCanvasZip(beforeThePr(), artifact({ pr: prWithoutNumber() }))
    const joined = await importCanvas(t.ctx, { bytes: prePr, prNumber: 7, currentHeadSha: HEAD_SHA })
    expect([joined.status, joined.warnings]).toEqual(['ready', []])
    expect((await t.ctx.canvases.readIndex()).canvases[HEAD_SHA]?.prNumber).toBe(7)
    // `pr-review import <zip>` without --pr has no pull request to disagree with.
    const anyPr = await importCanvas(t.ctx, {
      bytes: buildCanvasZip(
        manifest({ generatedAt: '2026-09-11T09:00:00.000Z' }),
        artifact({ generatedAt: '2026-09-11T09:00:00.000Z' })
      ),
      currentHeadSha: HEAD_SHA,
    })
    expect(anyPr.status).toBe('ready')
  })

  it('reports the zip errors as the HTTP envelope', async () => {
    t = await makeTestContext()
    const invalid = await catchApp(() =>
      importCanvas(t.ctx, { bytes: strToU8('nope'), currentHeadSha: HEAD_SHA })
    )
    expect([invalid.code, invalid.status]).toEqual(['CANVAS_INVALID', 400])
    const big = new Uint8Array(CANVAS_ZIP_MAX_BYTES + 1)
    big.set([0x50, 0x4b, 0x03, 0x04])
    const large = await catchApp(() => importCanvas(t.ctx, { bytes: big }))
    expect([large.code, large.status]).toEqual(['CANVAS_TOO_LARGE', 413])
  })

  it('fetches the missing commits from origin before giving up on the diffs', async () => {
    const git = createFakeGit({
      fetchable: [HEAD_SHA, BASE_SHA],
      diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF },
    })
    t = await makeTestContext({ git })
    const result = await importCanvas(t.ctx, {
      bytes: buildCanvasZip(manifest(), artifact()),
      currentHeadSha: HEAD_SHA,
    })
    expect(result.derivable).toBe(true)
    expect(git.calls.some(c => c[0] === 'fetch' && c.includes(HEAD_SHA))).toBe(true)
  })

  it('reports derivable false when rebuilding the diffs fails', async () => {
    // Both commits are there, but the diff between them is not: the canvas is stored anyway.
    t = await makeTestContext({
      git: createFakeGit({ refs: { head: HEAD_SHA, base: BASE_SHA } }),
    })
    const result = await importCanvas(t.ctx, {
      bytes: buildCanvasZip(manifest(), artifact()),
      currentHeadSha: HEAD_SHA,
    })
    expect(result.derivable).toBe(false)
    expect(result.warnings[0]).toContain('could not be rebuilt')
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
  })

  it('stores the canvas and reports derivable false when the commits stay out of reach', async () => {
    t = await makeTestContext({ git: createFakeGit() })
    const result = await importCanvas(t.ctx, {
      bytes: buildCanvasZip(manifest(), artifact()),
      prNumber: 42,
      currentHeadSha: HEAD_SHA,
    })
    expect(result.derivable).toBe(false)
    expect(result.warnings).toEqual(['aaaaaaa is not in this clone, so the diffs are not available'])
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
  })
})

describe('exportCanvas', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('writes the zip to the data dir and stamps the PR number', async () => {
    t = await makeTestContext()
    const { prNumber: _ignored, ...noPr } = manifest()
    await t.ctx.canvases.write(HEAD_SHA, artifact(), noPr)
    const result = await exportCanvas(t.ctx, { headSha: HEAD_SHA, prNumber: 42 })
    expect(result).toEqual({
      status: 'exported',
      path: path.join(defaultExportDir(t.ctx), 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'),
      name: 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      headSha: HEAD_SHA,
      prNumber: 42,
    })
    const read = readCanvasZip(new Uint8Array(await readFile(result.path)))
    expect(read.manifest.prNumber).toBe(42)
    expect(read.artifact).toEqual(artifact())
  })

  it('uses the ref prefix when there is no PR yet', async () => {
    t = await makeTestContext()
    const { prNumber: _ignored, ...noPr } = manifest()
    await t.ctx.canvases.write(HEAD_SHA, artifact(), noPr)
    const result = await exportCanvas(t.ctx, { headSha: HEAD_SHA })
    expect(result.name).toBe('ref-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip')
    expect(result.prNumber).toBeUndefined()
  })

  it('answers CANVAS_NOT_FOUND for a head with no canvas', async () => {
    t = await makeTestContext()
    const err = await catchApp(() => exportCanvas(t.ctx, { headSha: OTHER_SHA }))
    expect([err.code, err.status]).toEqual(['CANVAS_NOT_FOUND', 404])
  })

  it('reads --out as a file, as a directory, and as a new path', async () => {
    const dir = await makeTempDir()
    expect(await resolveOutPath(undefined, dir, 'a.zip')).toBe(path.join(dir, 'a.zip'))
    expect(await resolveOutPath(path.join(dir, 'b.zip'), dir, 'a.zip')).toBe(path.join(dir, 'b.zip'))
    expect(await resolveOutPath(dir, dir, 'a.zip')).toBe(path.join(dir, 'a.zip'))
    expect(await resolveOutPath(path.join(dir, 'nested'), dir, 'a.zip')).toBe(path.join(dir, 'nested'))
  })
})
