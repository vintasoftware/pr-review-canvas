// @ts-check
// @vitest-environment node
import { LANG_BY_EXT, langForPath } from './lang.js'

describe('langForPath', () => {
  it('maps extensions case-insensitively and leaves unknown ones undefined', () => {
    expect(langForPath('a/b.ts')).toBe('typescript')
    expect(langForPath('a/B.JSON')).toBe('json')
    expect(langForPath('schema.prisma')).toBe('prisma')
    expect(langForPath('Makefile')).toBeUndefined()
    expect(langForPath('x.unknownext')).toBeUndefined()
    expect(LANG_BY_EXT).toMatchObject({ yml: 'yaml' })
  })
})
