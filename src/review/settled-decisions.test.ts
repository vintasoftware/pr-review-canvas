import type { FileEntry } from '../contract/review-artifact.js'
import { SETTLEMENT_REASON_MAX } from '../contract/review-artifact.js'
import { toFileEntry } from '../git/diff-collector.js'
import type { CommitKeyedLines } from '../git/git.js'
import { createFakeGit } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA, SYNTHETIC_FILES } from '../testing/synthetic.js'
import { MAX_DECISION_POINTS, parseSettledDecision, readSettledDecisions } from './settled-decisions.js'

const FILES = SYNTHETIC_FILES.map(toFileEntry)
const EARLIER = 'c'.repeat(40)
const APP_AT_HEAD =
  "import { a } from './a'\nimport { b } from './b'\nexport function run() {\n  return a() + b()\n}\n"

describe('parseSettledDecision', () => {
  it('reads a path, a line, an optional old side, and the text', () => {
    expect(parseSettledDecision('src/app.ts:2 keep the import')).toEqual({
      path: 'src/app.ts',
      line: 2,
      side: 'new',
      text: 'keep the import',
    })
    expect(parseSettledDecision('  src/gone.ts:1:old   dropped on purpose  ')).toEqual({
      path: 'src/gone.ts',
      line: 1,
      side: 'old',
      text: 'dropped on purpose',
    })
  })

  it.each(['no anchor here', 'src/app.ts:x keep it', 'src/app.ts:0 keep it', 'src/app.ts:2', ''])(
    'reads %j as no decision',
    value => {
      expect(parseSettledDecision(value)).toBeNull()
    }
  )
})

describe('readSettledDecisions', () => {
  const commit = (sha: string, values: string[], authorEmail = 'Author@Example.com'): CommitKeyedLines => ({
    sha,
    authorEmail,
    date: '2026-10-13T10:00:00-03:00',
    values,
  })

  function read(
    commits: CommitKeyedLines[],
    opts: { email?: string | null; blobs?: Record<string, string>; files?: readonly FileEntry[] } = {}
  ) {
    const git = createFakeGit({
      keyedLines: { [`${BASE_SHA}..${HEAD_SHA}`]: commits },
      blobs: opts.blobs ?? { [`${HEAD_SHA}:src/app.ts`]: APP_AT_HEAD },
    })
    const decisions = readSettledDecisions({
      git,
      mergeBaseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: opts.files ?? FILES,
      authorEmail: opts.email === undefined ? 'author@example.com' : opts.email,
    })
    return { git, decisions }
  }

  it('reads nothing, and asks git nothing, when nobody is known to be the author', async () => {
    const { git, decisions } = read([commit(HEAD_SHA, ['src/app.ts:2 keep it'])], { email: null })
    expect(await decisions).toEqual([])
    expect(git.calls).toEqual([])
  })

  it("keeps the author's decisions, whatever the case of the address, and drops everyone else's", async () => {
    const { decisions } = read([
      commit(HEAD_SHA, ['src/app.ts:2 keep the import']),
      commit(HEAD_SHA, ['src/app.ts:4 another view'], 'someone@example.com'),
    ])
    expect(await decisions).toEqual([
      {
        id: `${HEAD_SHA.slice(0, 7)}-1`,
        commit: HEAD_SHA,
        date: '2026-10-13T10:00:00-03:00',
        text: 'keep the import',
        path: 'src/app.ts',
        side: 'new',
        line: 2,
      },
    ])
  })

  it('keeps a decision outside a chunk, outside the diff, or in a file it cannot read as context', async () => {
    const { decisions } = read([
      commit(HEAD_SHA, [
        'src/app.ts:2 in a chunk',
        'src/app.ts:8 between chunks',
        'README.md:1 not in the diff',
      ]),
      commit(HEAD_SHA, ['src/new.ts:1 unreadable']),
    ])
    expect((await decisions).map(decision => [decision.text, decision.line])).toEqual([
      ['in a chunk', 2],
      ['between chunks', null],
      ['not in the diff', null],
      ['unreadable', null],
    ])
  })

  it("carries a new-side line from its commit's version to the head, and loses one that changed", async () => {
    const atEarlier = "import { a } from './a'\nexport function run() {\n  return a()\n}\n"
    const { decisions } = read(
      [commit(EARLIER, ['src/app.ts:2 run stays exported', 'src/app.ts:3 the sum'])],
      {
        blobs: { [`${EARLIER}:src/app.ts`]: atEarlier, [`${HEAD_SHA}:src/app.ts`]: APP_AT_HEAD },
      }
    )
    expect((await decisions).map(decision => [decision.id, decision.line])).toEqual([
      [`${EARLIER.slice(0, 7)}-1`, 3],
      [`${EARLIER.slice(0, 7)}-2`, null],
    ])
  })

  it("carries an old-side line from the commit's parent to the merge base", async () => {
    // The commit's parent had one more line above the one it deleted than the merge base has.
    const { git, decisions } = read([commit(EARLIER, ['src/gone.ts:2:old dropped on purpose'])], {
      blobs: {
        [`${EARLIER}^:src/gone.ts`]: '// added first\nexport const old = 1\n// bye',
        [`${BASE_SHA}:src/gone.ts`]: 'export const old = 1\n// bye',
      },
    })
    expect((await decisions).map(decision => [decision.side, decision.line])).toEqual([['old', 1]])
    expect(git.calls.filter(call => call[0] === 'show')).toEqual([
      ['show', `${EARLIER}^:src/gone.ts`],
      ['show', `${BASE_SHA}:src/gone.ts`],
    ])
  })

  it('skips a value that is not a decision, and lets a later decision on the same line stand', async () => {
    const { decisions } = read([
      commit(HEAD_SHA, ['not a decision', 'src/app.ts:2 first answer']),
      commit(HEAD_SHA, ['src/app.ts:2 second answer']),
    ])
    expect((await decisions).map(decision => [decision.id, decision.text])).toEqual([
      [`${HEAD_SHA.slice(0, 7)}-1`, 'second answer'],
    ])
  })

  it('cuts a reason longer than a settlement may be', async () => {
    const { decisions } = read([commit(HEAD_SHA, [`src/app.ts:2 ${'x'.repeat(SETTLEMENT_REASON_MAX + 50)}`])])
    const [only] = await decisions
    expect(only?.text).toHaveLength(SETTLEMENT_REASON_MAX)
    expect(only?.text.endsWith('…')).toBe(true)
  })

  it('keeps the oldest decisions past the point budget as context', async () => {
    const lines = MAX_DECISION_POINTS + 2
    const big: FileEntry = {
      path: 'big.ts',
      key: 'big_ts',
      status: 'added',
      additions: lines,
      deletions: 0,
      hunks: [
        {
          id: 'big_ts#1',
          header: `@@ -0,0 +1,${lines} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: lines,
        },
      ],
    }
    const values = Array.from({ length: lines }, (_, i) => `big.ts:${i + 1} decision ${i + 1}`)
    const { decisions } = read([commit(HEAD_SHA, values)], {
      files: [big],
      blobs: { [`${HEAD_SHA}:big.ts`]: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') },
    })
    const lineOf = (await decisions).map(decision => decision.line)
    expect(lineOf.slice(0, 2)).toEqual([null, null])
    expect(lineOf.slice(2)).toEqual(Array.from({ length: MAX_DECISION_POINTS }, (_, i) => i + 3))
  })
})
