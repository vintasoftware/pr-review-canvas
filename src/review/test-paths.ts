import path from 'node:path'
import { matchesGlob } from './glob.js'

/**
 * The test conventions found across stacks, by directory and by file-name shape rather than by
 * language, so a repository without a `pr-review.config.yml` still gets its tests labelled,
 * ordered after the code they cover, and kept open at the light reading level. Directories:
 * `__tests__`, `tests`, `test`, `spec`. Names: `x.test.*` and `x.spec.*` (JS/TS), `x_test.*` (Go,
 * Python, Elixir, Dart, Rust), `test_x.py` and `conftest.py` (pytest), `x_spec.*` (Ruby),
 * `XTest.*` and `XTests.*` (Java, Kotlin, PHP, C#, Swift). `tests.patterns` replaces the list.
 */
export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  '**/__tests__/**',
  '**/tests/**',
  '**/test/**',
  '**/spec/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*_spec.*',
  '**/test_*.py',
  '**/conftest.py',
  '**/*Test.*',
  '**/*Tests.*',
]

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
