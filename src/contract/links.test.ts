// @vitest-environment node
import { extractLinks, linkLabel, linkTargetId, parseLink, resolveLink } from './links.js'

const keyFor = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '_')

describe('parseLink', () => {
  it('parses the four link forms', () => {
    expect(parseLink('#layer:auth-session')).toEqual({ kind: 'layer', layerKey: 'auth-session' })
    expect(parseLink('#file:packages/x.ts')).toEqual({ kind: 'file', path: 'packages/x.ts' })
    expect(parseLink('#hunk:packages/x.ts#3')).toEqual({ kind: 'hunk', path: 'packages/x.ts', n: 3 })
    expect(parseLink('#line:packages/x.ts:40')).toEqual({
      kind: 'line',
      path: 'packages/x.ts',
      start: 40,
      end: 40,
      side: 'new',
    })
    expect(parseLink('#line:packages/x.ts:40-52')).toEqual({
      kind: 'line',
      path: 'packages/x.ts',
      start: 40,
      end: 52,
      side: 'new',
    })
    expect(parseLink('#line:packages/x.ts:7:old')).toEqual({
      kind: 'line',
      path: 'packages/x.ts',
      start: 7,
      end: 7,
      side: 'old',
    })
    expect(parseLink('#line:packages/x.ts:7-9:old')).toEqual({
      kind: 'line',
      path: 'packages/x.ts',
      start: 7,
      end: 9,
      side: 'old',
    })
  })

  it('returns null for malformed links', () => {
    expect(parseLink('#layer:')).toBeNull()
    expect(parseLink('#file:')).toBeNull()
    expect(parseLink('#hunk:packages/x.ts')).toBeNull()
    expect(parseLink('#hunk:packages/x.ts#x')).toBeNull()
    expect(parseLink('#line:packages/x.ts')).toBeNull()
    expect(parseLink('#line:packages/x.ts:9-3')).toBeNull()
    expect(parseLink('#line:packages/x.ts:abc')).toBeNull()
    expect(parseLink('https://example.com')).toBeNull()
    expect(parseLink('#overview')).toBeNull()
  })
})

describe('extractLinks', () => {
  it('finds markdown-wrapped and bare links in order', () => {
    const md =
      'See [the mapper](#hunk:packages/x.ts#2) and #layer:auth then\n#line:a/b.ts:3-4:old. Not #overview.'
    expect(extractLinks(md)).toEqual(['#hunk:packages/x.ts#2', '#layer:auth', '#line:a/b.ts:3-4:old'])
  })

  it('returns an empty list when there are no links', () => {
    expect(extractLinks('plain text with a (paren) and a #hash')).toEqual([])
  })
})

describe('resolveLink', () => {
  const hunk = (oldStart: number, oldLines: number, newStart: number, newLines: number) => ({
    oldStart,
    oldLines,
    newStart,
    newLines,
  })
  const targets = {
    layers: [{ key: 'auth' }],
    files: [
      {
        path: 'packages/x.ts',
        hunks: [hunk(1, 4, 1, 5), hunk(10, 3, 11, 4), hunk(30, 0, 32, 2), hunk(50, 2, 54, 0)],
      },
    ],
  }

  it('resolves links that exist', () => {
    expect(resolveLink({ kind: 'layer', layerKey: 'auth' }, targets)).toEqual({ ok: true })
    expect(resolveLink({ kind: 'file', path: 'packages/x.ts' }, targets)).toEqual({ ok: true })
    expect(resolveLink({ kind: 'hunk', path: 'packages/x.ts', n: 4 }, targets)).toEqual({ ok: true })
    expect(
      resolveLink({ kind: 'line', path: 'packages/x.ts', start: 1, end: 2, side: 'new' }, targets)
    ).toEqual({
      ok: true,
    })
    expect(
      resolveLink({ kind: 'line', path: 'packages/x.ts', start: 11, end: 14, side: 'new' }, targets)
    ).toEqual({
      ok: true,
    })
    expect(
      resolveLink({ kind: 'line', path: 'packages/x.ts', start: 50, end: 51, side: 'old' }, targets)
    ).toEqual({
      ok: true,
    })
  })

  it('rejects a line range outside every hunk, across two hunks, or on the wrong side', () => {
    expect(
      resolveLink({ kind: 'line', path: 'packages/x.ts', start: 400, end: 410, side: 'new' }, targets)
    ).toEqual({
      ok: false,
      message:
        'packages/x.ts:400-410 (new) is not inside one chunk of the diff (new-side lines 1-5, 11-14, 32-33, 54)',
    })
    expect(
      resolveLink({ kind: 'line', path: 'packages/x.ts', start: 4, end: 12, side: 'new' }, targets)
    ).toEqual({
      ok: false,
      message:
        'packages/x.ts:4-12 (new) is not inside one chunk of the diff (new-side lines 1-5, 11-14, 32-33, 54)',
    })
    expect(
      resolveLink({ kind: 'line', path: 'packages/x.ts', start: 54, end: 54, side: 'old' }, targets)
    ).toEqual({
      ok: false,
      message:
        'packages/x.ts:54 (old) is not inside one chunk of the diff (old-side lines 1-4, 10-12, 30, 50-51)',
    })
  })

  it('explains what is missing', () => {
    expect(resolveLink({ kind: 'layer', layerKey: 'nope' }, targets)).toEqual({
      ok: false,
      message: 'layer nope does not exist',
    })
    expect(resolveLink({ kind: 'file', path: 'packages/y.ts' }, targets)).toEqual({
      ok: false,
      message: 'packages/y.ts is not in the diff',
    })
    expect(resolveLink({ kind: 'hunk', path: 'packages/x.ts', n: 9 }, targets)).toEqual({
      ok: false,
      message: 'packages/x.ts#9 does not exist (file has 4 chunks)',
    })
    expect(resolveLink({ kind: 'hunk', path: 'packages/x.ts', n: 0 }, targets)).toEqual({
      ok: false,
      message: 'packages/x.ts#0 does not exist (file has 4 chunks)',
    })
  })
})

describe('linkTargetId and linkLabel', () => {
  it('builds the DOM ids the renderer emits', () => {
    expect(linkTargetId({ kind: 'layer', layerKey: 'auth' }, keyFor)).toBe('layer-auth')
    expect(linkTargetId({ kind: 'file', path: 'a/b.ts' }, keyFor)).toBe('file-a_b_ts')
    expect(linkTargetId({ kind: 'hunk', path: 'a/b.ts', n: 2 }, keyFor)).toBe('hunk-a_b_ts-2')
    expect(linkTargetId({ kind: 'line', path: 'a/b.ts', start: 5, end: 9, side: 'old' }, keyFor)).toBe(
      'L-a_b_ts-old-5'
    )
  })

  it('labels links for text that had none', () => {
    expect(linkLabel({ kind: 'layer', layerKey: 'auth' })).toBe('auth')
    expect(linkLabel({ kind: 'file', path: 'a/b.ts' })).toBe('a/b.ts')
    expect(linkLabel({ kind: 'hunk', path: 'a/b.ts', n: 2 })).toBe('a/b.ts chunk 2')
    expect(linkLabel({ kind: 'line', path: 'a/b.ts', start: 5, end: 5, side: 'new' })).toBe('a/b.ts:5')
    expect(linkLabel({ kind: 'line', path: 'a/b.ts', start: 5, end: 9, side: 'old' })).toBe(
      'a/b.ts:5-9 (old)'
    )
  })
})
