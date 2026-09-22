import path from 'node:path'
import { matchesGlob } from './glob.js'

/**
 * The languages whose test classes are named `XTest` or `XTests`. Only these extensions, so a
 * component such as `ABTest.tsx` is not taken for a test.
 */
const CLASS_TEST_EXTENSIONS = ['java', 'kt', 'scala', 'groovy', 'cs', 'fs', 'vb', 'swift', 'php'] as const

/**
 * The test conventions found across stacks, by directory and by file-name shape rather than by
 * language, so a repository without a `pr-review.config.yml` still gets its tests labelled,
 * ordered after the code they cover, and kept open at the light reading level. Directories:
 * `__tests__`, `tests`, `test`. Names: `x.test.*` and `x.spec.*` (JS/TS), `x_test.*` (Go,
 * Python, Elixir, Dart, Rust), `test_x.py` and `conftest.py` (pytest), `x_spec.*` (Ruby),
 * `XTest` and `XTests` in the class-test languages above. A `spec/` directory is left out: it
 * often holds API specs rather than tests. `tests.patterns` replaces the list.
 */
export const DEFAULT_TEST_PATTERNS: readonly string[] = [
  '**/__tests__/**',
  '**/tests/**',
  '**/test/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*_spec.*',
  '**/test_*.py',
  '**/conftest.py',
  ...CLASS_TEST_EXTENSIONS.flatMap(ext => [`**/*Test.${ext}`, `**/*Tests.${ext}`]),
]

/**
 * Generated content that lives beside tests: snapshots and fixtures. They are test paths, but
 * nobody reads them line by line, so they may hide at the light level like any generated file.
 */
export const GENERATED_TEST_PATTERNS: readonly string[] = [
  '**/__snapshots__/**',
  '**/*.snap',
  '**/fixtures/**',
  '**/__fixtures__/**',
]

/** True for a test path a reviewer reads as written: a test path that is not a snapshot or fixture. */
export function isHandWrittenTest(
  filePath: string,
  patterns: readonly string[] = DEFAULT_TEST_PATTERNS
): boolean {
  return isTestPath(filePath, patterns) && !isTestPath(filePath, GENERATED_TEST_PATTERNS)
}

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
