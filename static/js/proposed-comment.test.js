// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { splitFences } from './fences.js'
import {
  PROPOSED_BODY_MAX,
  parseProposedComment,
  pointRef,
  proposalFingerprint,
  splitChatAnswer,
  targetsFromFiles,
} from './proposed-comment.js'

describe('proposalFingerprint', () => {
  const original = {
    path: 'src/app.ts',
    line: 4,
    side: /** @type {const} */ ('new'),
    body: 'Check this.\nNext line.',
  }

  it('normalizes line endings, trailing whitespace and single-line ranges', () => {
    expect(proposalFingerprint({ ...original, startLine: 4, body: 'Check this.\r\nNext line.\n' })).toBe(
      proposalFingerprint(original)
    )
  })

  it.each([
    { path: 'src/other.ts' },
    { line: 5 },
    { startLine: 3 },
    { side: /** @type {const} */ ('old') },
    { body: 'Different advice.' },
  ])('distinguishes a changed part of the original proposal: %j', change => {
    expect(proposalFingerprint({ ...original, ...change })).not.toBe(proposalFingerprint(original))
  })
})

/** @type {ReadonlyArray<import('./contract-types.js').FileEntry>} */
const FILES = [
  {
    path: 'src/app.ts',
    key: 'src_app_ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    hunks: [
      { id: 'src_app_ts#1', header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 },
      {
        id: 'src_app_ts#2',
        header: '@@ -10,3 +11,4 @@',
        oldStart: 10,
        oldLines: 3,
        newStart: 11,
        newLines: 4,
      },
    ],
  },
]
const targets = targetsFromFiles(FILES)

const block = (/** @type {unknown} */ value) =>
  `Here is what I would say.\n\n\`\`\`comment\n${JSON.stringify(value)}\n\`\`\`\n`

describe('parseProposedComment', () => {
  it('reads a block that names a line of the diff', () => {
    expect(
      parseProposedComment(JSON.stringify({ path: 'src/app.ts', line: 3, body: 'Rename this.' }), targets)
    ).toEqual({ comment: { path: 'src/app.ts', line: 3, side: 'new', body: 'Rename this.' } })
  })

  it('keeps a range and the old side when the block names them', () => {
    expect(
      parseProposedComment(
        JSON.stringify({ path: 'src/app.ts', line: 3, startLine: 2, side: 'old', body: 'x' }),
        targets
      )
    ).toEqual({ comment: { path: 'src/app.ts', line: 3, side: 'old', startLine: 2, body: 'x' } })
  })

  it('refuses a block that is not a JSON object', () => {
    expect(parseProposedComment('not json')).toEqual({ reason: 'the block is not JSON' })
    expect(parseProposedComment('[1,2]')).toEqual({ reason: 'the block is not a JSON object' })
    expect(parseProposedComment('"text"')).toEqual({ reason: 'the block is not a JSON object' })
  })

  it('refuses a block missing anything the post needs', () => {
    const cases = [
      [{ line: 3, body: 'x' }, 'the block has no path'],
      [{ path: 'src/app.ts', body: 'x' }, 'the block has no line number'],
      [{ path: 'src/app.ts', line: 0, body: 'x' }, 'the block has no line number'],
      [{ path: 'src/app.ts', line: 3 }, 'the block has no body'],
      [{ path: 'src/app.ts', line: 3, body: '  ' }, 'the block has no body'],
      [
        { path: 'src/app.ts', line: 3, body: 'x'.repeat(PROPOSED_BODY_MAX + 1) },
        'the body is too long to post',
      ],
      [{ path: 'src/app.ts', line: 3, body: 'x', side: 'middle' }, 'side must be "new" or "old"'],
      [{ path: 'src/app.ts', line: 3, body: 'x', startLine: 'two' }, 'startLine must be a line number'],
      [{ path: 'src/app.ts', line: 3, body: 'x', startLine: 4 }, 'startLine comes after line'],
    ]
    for (const [value, reason] of cases) {
      expect(parseProposedComment(JSON.stringify(value))).toEqual({ reason })
    }
  })

  it('refuses a target the pull request does not have', () => {
    expect(parseProposedComment(JSON.stringify({ path: 'other.ts', line: 3, body: 'x' }), targets)).toEqual({
      reason: 'other.ts is not a file of this pull request',
    })
    expect(
      parseProposedComment(JSON.stringify({ path: 'src/app.ts', line: 900, body: 'x' }), targets)
    ).toEqual({
      reason: 'src/app.ts:900 is not a line the diff shows',
    })
  })
})

describe('the attention point a comment names', () => {
  const points = [
    { fingerprint: 'b3504e80c8807cbe1a024f6d291a913352d8e253', title: 'One engine decides Save' },
    { fingerprint: '87bcc68b0656fc8259d85f4b99bab4bbd3831fb9', title: 'Lookups match text' },
    // Two points that share the start of their fingerprints: the short name names neither.
    { fingerprint: 'aaaaaaaa11111111111111111111111111111111', title: 'First twin' },
    { fingerprint: 'aaaaaaaa22222222222222222222222222222222', title: 'Second twin' },
  ]
  const withPoints = targetsFromFiles(FILES, points)
  /** @param {unknown} point */
  const parse = point =>
    parseProposedComment(JSON.stringify({ path: 'src/app.ts', line: 3, body: 'Cap it.', point }), withPoints)

  it('names a point by the start of its fingerprint', () => {
    expect(pointRef(points[0]?.fingerprint ?? '')).toBe('b3504e80')
    expect(parse('b3504e80')).toEqual({
      comment: {
        path: 'src/app.ts',
        line: 3,
        side: 'new',
        body: 'Cap it.',
        point: { fingerprint: points[0]?.fingerprint, title: 'One engine decides Save' },
      },
    })
  })

  it.each([
    ['a point the canvas does not have', 'deadbeef'],
    ['a name two points share', 'aaaaaaaa'],
    ['a value that is not a string', 3],
  ])('links nothing for %s, and keeps the comment', (_why, point) => {
    expect(parse(point)).toEqual({ comment: { path: 'src/app.ts', line: 3, side: 'new', body: 'Cap it.' } })
  })

  it('links nothing where the page gave no points', () => {
    expect(
      parseProposedComment(
        JSON.stringify({ path: 'src/app.ts', line: 3, body: 'x', point: 'b3504e80' }),
        targets
      )
    ).toEqual({ comment: { path: 'src/app.ts', line: 3, side: 'new', body: 'x' } })
  })
})

describe('targetsFromFiles', () => {
  it('knows the lines each hunk shows, per side', () => {
    expect(targets.hasPath('src/app.ts')).toBe(true)
    expect(targets.hasPath('nope.ts')).toBe(false)
    expect(targets.hasLine('src/app.ts', 'new', 5)).toBe(true)
    expect(targets.hasLine('src/app.ts', 'new', 6)).toBe(false)
    expect(targets.hasLine('src/app.ts', 'old', 4)).toBe(true)
    expect(targets.hasLine('nope.ts', 'new', 1)).toBe(false)
  })
})

describe('splitChatAnswer', () => {
  it('splits an answer into its prose and its comment card', () => {
    const segments = splitChatAnswer(block({ path: 'src/app.ts', line: 3, body: 'Rename this.' }), targets)
    // The text after the closing fence is its own piece of prose, empty here.
    expect(segments.map(s => s.type)).toEqual(['markdown', 'comment', 'markdown'])
    expect(segments[0]).toMatchObject({ text: expect.stringContaining('Here is what I would say.') })
    expect(segments[1]).toMatchObject({ comment: { path: 'src/app.ts', line: 3 } })
  })

  it('keeps a block that is not a usable comment as a block, with the reason', () => {
    const segments = splitChatAnswer(block({ path: 'nope.ts', line: 1, body: 'x' }), targets)
    expect(segments[1]).toMatchObject({
      type: 'invalid',
      reason: 'nope.ts is not a file of this pull request',
    })
  })

  it('leaves an answer with no comment block as one piece of prose', () => {
    expect(splitChatAnswer('Yes. Covered at `src/app.ts:3`.', targets)).toEqual([
      { type: 'markdown', text: 'Yes. Covered at `src/app.ts:3`.' },
    ])
  })
})

describe('splitFences', () => {
  it('picks out only the fences with the info string it was asked for', () => {
    const text = '```js\ncode\n```\n\n```comment\n{}\n```\n'
    expect(splitFences(text, 'comment')).toEqual([
      { type: 'markdown', text: '```js\ncode\n```\n' },
      { type: 'block', text: '{}' },
      { type: 'markdown', text: '' },
    ])
  })

  it('reads a tilde fence and a longer backtick fence', () => {
    expect(splitFences('~~~comment\n{}\n~~~\n', 'comment')[0]).toEqual({ type: 'block', text: '{}' })
    expect(splitFences('````comment\n```\n````\n', 'comment')[0]).toEqual({ type: 'block', text: '```' })
  })

  it('leaves an unclosed block as prose, its opening line included', () => {
    expect(splitFences('```comment\n{}\n', 'comment')).toEqual([
      { type: 'markdown', text: '```comment\n{}\n' },
    ])
  })

  it('reads CRLF text the same as LF text', () => {
    expect(splitFences('a\r\n```comment\r\n{}\r\n```\r\n', 'comment')[1]).toEqual({
      type: 'block',
      text: '{}',
    })
  })

  it('does not read inline code as a fence', () => {
    expect(splitFences('a ```comment``` b', 'comment')).toEqual([
      { type: 'markdown', text: 'a ```comment``` b' },
    ])
  })
})

describe('the target checks at the edges', () => {
  it('refuses a range whose first line is outside the diff', () => {
    expect(
      parseProposedComment(JSON.stringify({ path: 'src/app.ts', line: 3, startLine: 1, body: 'x' }), targets)
    ).toEqual({ comment: { path: 'src/app.ts', line: 3, side: 'new', startLine: 1, body: 'x' } })
    expect(
      parseProposedComment(JSON.stringify({ path: 'src/app.ts', line: 12, startLine: 6, body: 'x' }), targets)
    ).toEqual({ reason: 'src/app.ts:6 is not a line the diff shows' })
  })

  it('shows no lines on a side a hunk does not touch', () => {
    const added = targetsFromFiles([
      {
        path: 'src/new.ts',
        key: 'src_new_ts',
        status: 'added',
        additions: 2,
        deletions: 0,
        hunks: [
          {
            id: 'src_new_ts#1',
            header: '@@ -0,0 +1,2 @@',
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
          },
        ],
      },
    ])
    expect(added.hasLine('src/new.ts', 'new', 1)).toBe(true)
    expect(added.hasLine('src/new.ts', 'old', 0)).toBe(false)
  })
})
