// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ChatContext } from '../contract/chat.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import {
  ChatContextError,
  type ContextSources,
  enclosingHunk,
  INLINE_PATCH_MAX_LINES,
  renderChatContext,
} from './context.js'

const artifact = syntheticArtifact()
const files = SYNTHETIC_FILES.map(toFileEntry)
const patches = toPatchMap(SYNTHETIC_FILES)

function sources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    artifact,
    files,
    patches,
    readLines: async (_side, _path, from, to) =>
      Array.from({ length: to - from + 1 }, (_v, i) => `line ${from + i}`),
    ...overrides,
  }
}

describe('renderChatContext', () => {
  it('says so plainly when the reader is asking about the whole pull request', async () => {
    expect(await renderChatContext({ kind: 'pr' }, sources())).toBe(
      '## Context: the whole pull request\n\nThe reader is asking about the pull request as a whole.'
    )
  })

  it('gives a layer its title, its rationale, and its files', async () => {
    const block = await renderChatContext({ kind: 'layer', layerId: 'run-path' }, sources())
    expect(block).toContain('## Context: layer · Run path')
    expect(block).toContain('The change to `run()` and its test.')
    expect(block).toContain('- `src/app.ts` (src_app_ts#1)')
    expect(block).toContain('- `src/app.test.ts`')
  })

  it('inlines a short patch and points at the materialized file for a long one', async () => {
    const short = await renderChatContext({ kind: 'file', path: 'src/app.ts' }, sources())
    expect(short).toContain('## Context: `src/app.ts`')
    expect(short).toContain('modified, +3 −1')
    expect(short).toContain('```diff')
    expect(short).toContain('+  return a() + b()')

    const long = await renderChatContext(
      { kind: 'file', path: 'src/app.ts' },
      sources({ patches: { ...patches, src_app_ts: 'x\n'.repeat(INLINE_PATCH_MAX_LINES + 1) } })
    )
    expect(long).toContain('too long to inline')
    expect(long).not.toContain('```diff')
  })

  it('treats a file with no patch as one to read rather than to quote', async () => {
    const block = await renderChatContext({ kind: 'file', path: 'assets/logo.png' }, sources())
    expect(block).toContain('too long to inline')
  })

  it('quotes the exact lines of a selection and names the hunk around them', async () => {
    const block = await renderChatContext(
      { kind: 'lines', path: 'src/app.ts', side: 'new', start: 2, end: 4 },
      sources()
    )
    expect(block).toContain('## Context: src/app.ts lines 2–4')
    expect(block).toContain('2: line 2')
    expect(block).toContain('4: line 4')
    expect(block).toContain('The hunk around them is `src_app_ts#1`')
  })

  it('names the old side in the label and reads the base file', async () => {
    const sides: string[] = []
    const block = await renderChatContext(
      { kind: 'lines', path: 'src/app.ts', side: 'old', start: 2, end: 2 },
      sources({
        readLines: async side => {
          sides.push(side)
          return ['old line']
        },
      })
    )
    expect(sides).toEqual(['base'])
    expect(block).toContain('src/app.ts line 2 (old side)')
  })

  it('says when the lines are not on this machine', async () => {
    const block = await renderChatContext(
      { kind: 'lines', path: 'src/app.ts', side: 'new', start: 2, end: 2 },
      sources({ readLines: async () => null })
    )
    expect(block).toContain('not available locally')
  })

  it('refuses a layer, a path, or a range the canvas does not have', async () => {
    const cases: Array<[ChatContext, RegExp]> = [
      [{ kind: 'layer', layerId: 'layer-9' }, /no layer layer-9/],
      [{ kind: 'file', path: '../../etc/passwd' }, /not a file of this pull request/],
      [{ kind: 'lines', path: 'nope.ts', side: 'new', start: 1, end: 2 }, /not a file of this pull request/],
      [{ kind: 'lines', path: 'src/app.ts', side: 'new', start: 9, end: 2 }, /comes after the first/],
      [{ kind: 'lines', path: 'src/app.ts', side: 'new', start: 1, end: 5000 }, /at most 400 lines/],
    ]
    for (const [context, message] of cases) {
      await expect(renderChatContext(context, sources())).rejects.toThrow(message)
    }
    await expect(renderChatContext({ kind: 'layer', layerId: 'x' }, sources())).rejects.toBeInstanceOf(
      ChatContextError
    )
  })

  it('gives an attention point its text, its kind and level, and the lines it sits on', async () => {
    const block = await renderChatContext({ kind: 'point', fingerprint: 'fp-1' }, sources())
    expect(block).toBe(
      [
        '## Context: attention point — Sum instead of product',
        '',
        'decision · decide',
        '',
        'Look at the operator because the spec is ambiguous; if the spec says sum, this is fine.',
        '',
        'It sits on src/app.ts line 4:',
        '',
        '```\n4: line 4\n```',
        '',
        'The hunk around them is `src_app_ts#1` (`@@ -1,4 +1,5 @@`).',
      ].join('\n')
    )
    // One context, one heading: the lines come in without a heading of their own.
    expect(block.match(/^## Context:/gm)).toHaveLength(1)
  })

  it('refuses an attention point the canvas does not have', async () => {
    await expect(renderChatContext({ kind: 'point', fingerprint: 'fp-nope' }, sources())).rejects.toThrow(
      /no such attention point/
    )
  })

  it('leaves out the hunk line when the selection sits outside every hunk', async () => {
    const block = await renderChatContext(
      { kind: 'lines', path: 'src/app.ts', side: 'new', start: 400, end: 400 },
      sources()
    )
    expect(block).not.toContain('The hunk around them')
  })
})

describe('enclosingHunk', () => {
  it('finds the hunk a line sits in, per side', () => {
    const entry = files.find(f => f.path === 'src/app.ts')
    if (entry === undefined) {
      throw new Error('fixture changed')
    }
    expect(enclosingHunk(entry, 'new', 3)?.id).toBe('src_app_ts#1')
    expect(enclosingHunk(entry, 'new', 12)?.id).toBe('src_app_ts#2')
    expect(enclosingHunk(entry, 'old', 1)?.id).toBe('src_app_ts#1')
    expect(enclosingHunk(entry, 'new', 900)).toBeUndefined()
  })
})
