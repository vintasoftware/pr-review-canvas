// @vitest-environment node
import type { Pr } from '../contract/review-artifact.js'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../project-config.js'
import { createFakeGit, makeTestContext, type TestContext } from '../testing/fakes.js'
import { syntheticArtifact } from '../testing/synthetic.js'
import { followsMerges, lookupCanvas, standsForHead } from './canvas-lookup.js'

const HEAD = 'a'.repeat(40)
const OLD = 'e'.repeat(40)
const STRICT: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG, canvas: { ignoreMergeCommits: false } }

function pr(mergeable: boolean | null | undefined): Pr {
  const base = { ...syntheticArtifact().pr, headSha: HEAD }
  delete base.mergeable
  return mergeable === undefined ? base : { ...base, mergeable }
}

describe('followsMerges', () => {
  it('needs the setting on and a clean conflict report', () => {
    expect(followsMerges(DEFAULT_PROJECT_CONFIG, pr(true))).toBe(true)
    expect(followsMerges(DEFAULT_PROJECT_CONFIG, pr(false))).toBe(false)
    expect(followsMerges(DEFAULT_PROJECT_CONFIG, pr(null))).toBe(false)
    expect(followsMerges(DEFAULT_PROJECT_CONFIG, pr(undefined))).toBe(false)
    expect(followsMerges(STRICT, pr(true))).toBe(false)
  })
})

describe('standsForHead and lookupCanvas', () => {
  let t: TestContext
  afterEach(() => t?.cleanup())

  async function context(config: ProjectConfig, nonMerges: number): Promise<TestContext> {
    t = await makeTestContext({
      git: createFakeGit({
        ancestors: { [`${OLD}..${HEAD}`]: true },
        counts: { [`${OLD}..${HEAD}`]: 2 },
        nonMergeCounts: { [`${OLD}..${HEAD}`]: nonMerges },
      }),
      projectConfig: { config, warnings: [], source: null },
    })
    return t
  }

  it('the head stands for itself whatever the setting says', async () => {
    await context(STRICT, 1)
    expect(await standsForHead(t.ctx, HEAD, pr(null))).toBe(true)
  })

  it('an older commit stands for the head only through merges, with the setting on', async () => {
    await context(DEFAULT_PROJECT_CONFIG, 0)
    expect(await standsForHead(t.ctx, OLD, pr(true))).toBe(true)
    expect(await standsForHead(t.ctx, OLD, pr(null))).toBe(false)
    expect(await standsForHead(t.ctx, 'f'.repeat(40), pr(true))).toBe(false)
    await t.cleanup()
    await context(DEFAULT_PROJECT_CONFIG, 1)
    expect(await standsForHead(t.ctx, OLD, pr(true))).toBe(false)
    await t.cleanup()
    await context(STRICT, 0)
    expect(await standsForHead(t.ctx, OLD, pr(true))).toBe(false)
  })

  it('passes the setting and the conflict report on to the store', async () => {
    await context(DEFAULT_PROJECT_CONFIG, 0)
    const calls: unknown[] = []
    t.ctx.canvases.findForPr = async (number, headSha, opts) => {
      calls.push([number, headSha, opts])
      return { status: 'missing' }
    }
    await lookupCanvas(t.ctx, 42, pr(true))
    await lookupCanvas(t.ctx, 42, pr(false))
    expect(calls).toEqual([
      [42, HEAD, { followMerges: true }],
      [42, HEAD, { followMerges: false }],
    ])
  })
})
