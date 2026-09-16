// Synthetic PR data shared by server tests: one small diff with the shapes the collector must
// handle, the GitHub payloads that describe it, and an artifact that layers it.
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { parseUnifiedDiff, toFileEntry } from '../git/diff-collector.js'
import type { GhResponse } from '../github/gh.js'
import {
  createFakeGh,
  createFakeGit,
  type FakeGh,
  type FakeGhOptions,
  type FakeGit,
  ghJson,
} from './fakes.js'

export const HEAD_SHA = 'a'.repeat(40)
export const BASE_SHA = 'b'.repeat(40)

export const SYNTHETIC_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
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
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const fresh = true',
  '+// </script><script>alert(1)</script>',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const old = 1',
  '-// bye',
  '\\ No newline at end of file',
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 90%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  'index 5555555..6666666 100644',
  '--- a/src/old-name.ts',
  '+++ b/src/new-name.ts',
  '@@ -1,2 +1,2 @@',
  '-export const name = "old"',
  '+export const name = "new"',
  ' export const keep = 1',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 7777777..8888888 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/bin/run.sh b/bin/run.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/src/app.test.ts b/src/app.test.ts',
  'index 9999999..aaaaaaa 100644',
  '--- a/src/app.test.ts',
  '+++ b/src/app.test.ts',
  '@@ -1,3 +1,4 @@',
  " import { run } from './app'",
  " test('runs', () => {",
  '-  expect(run()).toBe(1)',
  '+  expect(run()).toBe(3)',
  '+  expect(run()).not.toBe(1)',
  ' })',
  '',
].join('\n')

export const SYNTHETIC_FILES = parseUnifiedDiff(SYNTHETIC_DIFF)

export const SYNTHETIC_BLOBS: Record<string, string> = {
  [`${HEAD_SHA}:src/app.ts`]: [
    "import { a } from './a'",
    "import { b } from './b'",
    'export function run() {',
    '  return a() + b()',
    '}',
    '',
    '',
    '',
    '',
    '',
    'export function other() {',
    '  const x = 1',
    '  const y = 2',
    '  return x',
    '}',
    '',
  ].join('\n'),
  [`${BASE_SHA}:src/app.ts`]: "import { a } from './a'\nexport function run() {\n  return a()\n}\n",
  [`${HEAD_SHA}:src/new.ts`]: 'export const fresh = true\n// </script><script>alert(1)</script>\n',
  [`${BASE_SHA}:src/gone.ts`]: 'export const old = 1\n// bye',
  [`${HEAD_SHA}:src/new-name.ts`]: 'export const name = "new"\nexport const keep = 1\n',
  [`${BASE_SHA}:src/old-name.ts`]: 'export const name = "old"\nexport const keep = 1\n',
  [`${HEAD_SHA}:bin/run.sh`]: '#!/bin/sh\n',
  [`${BASE_SHA}:bin/run.sh`]: '#!/bin/sh\n',
  [`${HEAD_SHA}:src/app.test.ts`]:
    "import { run } from './app'\ntest('runs', () => {\n  expect(run()).toBe(3)\n  expect(run()).not.toBe(1)\n})\n",
  [`${BASE_SHA}:src/app.test.ts`]:
    "import { run } from './app'\ntest('runs', () => {\n  expect(run()).toBe(1)\n})\n",
}

export const GH_PULL = {
  number: 42,
  title: 'feat: add b',
  body: 'Adds `b()` to the run path.\n\nSee src/app.ts:4 for the change.',
  html_url: 'https://github.com/acme/widgets/pull/42',
  state: 'open',
  draft: false,
  updated_at: '2026-09-09T09:00:00Z',
  merged: false,
  additions: 7,
  deletions: 5,
  changed_files: 7,
  user: { login: 'octocat' },
  base: { ref: 'main' },
  head: { ref: 'feat/b', sha: HEAD_SHA },
}

export const GH_REVIEW_COMMENTS = [
  {
    id: 1001,
    user: { login: 'reviewer' },
    body: 'Why not `a() * b()`?',
    path: 'src/app.ts',
    line: 4,
    original_line: 4,
    side: 'RIGHT',
    commit_id: HEAD_SHA,
    created_at: '2026-09-09T10:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1001',
  },
  {
    id: 1002,
    user: { login: 'octocat' },
    body: 'Sum is what the spec says.',
    path: 'src/app.ts',
    line: 4,
    original_line: 4,
    side: 'RIGHT',
    commit_id: HEAD_SHA,
    in_reply_to_id: 1001,
    created_at: '2026-09-09T10:05:00Z',
    html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1002',
  },
  {
    id: 1003,
    user: null,
    body: 'Outdated remark',
    path: 'src/app.ts',
    line: null,
    original_line: 2,
    side: 'LEFT',
    start_line: 1,
    commit_id: 'c'.repeat(40),
    created_at: '2026-09-08T10:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/42#discussion_r1003',
  },
]

export const GH_ISSUE_COMMENTS = [
  {
    id: 2001,
    user: { login: 'ci-bot[bot]' },
    body: 'Coverage 99%',
    created_at: '2026-09-09T11:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-2001',
  },
  {
    id: 2002,
    user: { login: 'reviewer' },
    body: null,
    created_at: '2026-09-09T12:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-2002',
  },
]

/** The login behind the fake token, and what `gh api -i repos/acme/widgets` reports about it. */
export const GH_USER = { login: 'octocat' }

export const GH_REPO_RESPONSE: GhResponse = {
  status: 200,
  headers: { 'x-oauth-scopes': 'gist, read:org, repo', 'content-type': 'application/json' },
  body: {
    private: true,
    permissions: { admin: false, maintain: false, pull: true, push: true, triage: true },
  },
}

export const GH_THREADS_PAGE = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            isResolved: true,
            comments: { nodes: [{ databaseId: 1001 }, { databaseId: 1002 }, { databaseId: null }] },
          },
        ],
      },
    },
  },
}

export function syntheticArtifact(): ReviewArtifact {
  const files = SYNTHETIC_FILES.map(toFileEntry)
  return {
    version: 1,
    pr: {
      number: 42,
      title: GH_PULL.title,
      body: GH_PULL.body,
      author: 'octocat',
      url: GH_PULL.html_url,
      state: 'open',
      draft: false,
      updatedAt: '2026-09-09T09:00:00Z',
      baseRef: 'main',
      headRef: 'feat/b',
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      additions: 7,
      deletions: 5,
      changedFiles: 7,
      repo: { owner: 'acme', name: 'widgets' },
    },
    files,
    summary: 'Before, `run()` returned `a()`. After, it adds `b()`, see [app.ts](#hunk:src/app.ts#1).',
    risk: [{ label: 'schema', source: 'config' }],
    layers: [
      {
        id: 'layer-1',
        key: 'run-path',
        title: 'Run path',
        rationale: 'The change to `run()` and its test. See [line 4](#line:src/app.ts:4).',
        decisions: 'Sum over product, see [app.ts](#hunk:src/app.ts#1).',
        checkByHand: 'Run the app once and confirm the total.',
        kind: 'layer',
        risk: [{ label: 'schema', source: 'config' }],
        tests: [
          { behavior: 'run() adds b()', status: 'covered', testPath: 'src/app.test.ts' },
          { behavior: 'other() returns x', status: 'missing', note: 'y is unused' },
          { behavior: 'binary asset', status: 'not-needed' },
        ],
        files: [
          {
            path: 'src/app.ts',
            hunks: ['src_app_ts#1'],
            isTest: false,
            note: 'Read the return first.',
            annotations: [{ side: 'new', startLine: 3, endLine: 4, text: 'The sum is the whole change.' }],
          },
          { path: 'src/new-name.ts', hunks: ['src_new_name_ts#1'], isTest: false, annotations: [] },
          { path: 'src/app.test.ts', hunks: ['src_app_test_ts#1'], isTest: true, annotations: [] },
        ],
      },
      {
        id: 'layer-2',
        key: 'other',
        title: 'Other changes',
        rationale: 'Second hunk, new file, deletion.',
        kind: 'other',
        risk: [],
        tests: [],
        files: [
          { path: 'src/app.ts', hunks: ['src_app_ts#2'], isTest: false, annotations: [] },
          { path: 'src/new.ts', hunks: ['src_new_ts#1'], isTest: false, annotations: [] },
          { path: 'src/gone.ts', hunks: ['src_gone_ts#1'], isTest: false, annotations: [] },
        ],
      },
    ],
    points: [
      {
        id: 'p-1',
        fingerprint: 'fp-1',
        kind: 'decision',
        level: 'decide',
        title: 'Sum instead of product',
        path: 'src/app.ts',
        line: 4,
        side: 'new',
        body: 'Look at the operator because the spec is ambiguous; if the spec says sum, this is fine.',
        layerId: 'layer-1',
        origin: 'model',
      },
      {
        id: 'p-2',
        fingerprint: 'fp-2',
        kind: 'tests',
        level: 'check',
        title: 'other() has no test',
        path: 'src/app.ts',
        line: 13,
        body: 'The layer marks "other() returns x" as missing.',
        layerId: 'layer-2',
        origin: 'tests',
      },
      {
        id: 'p-3',
        fingerprint: 'fp-3',
        kind: 'debt',
        level: 'fyi',
        title: 'Deleted file had no owner',
        path: 'src/gone.ts',
        line: 1,
        side: 'old',
        body: 'Nothing imports it any more.',
        layerId: 'layer-2',
        origin: 'model',
      },
    ],
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', model: 'claude-opus-4-1', harness: 'claude-code', attempts: 1 },
    source: 'local',
  }
}

/** A clone that holds PR #42: the head and base refs, the diff between them, and the file blobs. */
export function gitFor42(): FakeGit {
  return createFakeGit({
    refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA, 'feat/b': HEAD_SHA },
    mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA, [`main..${HEAD_SHA}`]: BASE_SHA },
    diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF },
    blobs: SYNTHETIC_BLOBS,
    authors: { [HEAD_SHA]: 'octocat' },
    topLevel: '/repo',
  })
}

/** GitHub as seen through gh for PR #42: the pull, both comment lists, and one resolved thread. */
export function ghFor42(extra: FakeGhOptions = {}): FakeGh {
  return createFakeGh({
    ...extra,
    routes: {
      user: ghJson(GH_USER),
      'repos/acme/widgets/pulls/42': ghJson(GH_PULL),
      'repos/acme/widgets/pulls/42/comments': ghJson(GH_REVIEW_COMMENTS),
      'repos/acme/widgets/pulls/42/reviews': { kind: 'json' as const, body: [] },
      'repos/acme/widgets/issues/42/comments': ghJson(GH_ISSUE_COMMENTS),
      ...extra.routes,
    },
    rawRoutes: { 'repos/acme/widgets': GH_REPO_RESPONSE, ...extra.rawRoutes },
    graphql: extra.graphql ?? [GH_THREADS_PAGE, GH_THREADS_PAGE, GH_THREADS_PAGE],
  })
}
