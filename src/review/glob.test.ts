// @vitest-environment node
import { globToRegExp, matchesGlob } from './glob.js'

describe('matchesGlob', () => {
  it('crosses directories with ** and stays in one segment with * and ?', () => {
    expect(matchesGlob('**/prisma/migrations/**', 'apps/shl/prisma/migrations/2026_x/migration.sql')).toBe(
      true
    )
    expect(matchesGlob('**/prisma/migrations/**', 'prisma/migrations/a.sql')).toBe(true)
    expect(matchesGlob('**/prisma/migrations/**', 'apps/shl/prisma/schema.prisma')).toBe(false)
    expect(matchesGlob('**/*auth*.ts', 'packages/x/src/service-auth.ts')).toBe(true)
    expect(matchesGlob('**/*auth*.ts', 'auth.ts')).toBe(true)
    expect(matchesGlob('**/*auth*.ts', 'packages/auth/index.ts')).toBe(false)
    expect(matchesGlob('data/access-policy/**', 'data/access-policy/patient.json')).toBe(true)
    expect(matchesGlob('data/access-policy/**', 'x/data/access-policy/patient.json')).toBe(false)
    expect(matchesGlob('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('src/*.ts', 'src/dir/a.ts')).toBe(false)
    expect(matchesGlob('src/?.ts', 'src/a.ts')).toBe(true)
    expect(matchesGlob('src/?.ts', 'src/ab.ts')).toBe(false)
    expect(matchesGlob('a.b', 'aXb')).toBe(false)
    expect(matchesGlob('pnpm-lock.yaml', 'pnpm-lock.yaml')).toBe(true)
    expect(matchesGlob('**', 'anything/at/all')).toBe(true)
    expect(matchesGlob('src/**', 'src')).toBe(false)
  })

  it('escapes regex characters in literal parts', () => {
    expect(globToRegExp('a+b(c).ts').source).toBe('^a\\+b\\(c\\)\\.ts$')
  })
})
