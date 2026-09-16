// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { splitFences } from './fences.js'
import {
  PROPOSED_BODY_MAX,
  parseProposedComment,
  splitChatAnswer,
  targetsFromFiles,
} from './proposed-comment.js'

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
