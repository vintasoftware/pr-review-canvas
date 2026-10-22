import type { FileEntry } from '../contract/review-artifact.js'
import { SETTLEMENT_REASON_MAX } from '../contract/review-artifact.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
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

  it('reads a question up to its first `?` that a space follows, and the answer after it', () => {
    expect(
      parseSettledDecision('src/retry.ts:14 Should retries add jitter? No: one worker calls it')
    ).toEqual({
      path: 'src/retry.ts',
      line: 14,
      side: 'new',
      question: 'Should retries add jitter?',
      text: 'No: one worker calls it',
    })
    expect(parseSettledDecision('src/a.ts:3:old Keep it?  Yes? Mostly.')).toMatchObject({
      side: 'old',
      question: 'Keep it?',
      text: 'Yes? Mostly.',
    })
    // A `?` inside a word or a URL starts no answer.
    expect(parseSettledDecision('src/a.ts:3 keep it; see https://x.test/?q=1 for why')).toEqual({
      path: 'src/a.ts',
      line: 3,
      side: 'new',
      text: 'keep it; see https://x.test/?q=1 for why',
    })
    // Nor does one inside quoted code, while a code span inside the question stays in it.
    expect(parseSettledDecision('src/a.ts:3 Should `x ?? 0` stay? Yes: x may be null')).toMatchObject({
      question: 'Should `x ?? 0` stay?',
      text: 'Yes: x may be null',
    })
    expect(parseSettledDecision('src/a.ts:3 keep `a ? b : c` as it reads')).not.toHaveProperty('question')
    expect(parseSettledDecision('src/a.ts:3 Keep it? Yes, see `x')).toMatchObject({
      question: 'Keep it?',
      text: 'Yes, see `x',
    })
  })

  it('reads a line that ends with its question as a question with no answer', () => {
    expect(parseSettledDecision('src/app.ts:9 Is this the answer?')).toEqual({
      path: 'src/app.ts',
      line: 9,
      side: 'new',
      question: 'Is this the answer?',
    })
    expect(parseSettledDecision('src/a.ts:3 Should `x ?? 0` stay?')).not.toHaveProperty('text')
  })

  it('reads a colon after the line number and a leading `./` as part of the anchor', () => {
    expect(parseSettledDecision('./src/app.ts:2: keep the import')).toEqual({
      path: 'src/app.ts',
      line: 2,
      side: 'new',
      text: 'keep the import',
    })
    expect(parseSettledDecision('src/gone.ts:1:old: dropped')).toMatchObject({ side: 'old', text: 'dropped' })
  })

  it.each([
    'no anchor here',
    './:3 a path of nothing but its prefix',
    'src/app.ts:x keep it',
    'src/app.ts:0 keep it',
    'src/app.ts:2',
    '',
  ])('reads %j as no decision', value => {
    expect(parseSettledDecision(value)).toBeNull()
  })
})

describe('readSettledDecisions', () => {
  // The head's version, and the same version at an earlier commit.
  const BOTH = { [`${EARLIER}:src/app.ts`]: APP_AT_HEAD, [`${HEAD_SHA}:src/app.ts`]: APP_AT_HEAD }
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
      patches: toPatchMap(SYNTHETIC_FILES),
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

  it('keeps an old-side decision only on a line the diff deletes, not on a context row', async () => {
    const atBase = "import { a } from './a'\nexport function run() {\n  return a()\n}\n"
    const { decisions } = read(
      [commit(EARLIER, ['src/app.ts:3:old the bare call goes', 'src/app.ts:2:old run is not deleted'])],
      { blobs: { [`${EARLIER}^:src/app.ts`]: atBase, [`${BASE_SHA}:src/app.ts`]: atBase } }
    )
    expect((await decisions).map(decision => [decision.text, decision.line])).toEqual([
      ['the bare call goes', 3],
      ['run is not deleted', null],
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

  it('keeps two questions on one line, and lets a later answer to the same question stand', async () => {
    const { decisions } = read(
      [
        commit(EARLIER, ['src/app.ts:2 Keep a? Yes: run needs it', 'src/app.ts:2 Keep b? Yes: run sums it']),
        commit(HEAD_SHA, ['src/app.ts:2 keep  B? No: drop it next']),
      ],
      { blobs: BOTH }
    )
    expect((await decisions).map(decision => [decision.question, decision.text, decision.line])).toEqual([
      ['Keep a?', 'Yes: run needs it', 2],
      ['keep  B?', 'No: drop it next', 2],
    ])
  })

  it('keeps a question with no answer as context, until a later line answers it', async () => {
    const asked = read([commit(HEAD_SHA, ['src/app.ts:2 Is this the answer?'])])
    expect(await asked.decisions).toEqual([
      expect.objectContaining({ question: 'Is this the answer?', line: null }),
    ])
    expect((await asked.decisions)[0]).not.toHaveProperty('text')
    const answered = read(
      [
        commit(EARLIER, ['src/app.ts:2 Is this the answer?']),
        commit(HEAD_SHA, ['src/app.ts:2 Is this the answer? Yes: it sums']),
      ],
      { blobs: BOTH }
    )
    expect((await answered.decisions).map(decision => [decision.text, decision.line])).toEqual([
      ['Yes: it sums', 2],
    ])
  })

  it('keeps the question apart from the answer, and cuts either one longer than a settlement may be', async () => {
    const long = 'x'.repeat(SETTLEMENT_REASON_MAX + 50)
    const { decisions } = read([
      commit(HEAD_SHA, [`src/app.ts:2 ${long}`, `src/app.ts:4 Why ${long}? Because.`]),
    ])
    const [plain, asked] = await decisions
    expect(plain?.text).toHaveLength(SETTLEMENT_REASON_MAX)
    expect(plain?.text?.endsWith('…')).toBe(true)
    expect(plain).not.toHaveProperty('question')
    expect(asked?.question).toHaveLength(SETTLEMENT_REASON_MAX)
    expect(asked?.text).toBe('Because.')
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
