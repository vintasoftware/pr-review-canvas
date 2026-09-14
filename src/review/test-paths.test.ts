// @vitest-environment node
import { coveredStem, DEFAULT_TEST_PATTERNS, isTestPath, sourceStem } from './test-paths.js'

describe('test paths', () => {
  it('recognizes test files by name and folder', () => {
    expect(isTestPath('src/a.test.ts')).toBe(true)
    expect(isTestPath('src/a.spec.tsx')).toBe(true)
    expect(isTestPath('src/__tests__/a.ts')).toBe(true)
    expect(isTestPath('__tests__/a.ts')).toBe(true)
    expect(isTestPath('src/testing/fakes.ts')).toBe(false)
    expect(isTestPath('src/contest.ts')).toBe(false)
  })

  it('takes the project config patterns instead of the built-in ones', () => {
    const python = ['**/test_*.py', '**/tests/**']
    expect(isTestPath('app/test_views.py', python)).toBe(true)
    expect(isTestPath('app/tests/conftest.py', python)).toBe(true)
    expect(isTestPath('app/views.py', python)).toBe(false)
    // The built-in names stop counting once a project names its own.
    expect(isTestPath('src/a.test.ts', python)).toBe(false)
    expect(isTestPath('src/a.test.ts', DEFAULT_TEST_PATTERNS)).toBe(true)
    expect(isTestPath('src/a.test.ts', [])).toBe(false)
  })

  it('maps a test file to the stem of the source it covers', () => {
    expect(coveredStem('src/a.test.ts')).toBe('src/a')
    expect(coveredStem('src/__tests__/a.test.ts')).toBe('src/a')
    expect(coveredStem('src/__tests__/helpers/mock.ts')).toBe('src/helpers/mock')
    expect(coveredStem('__tests__/a.spec.tsx')).toBe('a')
    expect(coveredStem('Makefile')).toBe('Makefile')
    expect(sourceStem('src/a.ts')).toBe('src/a')
    expect(sourceStem('Makefile')).toBe('Makefile')
  })
})
