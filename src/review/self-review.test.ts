import { syntheticArtifact } from '../testing/synthetic.js'
import {
  isAuthor,
  keptReopens,
  keptSettlements,
  tallyCanvas,
  tallyMarkdown,
  withSettlement,
} from './self-review.js'

const settlement = { reason: 'Known.', at: '2026-09-10T12:00:00.000Z' }

describe('tallyCanvas', () => {
  it('counts open reviewer points by level, open author points, and settled points apart', () => {
    const artifact = { ...syntheticArtifact(), settled: { 'fp-3': settlement } }
    expect(tallyCanvas(artifact)).toEqual({
      reviewer: { decide: 1, check: 0, fyi: 0 },
      authorOpen: 1,
      settled: 1,
    })
  })

  it('says when nothing is left for the reviewer and leaves out the empty lines', () => {
    const artifact = syntheticArtifact()
    const settled = Object.fromEntries(artifact.points.map(p => [p.fingerprint, settlement]))
    expect(tallyMarkdown(tallyCanvas({ ...artifact, settled }))).toBe(
      '**For the reviewer:** no open attention points.\n**Resolved by the author:** 3, each with its reason in the canvas.'
    )
    expect(tallyMarkdown({ reviewer: { decide: 0, check: 2, fyi: 1 }, authorOpen: 0, settled: 0 })).toBe(
      '**For the reviewer:** 3 attention points to judge (2 check, 1 fyi).'
    )
  })
})

describe('withSettlement', () => {
  it('adds, replaces, and removes one settlement and stamps the revision', () => {
    const settled = withSettlement(syntheticArtifact(), 'fp-1', settlement, 'r1')
    expect(settled).toMatchObject({ settled: { 'fp-1': settlement }, revisedAt: 'r1' })
    const replaced = withSettlement(settled, 'fp-1', { ...settlement, reason: 'Other.' }, 'r2')
    expect(replaced.settled).toEqual({ 'fp-1': { ...settlement, reason: 'Other.' } })
    expect(withSettlement(replaced, 'fp-1', undefined, 'r3')).toMatchObject({ settled: {}, revisedAt: 'r3' })
  })
})

describe('isAuthor', () => {
  it('matches the login without case and never matches no login', () => {
    expect(isAuthor('OctoCat', { author: 'octocat' })).toBe(true)
    expect(isAuthor('hubot', { author: 'octocat' })).toBe(false)
    expect(isAuthor(null, { author: 'octocat' })).toBe(false)
  })
})

describe('keptSettlements', () => {
  it('keeps nothing without a source', () => {
    expect(keptSettlements(syntheticArtifact(), null)).toEqual({})
  })

  it('keeps the settlement of every point the new canvas still has, and drops the rest', () => {
    const artifact = syntheticArtifact()
    const kept = artifact.points[0]!.fingerprint
    expect(keptSettlements(artifact, { settled: { [kept]: settlement, gone: settlement } })).toEqual({
      [kept]: settlement,
    })
  })
})

describe('reopened decisions', () => {
  const commit = 'c'.repeat(40)
  function withDecision() {
    const artifact = syntheticArtifact()
    const [first, ...rest] = artifact.points
    return { ...artifact, points: [{ ...first!, decisionCommit: commit }, ...rest] }
  }

  it("records the commit of a decision's point the author reopens, and drops it once settled again", () => {
    const artifact = withDecision()
    const fp = artifact.points[0]!.fingerprint
    const reopened = withSettlement(artifact, fp, undefined, 'r1')
    expect(reopened.reopened).toEqual({ [fp]: { commit, at: 'r1' } })
    expect(withSettlement(reopened, fp, settlement, 'r2')).not.toHaveProperty('reopened')
    // Any other point reopens with no record.
    expect(withSettlement(artifact, artifact.points[1]!.fingerprint, undefined, 'r3')).not.toHaveProperty(
      'reopened'
    )
  })

  it('keeps a reopen while the point still comes from the same commit', () => {
    const artifact = withDecision()
    const fp = artifact.points[0]!.fingerprint
    const reopen = { commit, at: 'r1' }
    expect(keptReopens(artifact, null)).toEqual({})
    expect(keptReopens(artifact, { reopened: { [fp]: reopen, gone: reopen } })).toEqual({ [fp]: reopen })
    expect(keptReopens(artifact, { reopened: { [fp]: { ...reopen, commit: 'd'.repeat(40) } } })).toEqual({})
  })
})
