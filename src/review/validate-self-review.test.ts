// @vitest-environment node
import type { SelfReviewDecision } from '../contract/generation-context.js'
import type { FileEntry, ModelOutput, ModelPoint } from '../contract/review-artifact.js'
import { validateSelfReview } from './validate-self-review.js'

// One file with two chunks: new-side lines 1-5 and 11-14.
const files: FileEntry[] = [
  {
    path: 'src/app.ts',
    key: 'src_app_ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    hunks: [
      { id: 'src_app_ts#1', header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 },
      {
        id: 'src_app_ts#2',
        header: '@@ -10,3 +11,4 @@',
        oldStart: 10,
        oldLines: 3,
        newStart: 11,
        newLines: 4,
      },
    ],
  },
]

const settled: SelfReviewDecision = {
  key: 'rows',
  title: 'Empty rows',
  path: 'src/app.ts',
  line: 2,
  side: 'new',
  picked: 'A, Skip them',
  why: 'Old exports pad.',
}
const open: SelfReviewDecision = {
  key: 'retry',
  title: 'Retry policy',
  path: 'src/app.ts',
  line: 12,
  side: 'new',
}

function point(over: Partial<ModelPoint> = {}): ModelPoint {
  return {
    kind: 'decision',
    level: 'decide',
    title: 'A point',
    path: 'src/app.ts',
    line: 13,
    body: 'b',
    asks: 'retry',
    ...over,
  }
}

function check(points: ModelPoint[], selfReview = { settled: [settled], open: [open] }) {
  return validateSelfReview({ points } as unknown as ModelOutput, files, selfReview).map(e => e.code)
}

describe('validateSelfReview', () => {
  it('passes a canvas that raises the open card and leaves the settled one alone', () => {
    expect(check([point()])).toEqual([])
    // An fyi or check point may explain the settled decision on its own code.
    expect(check([point(), point({ level: 'fyi', line: 3, asks: undefined })])).toEqual([])
    expect(check([point(), point({ level: 'check', kind: 'tests', line: 3, asks: undefined })])).toEqual([])
  })

  it('refuses a decide point on a settled decision’s code that does not say it reopens it', () => {
    const errors = validateSelfReview(
      { points: [point(), point({ line: 4, asks: undefined, title: 'Sneaky' })] } as unknown as ModelOutput,
      files,
      { settled: [settled], open: [open] }
    )
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'SETTLED_REOPENED',
        where: 'point:2',
        message: expect.stringContaining('"rows"'),
      }),
    ])
  })

  it('accepts a declared reopen on the decision’s own chunk, and refuses one anchored elsewhere', () => {
    expect(check([point(), point({ line: 4, asks: undefined, reopens: 'rows' })])).toEqual([])
    expect(check([point(), point({ line: 12, asks: undefined, reopens: 'rows' })])).toEqual([
      'REOPEN_ELSEWHERE',
    ])
  })

  it('lets a reopen of a decision whose code moved away sit anywhere, since there is no line to hold it to', () => {
    const moved = { ...settled, line: undefined }
    expect(
      check([point(), point({ line: 12, asks: undefined, reopens: 'rows' })], {
        settled: [moved],
        open: [open],
      })
    ).toEqual([])
  })

  it('refuses a reopen or an ask that names no decision, or is not a decide point', () => {
    expect(check([point(), point({ line: 4, asks: undefined, reopens: 'nope' })])).toEqual([
      'SELF_REVIEW_KEY',
      // An unknown key does not excuse the silent reopen it amounts to.
      'SETTLED_REOPENED',
    ])
    expect(check([point({ asks: 'nope' })])).toEqual(['SELF_REVIEW_KEY', 'OPEN_UNASKED'])
    // Nor does a misspelled ask excuse a decide point on settled code.
    expect(check([point(), point({ line: 4, asks: 'nope' })])).toEqual([
      'SELF_REVIEW_KEY',
      'SETTLED_REOPENED',
    ])
    expect(check([point(), point({ line: 4, asks: undefined, reopens: 'rows', kind: 'risk' })])).toEqual([
      'SELF_REVIEW_LEVEL',
    ])
    expect(check([point({ level: 'check' })])).toEqual(['SELF_REVIEW_LEVEL'])
  })

  it('requires every card the author left for reviewers, unless its code changed since', () => {
    expect(check([])).toEqual(['OPEN_UNASKED'])
    expect(check([], { settled: [settled], open: [{ ...open, line: undefined }] })).toEqual([])
  })

  it('asks nothing of a canvas no deck speaks for, and refuses links it cannot resolve', () => {
    expect(
      validateSelfReview({ points: [point({ asks: undefined })] } as unknown as ModelOutput, files, undefined)
    ).toEqual([])
    expect(
      validateSelfReview(
        { points: [point({ reopens: 'rows', asks: undefined })] } as unknown as ModelOutput,
        files,
        undefined
      ).map(e => e.code)
    ).toEqual(['SELF_REVIEW_KEY'])
  })
})
