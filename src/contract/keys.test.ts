// @vitest-environment node
import {
  buildLineId,
  fileAnchorId,
  hunkAnchorId,
  hunkId,
  layerAnchorId,
  parseHunkId,
  parseLineId,
  pointAnchorId,
  sanitizeKey,
  uniqueKey,
} from './keys.js'

describe('keys', () => {
  it('sanitizes a path into a key the way the prior-art collector did', () => {
    expect(sanitizeKey('apps/shl-server/src/__tests__/app.test.ts')).toBe('apps_shl_server_src___tests___app_test_ts')
    expect(sanitizeKey('.env.example')).toBe('_env_example')
  })

  it('suffixes colliding keys', () => {
    const used = new Set<string>()
    expect(uniqueKey('a_b_ts', used)).toBe('a_b_ts')
    expect(uniqueKey('a_b_ts', used)).toBe('a_b_ts_2')
    expect(uniqueKey('a_b_ts', used)).toBe('a_b_ts_3')
    expect([...used]).toEqual(['a_b_ts', 'a_b_ts_2', 'a_b_ts_3'])
  })

  it('round-trips hunk ids', () => {
    expect(hunkId('a_b_ts', 3)).toBe('a_b_ts#3')
    expect(parseHunkId('a_b_ts#3')).toEqual({ key: 'a_b_ts', n: 3 })
    expect(parseHunkId('a_b_ts')).toBeNull()
    expect(parseHunkId('#3')).toBeNull()
  })

  it('round-trips line ids on both sides', () => {
    expect(buildLineId('a_b_ts', 'new', 12)).toBe('L-a_b_ts-new-12')
    expect(parseLineId('L-a_b_ts-new-12')).toEqual({ key: 'a_b_ts', side: 'new', line: 12 })
    expect(parseLineId('L-a_b_ts-old-7')).toEqual({ key: 'a_b_ts', side: 'old', line: 7 })
    expect(parseLineId('L-a_b_ts-mid-7')).toBeNull()
    expect(parseLineId('nope')).toBeNull()
  })

  it('builds the other anchor ids', () => {
    expect(fileAnchorId('a_b_ts')).toBe('file-a_b_ts')
    expect(hunkAnchorId('a_b_ts', 2)).toBe('hunk-a_b_ts-2')
    expect(layerAnchorId('auth')).toBe('layer-auth')
    expect(pointAnchorId('p-1')).toBe('point-p-1')
  })
})
