// @vitest-environment node
import { createFakeGit } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA, SYNTHETIC_DIFF } from '../testing/synthetic.js'
import { collectDiffs, parseBlock, parseUnifiedDiff, splitBlocks, toFileEntry, toPatchMap } from './diff-collector.js'

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(SYNTHETIC_DIFF)

  it('finds every file with its status, counts, key, and lang', () => {
    expect(
      files.map(f => ({
        path: f.path,
        key: f.key,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        lang: f.lang,
        oldPath: f.oldPath,
      }))
    ).toEqual([
      {
        path: 'src/app.ts',
        key: 'src_app_ts',
        status: 'modified',
        additions: 3,
        deletions: 1,
        lang: 'typescript',
        oldPath: undefined,
      },
      {
        path: 'src/new.ts',
        key: 'src_new_ts',
        status: 'added',
        additions: 2,
        deletions: 0,
        lang: 'typescript',
        oldPath: undefined,
      },
      {
        path: 'src/gone.ts',
        key: 'src_gone_ts',
        status: 'deleted',
        additions: 0,
        deletions: 2,
        lang: 'typescript',
        oldPath: undefined,
      },
      {
        path: 'src/new-name.ts',
        key: 'src_new_name_ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        lang: 'typescript',
        oldPath: 'src/old-name.ts',
      },
      {
        path: 'assets/logo.png',
        key: 'assets_logo_png',
        status: 'binary',
        additions: 0,
        deletions: 0,
        lang: undefined,
        oldPath: undefined,
      },
      {
        path: 'bin/run.sh',
        key: 'bin_run_sh',
        status: 'modified',
        additions: 0,
        deletions: 0,
        lang: 'bash',
        oldPath: undefined,
      },
      {
        path: 'src/app.test.ts',
        key: 'src_app_test_ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        lang: 'typescript',
        oldPath: undefined,
      },
    ])
  })

  it('starts each patch at its first @@ and keeps the no-newline marker', () => {
    expect(files[0]?.patch.startsWith('@@ -1,4 +1,5 @@')).toBe(true)
    expect(files[2]?.patch).toBe('@@ -1,2 +0,0 @@\n-export const old = 1\n-// bye\n\\ No newline at end of file')
    expect(files[4]?.patch).toBe('')
    expect(files[5]?.patch).toBe('')
  })

  it('keeps </script> in a patch as data, not markup', () => {
    expect(files[1]?.patch).toContain('</script>')
  })

  it('suffixes keys when two paths sanitize to the same key', () => {
    const diff = [
      'diff --git a/a-b.ts b/a-b.ts',
      '--- a/a-b.ts',
      '+++ b/a-b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/a_b.ts b/a_b.ts',
      '--- a/a_b.ts',
      '+++ b/a_b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+z',
    ].join('\n')
    expect(parseUnifiedDiff(diff).map(f => f.key)).toEqual(['a_b_ts', 'a_b_ts_2'])
  })

  it('returns nothing for an empty diff or a header without a path', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('diff --git nonsense\n')).toEqual([])
  })
})

describe('splitBlocks and parseBlock', () => {
  it('drops text before the first diff header', () => {
    expect(splitBlocks('noise\ndiff --git a/x b/x\n--- a/x\n+++ b/x')).toEqual([
      ['diff --git a/x b/x', '--- a/x', '+++ b/x'],
    ])
  })

  it('returns null for a block without any path', () => {
    expect(parseBlock(['garbage line'])).toBeNull()
  })

  it('uses the diff header when there is no ---/+++ pair', () => {
    expect(parseBlock(['diff --git a/x/y.txt b/x/y.txt', 'old mode 100644', 'new mode 100755'])).toEqual({
      path: 'x/y.txt',
      status: 'modified',
      additions: 0,
      deletions: 0,
      patch: '',
    })
  })

  it('treats a GIT binary patch as binary', () => {
    expect(parseBlock(['diff --git a/i.png b/i.png', '--- a/i.png', '+++ b/i.png', 'GIT binary patch'])?.status).toBe(
      'binary'
    )
  })
})

describe('toFileEntry and toPatchMap', () => {
  const files = parseUnifiedDiff(SYNTHETIC_DIFF)

  it('builds the manifest entry with the hunk index', () => {
    expect(toFileEntry(files[0] as (typeof files)[number])).toEqual({
      path: 'src/app.ts',
      key: 'src_app_ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      lang: 'typescript',
      hunks: [
        { id: 'src_app_ts#1', header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 },
        {
          id: 'src_app_ts#2',
          header: '@@ -10,3 +11,4 @@ export function other() {',
          oldStart: 10,
          oldLines: 3,
          newStart: 11,
          newLines: 4,
        },
      ],
    })
    expect(toFileEntry(files[3] as (typeof files)[number]).oldPath).toBe('src/old-name.ts')
  })

  it('maps keys to patches', () => {
    const map = toPatchMap(files)
    expect(Object.keys(map)).toEqual(files.map(f => f.key))
    expect(map).toMatchObject({ src_new_ts: files[1]?.patch })
  })
})

describe('collectDiffs', () => {
  it('runs the diff through git and parses it', async () => {
    const git = createFakeGit({ diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF } })
    const files = await collectDiffs(git, BASE_SHA, HEAD_SHA)
    expect(files.map(f => f.path)).toEqual(parseUnifiedDiff(SYNTHETIC_DIFF).map(f => f.path))
    expect(git.calls).toEqual([['diff', BASE_SHA, HEAD_SHA]])
  })

  it('propagates a git failure', async () => {
    const git = createFakeGit()
    await expect(collectDiffs(git, BASE_SHA, HEAD_SHA)).rejects.toThrow(/bad revision/)
  })
})
