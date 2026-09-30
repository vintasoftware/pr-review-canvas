// @vitest-environment node
import { freshReaderState } from '../contract/tour-api.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import { ghFor42, gitFor42, HEAD_SHA } from '../testing/synthetic.js'
import { syntheticTour } from '../testing/synthetic-tour.js'
import { finishedRecord, finishTour } from './finish.js'

let t: TestContext
afterEach(() => t?.cleanup())

describe('finishedRecord', () => {
  it('lists a reader once, keeps the author picks that were approved, and drops what was not', () => {
    const previous = {
      touredBy: [
        { login: 'octocat', at: 'old' },
        { login: 'reviewer', at: 'old' },
      ],
    }
    const record = finishedRecord(
      previous,
      {
        reviewer: { login: 'octocat', author: true },
        reader: {
          ...freshReaderState(),
          picks: {
            kept: { pick: 'keep', approved: true },
            placed: { pick: 'keep', approved: true, place: 'lint' },
            changed: {
              pick: 'change',
              approved: true,
              restatement: { what: 'w', where: ['x'], unchanged: 'u' },
            },
            open: { pick: 'change', approved: false },
          },
        },
      },
      'the prompt',
      'now'
    )
    expect(record).toEqual({
      touredBy: [
        { login: 'reviewer', at: 'old' },
        { login: 'octocat', at: 'now' },
      ],
      author: {
        finishedAt: 'now',
        picks: {
          kept: { pick: 'keep' },
          placed: { pick: 'keep', place: 'lint' },
          changed: { pick: 'change', restatement: { what: 'w', where: ['x'], unchanged: 'u' } },
        },
        prompt: 'the prompt',
      },
    })
    // Nobody logged in leaves the list alone; a reviewer leaves the author's picks alone.
    const anonymous = finishedRecord(
      previous,
      { reviewer: { login: null, author: true }, reader: freshReaderState() },
      'p',
      'now'
    )
    expect(anonymous.touredBy).toEqual(previous.touredBy)
    const reviewer = finishedRecord(
      { ...previous, author: { finishedAt: 'x', picks: {}, prompt: 'p' } },
      { reviewer: { login: 'reviewer', author: false }, reader: freshReaderState() },
      'p',
      'now'
    )
    expect(reviewer.author).toEqual({ finishedAt: 'x', picks: {}, prompt: 'p' })
  })
})

describe('finishTour', () => {
  it('counts the open decisions and the questions left in its refusals', async () => {
    t = await makeTestContext({
      git: gitFor42(),
      gh: ghFor42(),
      projectConfig: {
        config: {
          ...DEFAULT_PROJECT_CONFIG,
          tour: { ...DEFAULT_PROJECT_CONFIG.tour, finalQuiz: 'required' },
        },
        warnings: [],
        source: null,
      },
    })
    const base = syntheticTour()
    const [decision] = base.decisions
    const [question] = base.quiz
    if (decision === undefined || question === undefined) throw new Error('synthetic tour')
    const artifact = syntheticTour({
      decisions: [decision, { ...decision, key: 'second', title: 'Second?' }],
      quiz: [question, { ...question, id: 'q-two' }],
    })
    await t.ctx.tours.write(HEAD_SHA, artifact)
    const reviewer = { login: 'octocat', author: true }
    await expect(
      finishTour(t.ctx, { key: 42, headSha: HEAD_SHA, artifact, reader: freshReaderState(), reviewer })
    ).rejects.toThrow('2 decisions are not settled: Sum over product?; Second?')
    const settled = {
      ...freshReaderState(),
      picks: {
        'sum-over-product': { pick: 'keep' as const, approved: true },
        second: { pick: 'keep' as const, approved: true },
      },
    }
    await expect(
      finishTour(t.ctx, { key: 42, headSha: HEAD_SHA, artifact, reader: settled, reviewer })
    ).rejects.toThrow('2 quiz questions still to answer right')
  })
})
