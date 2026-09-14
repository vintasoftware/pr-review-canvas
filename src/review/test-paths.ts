import path from 'node:path'
import { matchesGlob } from './glob.js'

/**
 * What counts as a test file when the project config says nothing: the JavaScript and TypeScript
 * conventions this repository uses. `tests.patterns` in `pr-review.config.yml` replaces the list,
 * so a Python or Go project can name `test_*.py` or `*_test.go` instead.
 */
export const DEFAULT_TEST_PATTERNS: readonly string[] = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**']

/** True when one of the patterns matches the repo-relative path. */
export function isTestPath(filePath: string, patterns: readonly string[] = DEFAULT_TEST_PATTERNS): boolean {
  return patterns.some(p => matchesGlob(p, filePath))
}

/**
 * The path stem a test file covers: `src/__tests__/a.test.ts` → `src/a`. A source file matches
 * when its own stem (path without extension) is the same string. This strips the naming habits
 * of the default patterns, so a project with other patterns still gets `TEST_NOT_LAST` but may
 * not get `TEST_IN_OTHER`, which needs the source file behind a test name.
 */
export function coveredStem(testPath: string): string {
  const withoutTestsDir = testPath.replace(/(^|\/)__tests__\//, '$1')
  const ext = path.posix.extname(withoutTestsDir)
  const base = ext === '' ? withoutTestsDir : withoutTestsDir.slice(0, -ext.length)
  return base.replace(/\.(test|spec)$/, '')
}

export function sourceStem(filePath: string): string {
  const ext = path.posix.extname(filePath)
  return ext === '' ? filePath : filePath.slice(0, -ext.length)
}
