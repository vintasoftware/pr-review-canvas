// @ts-check
import { emptyState } from '../../src/contract/state.js'
import { draftDiff, marksOn, sameDiff, writtenOn } from './diff-identity.js'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)
const ON = { headSha: HEAD, mergeBaseSha: BASE }

/** @param {Partial<import('./contract-types.js').PendingComment>} [over] */
function draft(over = {}) {
  return {
    id: 'd1',
    path: 'a.ts',
    line: 1,
    side: /** @type {const} */ ('new'),
    body: 'x',
    headSha: HEAD,
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

it('tells two diffs apart by their commit and by their merge base', () => {
  expect(sameDiff(ON, { ...ON })).toBe(true)
  expect(sameDiff(ON, { ...ON, mergeBaseSha: OTHER })).toBe(false)
  expect(sameDiff(ON, { ...ON, headSha: OTHER })).toBe(false)
})

it('reads a draft without a merge base as written on the current one', () => {
  expect(draftDiff(draft(), ON)).toEqual(ON)
  expect(draftDiff(draft({ mergeBaseSha: OTHER }), ON)).toEqual({ headSha: HEAD, mergeBaseSha: OTHER })
  expect(writtenOn(draft(), ON)).toBe(true)
  expect(writtenOn(draft({ mergeBaseSha: BASE }), ON)).toBe(true)
  expect(writtenOn(draft({ mergeBaseSha: OTHER }), ON)).toBe(false)
  expect(writtenOn(draft({ headSha: OTHER }), ON)).toBe(false)
})

it('reads marks without a merge base as made on the canvas diff, and none as made on nothing', () => {
  const state = { ...emptyState('2026-09-10T12:00:00.000Z'), reviewedCanvasSha: HEAD }
  expect(marksOn(state, ON)).toBe(true)
  expect(marksOn({ ...state, reviewedMergeBaseSha: BASE }, ON)).toBe(true)
  expect(marksOn({ ...state, reviewedMergeBaseSha: OTHER }, ON)).toBe(false)
  expect(marksOn({ ...state, reviewedCanvasSha: OTHER }, ON)).toBe(false)
  expect(marksOn(emptyState('2026-09-10T12:00:00.000Z'), ON)).toBe(false)
})
