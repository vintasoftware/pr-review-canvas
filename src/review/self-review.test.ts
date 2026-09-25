import { syntheticArtifact } from '../testing/synthetic.js'
import { carriedSettlements, isAuthor, tallyCanvas, tallyMarkdown, withSettlement } from './self-review.js'

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
      '**For the reviewer:** no open attention points.\n**Settled by the author:** 3, each with its reason in the canvas.'
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

describe('carriedSettlements', () => {
  it('keeps nothing without a source', () => {
    expect(carriedSettlements(syntheticArtifact(), { sameCommit: null, basis: null })).toEqual({})
  })
})
