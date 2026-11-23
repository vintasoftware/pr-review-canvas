import { SYNTHETIC_DIFF } from '../src/testing/synthetic.js'
import { diffFromFiles, diffFromText, ghFiles, incompleteWarning, sameLoadedDiff } from './diff-fallback.js'

/** The files GitHub lists for the synthetic diff, as its pull request files API answers. */
const LISTED = [
  {
    filename: 'src/app.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: [
      '@@ -1,4 +1,5 @@',
      " import { a } from './a'",
      "+import { b } from './b'",
      ' export function run() {',
      '-  return a()',
      '+  return a() + b()',
      ' }',
      '@@ -10,3 +11,4 @@ export function other() {',
      '   const x = 1',
      '+  const y = 2',
      '   return x',
      ' }',
    ].join('\n'),
  },
  {
    filename: 'src/new.ts',
    status: 'added',
    additions: 2,
    deletions: 0,
    patch: '@@ -0,0 +1,2 @@\n+export const fresh = true\n+// </script><script>alert(1)</script>',
  },
  {
    filename: 'src/gone.ts',
    status: 'removed',
    additions: 0,
    deletions: 2,
    patch: '@@ -1,2 +0,0 @@\n-export const old = 1\n-// bye\n\\ No newline at end of file',
  },
  {
    filename: 'src/new-name.ts',
    previous_filename: 'src/old-name.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    patch: '@@ -1,2 +1,2 @@\n-export const name = "old"\n+export const name = "new"\n export const keep = 1',
  },
  { filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 },
  { filename: 'bin/run.sh', status: 'changed', additions: 0, deletions: 0 },
  {
    filename: 'src/app.test.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: [
      '@@ -1,3 +1,4 @@',
      " import { run } from './app'",
      " test('runs', () => {",
      '-  expect(run()).toBe(1)',
      '+  expect(run()).toBe(3)',
      '+  expect(run()).not.toBe(1)',
      ' })',
    ].join('\n'),
  },
]

it('rebuilds the same files and patches from the file list as from the diff GitHub sends', () => {
  const whole = diffFromText(SYNTHETIC_DIFF)
  const rebuilt = diffFromFiles(ghFiles(LISTED), LISTED.length)
  expect(rebuilt.files.map(f => f.path).sort()).toEqual(whole.files.map(f => f.path).sort())
  for (const file of rebuilt.files) {
    expect(file).toEqual(whole.files.find(f => f.path === file.path))
    expect(rebuilt.patches[file.key]).toBe(whole.patches[file.key])
  }
  expect(rebuilt.files.find(f => f.path === 'bin/run.sh')?.status).toBe('modified')
  expect(rebuilt.files.find(f => f.path === 'src/new-name.ts')).toMatchObject({
    status: 'renamed',
    oldPath: 'src/old-name.ts',
  })
  expect(rebuilt.files.find(f => f.path === 'assets/logo.png')?.status).toBe('binary')
  expect(rebuilt.missing).toEqual([])
  expect(incompleteWarning(rebuilt)).toBeNull()
})

it('lists a file too large to diff with its counts and no patch, and says so', () => {
  const big = { filename: 'data/huge.json', status: 'modified', additions: 90000, deletions: 12 }
  const diff = diffFromFiles(ghFiles([...LISTED, big]), LISTED.length + 1)
  const entry = diff.files.find(f => f.path === 'data/huge.json')
  expect(entry).toMatchObject({ additions: 90000, deletions: 12, status: 'modified' })
  expect(diff.patches[entry!.key]).toBeUndefined()
  expect(diff.missing).toEqual(['data/huge.json'])
  expect(incompleteWarning(diff)).toBe(
    'GitHub sent no changes for 1 file too large to diff (data/huge.json), so the page lists it without its lines. Read them on GitHub, or in the local app (pr-review serve), which diffs a clone.'
  )
})

it('counts the files a full list could not hold', () => {
  expect(incompleteWarning(diffFromFiles(ghFiles(LISTED), 3200))).toContain(
    'GitHub lists at most 3000 files of a pull request, so 3193 files are not shown'
  )
  expect(incompleteWarning(diffFromFiles(ghFiles(LISTED), 'unknown'))).toContain(
    'GitHub lists at most 300 files of a comparison this large'
  )
})

it('calls two diffs the same only when neither left anything out', () => {
  const whole = diffFromText(SYNTHETIC_DIFF)
  expect(sameLoadedDiff(whole, diffFromFiles(ghFiles(LISTED), LISTED.length))).toBe(true)
  expect(sameLoadedDiff(whole, diffFromText(SYNTHETIC_DIFF.replace('const y = 2', 'const y = 3')))).toBe(
    false
  )
  const partial = diffFromFiles(ghFiles([...LISTED.slice(0, 4), { ...LISTED[0]!, patch: undefined }]), 5)
  expect(sameLoadedDiff(partial, partial)).toBe(false)
  expect(ghFiles([{ filename: 'x' }, null, 'y'])).toEqual([])
})
