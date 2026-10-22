// @vitest-environment node
// Settled decisions against a real repository, through `prepare` and `publish` as a run meets
// them. The decision lines are written by `git commit` and read back by the real adapter, so the
// parsing, the author filter, and the line carry all see what git actually produces.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { GenerationContextSchema } from '../contract/generation-context.js'
import { createGit, GitError } from '../git/git.js'
import { execGitAsRepoConfig, makeTempDir, makeTestContext, type TestContext } from '../testing/fakes.js'
import { fingerprint } from './normalize.js'
import { prepare } from './prepare.js'
import { publish } from './publish.js'
import { withSettlement } from './self-review.js'

// Commits here are by the people the repository's config names, not by whoever commits outside it.
async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await execGitAsRepoConfig(cwd, args)
  if (result.code !== 0) {
    throw new GitError(args, result.stderr, result.code)
  }
  return result.stdout.toString('utf8').trim()
}

async function write(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await writeFile(path.join(dir, file), content, 'utf8')
}

/** A commit whose message is these paragraphs, each its own `-m`. */
async function commit(dir: string, paragraphs: string[], ...flags: string[]): Promise<string> {
  await runGit(dir, ...flags, 'commit', '-q', '-a', ...paragraphs.flatMap(paragraph => ['-m', paragraph]))
  return runGit(dir, 'rev-parse', 'HEAD')
}

const APP = 'a\nb\nc\nd\nE!\nf\ng\nh\n'
// The decision and its revision ask one question; each answer is its own decision.
const ASKED = 'Should E! be lowercased?'
const REASON = 'No: the callers compare it raw'
const REVISED = 'Not until the callers move to the enum'
const KEEP_TWO = 'Should two stay for old readers?'
const DROPPED = 'No: nothing reads it since the reader moved'
// Two questions about one line, each with its answer, and one asked and left open.
const WHY_B = 'Why uppercase B?'
const B_REASON = 'The callers expect it'
const B_FINAL = 'Is B final?'
const B_YES = 'Yes: the spec names it'
const UNANSWERED = 'Is H right?'
const MOVED = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join('')
const PAIR = Array.from({ length: 10 }, (_, i) => `pair ${i + 1}\n`).join('')

describe('settled decisions against a real repository', () => {
  let dir: string
  // In order: the author's decision, followed by a blank line and an attribution as the loop writes
  // it; another person's commit with a decision of their own; lines added above the decided one;
  // the same line decided again; a deleted line decided as numbered in its parent; the decided line
  // edited; the deleted line restored, with the line under it changed; a file renamed, then a line of
  // it deleted and decided under its new name; another file renamed with a line deleted in one
  // commit, whose message also asks two questions about one line and one it does not answer.
  const heads = {
    decided: '',
    other: '',
    shifted: '',
    revised: '',
    deleted: '',
    edited: '',
    restored: '',
    renamed: '',
    paired: '',
  }
  let harness: TestContext

  beforeAll(async () => {
    dir = await makeTempDir('pr-review-decisions-')
    await runGit(dir, 'init', '-q', '-b', 'main')
    await runGit(dir, 'config', 'user.email', 'test@example.com')
    await runGit(dir, 'config', 'user.name', 'Test')
    await write(dir, 'src/app.ts', 'a\nb\nc\nd\ne\nf\ng\nh\n')
    await write(dir, 'src/old.ts', 'one\ntwo\nthree\n')
    await write(dir, 'src/moved.ts', MOVED)
    await write(dir, 'src/pair.ts', PAIR)
    await runGit(dir, 'add', '.')
    await runGit(dir, 'commit', '-q', '-m', 'base')
    await runGit(dir, 'checkout', '-q', '-b', 'feature')
    await write(dir, 'src/app.ts', APP)
    heads.decided = await commit(dir, [
      'fix(app): keep E uppercase',
      'Why it stays.',
      `Settled-decision: src/app.ts:5 ${ASKED} ${REASON}`,
      'Co-Authored-By: Claude <noreply@anthropic.com>',
    ])
    await write(dir, 'src/app.ts', APP.replace('b\n', 'B\n'))
    heads.other = await commit(
      dir,
      ['chore: rename b', 'Settled-decision: src/app.ts:2 B is fine as it is'],
      '-c',
      'user.email=other@example.com',
      '-c',
      'user.name=Other'
    )
    await write(dir, 'src/app.ts', `// header\n// more\n${APP.replace('b\n', 'B\n')}`)
    await write(dir, 'src/old.ts', 'zero\none\ntwo\nthree\n')
    heads.shifted = await commit(dir, ['docs: add headers'])
    await write(dir, 'src/app.ts', `// header\n// more\n${APP.replace('b\n', 'B\n').replace('h\n', 'H\n')}`)
    heads.revised = await commit(dir, [
      'fix(app): capitalize h',
      `Settled-decision: src/app.ts:7 ${ASKED} ${REVISED}`,
    ])
    await write(dir, 'src/old.ts', 'zero\none\nthree\n')
    heads.deleted = await commit(dir, [
      'refactor(old): drop two',
      `Settled-decision: src/old.ts:3:old ${KEEP_TWO} ${DROPPED}`,
    ])
    await write(
      dir,
      'src/app.ts',
      `// header\n// more\n${APP.replace('b\n', 'B\n').replace('h\n', 'H\n').replace('E!', 'E?')}`
    )
    heads.edited = await commit(dir, ['fix(app): soften E'])
    await write(dir, 'src/old.ts', 'zero\none\ntwo\nTHREE\n')
    heads.restored = await commit(dir, ['revert(old): bring two back'])
    await runGit(dir, 'mv', 'src/moved.ts', 'src/renamed.ts')
    await commit(dir, ['refactor: rename moved'])
    await write(dir, 'src/renamed.ts', MOVED.replace('line 3\n', ''))
    heads.renamed = await commit(dir, [
      'refactor(renamed): drop line 3',
      `Settled-decision: src/renamed.ts:3:old ${DROPPED}`,
    ])
    await runGit(dir, 'mv', 'src/pair.ts', 'src/paired.ts')
    await write(dir, 'src/paired.ts', PAIR.replace('pair 2\n', ''))
    heads.paired = await commit(dir, [
      'refactor(paired): rename pair and drop line 2',
      [
        `Settled-decision: src/paired.ts:2:old ${KEEP_TWO} ${DROPPED}`,
        `Settled-decision: src/app.ts:4 ${WHY_B} ${B_REASON}`,
        `Settled-decision: src/app.ts:4 ${B_FINAL} ${B_YES}`,
        `Settled-decision: src/app.ts:10 ${UNANSWERED}`,
      ].join('\n'),
    ])
  })
  afterAll(async () => rm(dir, { recursive: true, force: true }))
  beforeEach(async () => {
    harness = await makeTestContext({ git: createGit(dir, execGitAsRepoConfig) })
  })
  afterEach(() => harness.cleanup())

  async function prepared(head: string, force = false) {
    const result = await prepare(
      harness.ctx,
      { kind: 'refs', base: 'main', head },
      { force, log: () => undefined }
    )
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    return { result, context, prompt: await readFile(result.promptPath, 'utf8') }
  }

  /** Prepares and publishes a canvas whose model is the whole diff in one layer, with no point of its own. */
  async function published(head: string, force = false) {
    const { result, context } = await prepared(head, force)
    const derived = await harness.ctx.derived.ensure({ headSha: head, mergeBaseSha: context.mergeBaseSha })
    const model = {
      summary: 'Changes the app.',
      layers: [
        {
          key: 'app',
          title: 'App',
          rationale: 'The whole change.',
          kind: 'layer',
          tests: [],
          files: derived.files.map(file => ({
            path: file.path,
            hunks: file.hunks.map(hunk => hunk.id),
            annotations: [],
          })),
        },
      ],
      points: [],
    }
    await writeFile(path.join(result.canvasDir, 'model.json'), JSON.stringify(model))
    await publish(harness.ctx, result.canvasDir, {
      agent: 'claude',
      harness: 'claude-code',
      allowStale: false,
    })
    const artifact = await harness.ctx.canvases.readArtifact(head)
    if (artifact === null) {
      throw new Error('canvas missing')
    }
    return { context, artifact }
  }

  // A decision point is named by its whole line, the question with the answer.
  const decisionFp = (line: string, file = 'src/app.ts') =>
    fingerprint({ kind: 'decision', path: file, title: line })
  const decidedFp = decisionFp(`${ASKED} ${REASON}`)

  it('reads the decision past a blank line that keeps it apart from the attribution, and lists it', async () => {
    const { context, prompt } = await prepared(heads.decided)
    const id = `${heads.decided.slice(0, 7)}-1`
    expect(context.decisions).toEqual([
      {
        id,
        commit: heads.decided,
        date: expect.any(String),
        question: ASKED,
        text: REASON,
        path: 'src/app.ts',
        side: 'new',
        line: 5,
      },
    ])
    expect(prompt).toContain(`\`${id}\` on \`src/app.ts\` new-side line 5`)
    expect(prompt).toContain('write no point for them')
  })

  it("ignores a decision in someone else's commit on the branch", async () => {
    expect((await prepared(heads.other)).context.decisions.map(decision => decision.text)).toEqual([REASON])
  })

  it('carries a decision past lines added above it, to its line at the head', async () => {
    const { context } = await prepared(heads.shifted)
    expect(context.decisions.map(decision => [decision.text, decision.line])).toEqual([[REASON, 7]])
  })

  it("places a deleted line's decision, numbered as in its commit's parent, on the merge base's line", async () => {
    const { context } = await prepared(heads.deleted)
    expect(
      context.decisions
        .filter(decision => decision.side === 'old')
        .map(decision => [decision.path, decision.line])
    ).toEqual([['src/old.ts', 2]])
  })

  it("keeps a deleted line's decision as context once a later commit restores the line", async () => {
    const { context, artifact } = await published(heads.restored)
    expect(
      context.decisions.filter(decision => decision.side === 'old').map(decision => decision.line)
    ).toEqual([null])
    expect(artifact.points.filter(point => point.decisionCommit !== undefined)).toEqual([])
  })

  it("places a deleted line's decision in a renamed file on the line its old name had at the merge base", async () => {
    const { context } = await prepared(heads.renamed)
    expect(
      context.decisions
        .filter(decision => decision.path === 'src/renamed.ts')
        .map(decision => [decision.side, decision.line])
    ).toEqual([['old', 3]])
  })

  it('keeps a decision whose line changed after the commit as context, and adds no point for it', async () => {
    const { context, artifact } = await published(heads.edited)
    expect(
      context.decisions
        .filter(decision => decision.path === 'src/app.ts')
        .map(decision => [decision.text, decision.line])
    ).toEqual([
      [REASON, null],
      [REVISED, null],
    ])
    // The deleted line's decision asks a question, which titles its point; the answer resolves it.
    const decided = artifact.points.filter(point => point.decisionCommit !== undefined)
    expect(decided.map(point => point.path)).toEqual(['src/old.ts'])
    expect(decided[0]).toMatchObject({ path: 'src/old.ts', side: 'old', title: KEEP_TWO })
    expect(artifact.settled?.[decisionFp(`${KEEP_TWO} ${DROPPED}`, 'src/old.ts')]?.reason).toBe(DROPPED)
  })

  it('adds the decision as a resolved point, and again on the next canvas, which copies none of it', async () => {
    const expected = { reason: REASON, at: expect.any(String), commit: heads.decided }
    const first = await published(heads.decided)
    expect(first.artifact.points.filter(point => point.decisionCommit !== undefined)).toEqual([
      // Origin `model`, so a release that predates settled decisions still opens the canvas.
      expect.objectContaining({
        kind: 'decision',
        level: 'fyi',
        audience: 'author',
        title: ASKED,
        line: 5,
        origin: 'model',
        decisionCommit: heads.decided,
      }),
    ])
    expect(first.artifact.settled).toEqual({ [decidedFp]: expected })

    const second = await published(heads.shifted)
    expect(second.context.basis?.canvasSha).toBe(heads.decided)
    expect(second.context.basis?.points.map(point => point.title)).not.toContain(ASKED)
    expect(
      second.artifact.points.filter(point => point.decisionCommit !== undefined).map(point => point.line)
    ).toEqual([7])
    expect(second.artifact.settled).toEqual({ [decidedFp]: expected })
  })

  it("replaces a decision's reason with a later one on the same line, over the canvas it builds on", async () => {
    await published(heads.decided)
    await published(heads.shifted)
    const { artifact } = await published(heads.revised)
    expect(
      artifact.points.filter(point => point.decisionCommit !== undefined).map(point => point.title)
    ).toEqual([ASKED])
    expect(artifact.settled).toEqual({
      [decisionFp(`${ASKED} ${REVISED}`)]: { reason: REVISED, at: expect.any(String), commit: heads.revised },
    })
  })

  it("keeps the reason the author wrote on the canvas over the commit's when the canvas is generated again", async () => {
    const { artifact } = await published(heads.decided)
    const reworded = { reason: 'Reworded on the canvas.', at: '2026-10-13T12:00:00.000Z' }
    await harness.ctx.canvases.revise(
      heads.decided,
      withSettlement(artifact, decidedFp, reworded, reworded.at)
    )
    const again = await published(heads.decided, true)
    expect(again.artifact.settled).toEqual({ [decidedFp]: reworded })
  })

  it('shows a later answer to the same question over the reason the author wrote on the canvas for the earlier one', async () => {
    const { artifact } = await published(heads.decided)
    const [point] = artifact.points.filter(candidate => candidate.decisionCommit !== undefined)
    const reworded = { reason: 'Reworded on the canvas.', at: '2026-10-13T12:00:00.000Z' }
    await harness.ctx.canvases.revise(
      heads.decided,
      withSettlement(artifact, point!.fingerprint, reworded, reworded.at)
    )
    await published(heads.shifted)
    const { artifact: revised } = await published(heads.revised)
    expect(Object.values(revised.settled ?? {}).map(settlement => settlement.reason)).toEqual([REVISED])
  })

  it("places a deleted line's decision in a file renamed by the same commit, read in its parent under the old name", async () => {
    const { context } = await prepared(heads.paired)
    expect(
      context.decisions
        .filter(decision => decision.path === 'src/paired.ts')
        .map(decision => [decision.side, decision.line])
    ).toEqual([['old', 2]])
  })

  it('makes two questions on one line two resolved points, and keeps a question with no answer as context', async () => {
    const { context, artifact } = await published(heads.paired)
    const onB = artifact.points.filter(point => point.decisionCommit !== undefined && point.line === 4)
    expect(onB.map(point => point.title)).toEqual([WHY_B, B_FINAL])
    expect(onB.map(point => artifact.settled?.[point.fingerprint]?.reason)).toEqual([B_REASON, B_YES])
    // Each point's body carries its answer, so a copy of it does too.
    expect(onB[0]?.body).toMatch(
      new RegExp(
        `^Commit \`${heads.paired.slice(0, 7)}\` answered this on \\d{4}-\\d\\d-\\d\\d: ${B_REASON}$`
      )
    )
    expect(context.decisions.find(decision => decision.question === UNANSWERED)).toMatchObject({
      line: null,
    })
    expect(artifact.points.map(point => point.title)).not.toContain(UNANSWERED)
  })

  it('leaves a decision the author reopened open on later canvases, until a later commit answers it again', async () => {
    const { artifact } = await published(heads.decided)
    const at = '2026-10-13T12:00:00.000Z'
    await harness.ctx.canvases.revise(heads.decided, withSettlement(artifact, decidedFp, undefined, at))
    const shifted = await published(heads.shifted)
    expect(shifted.artifact.points.map(point => point.fingerprint)).toContain(decidedFp)
    expect(shifted.artifact.settled?.[decidedFp]).toBeUndefined()
    expect(shifted.artifact.reopened).toEqual({ [decidedFp]: { commit: heads.decided, at } })

    // The same question answered again by a later commit resolves its point once more.
    const { artifact: revised } = await published(heads.revised)
    expect(revised.reopened).toBeUndefined()
    expect(Object.values(revised.settled ?? {}).map(settlement => settlement.commit)).toEqual([heads.revised])
  })
})
