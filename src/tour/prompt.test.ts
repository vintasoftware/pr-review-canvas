// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { type TourContext, TourContextSchema } from '../contract/tour.js'
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import { ghFor42, gitFor42 } from '../testing/synthetic.js'
import { prepareTour } from './prepare.js'
import { renderTourPrompt } from './prompt.js'

let t: TestContext | undefined
afterEach(() => t?.cleanup())

const EXTRAS = { sceneGuidePath: '/g.md' }

/** The context and the patches prepare wrote for the synthetic pull request. */
async function prepared(): Promise<{ context: TourContext; patches: Record<string, string> }> {
  t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
  const result = await prepareTour(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
  const context = TourContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
  const { patches } = await t.ctx.derived.ensure(context)
  return { context, patches }
}

describe('renderTourPrompt', () => {
  it('says when no file counts as a test, and when micro-worlds are off', async () => {
    const { context, patches } = await prepared()
    const off: TourContext = {
      ...context,
      tests: { patterns: [] },
      options: { ...context.options, microWorld: false },
    }
    expect(renderTourPrompt(off, patches, '{{TEST_PATTERNS}}\n{{MICRO_WORLD}}', EXTRAS)).toBe(
      'no pattern, so no file counts as a test here\n' +
        'Micro-worlds are off for this project (`tour.microWorld`): write no `.micro.html` file.'
    )
  })

  it('inlines only the files that have a patch', async () => {
    const { context, patches } = await prepared()
    const added = context.files.find(f => f.path === 'src/new.ts')
    if (added === undefined) throw new Error('synthetic diff')
    const { [added.key]: _dropped, ...rest } = patches
    const diffs = renderTourPrompt(context, rest, '{{DIFFS}}', EXTRAS)
    expect(diffs).toContain('#### `src/app.ts`')
    // A binary file's patch is empty, and a file the patches leave out has none.
    expect(diffs).not.toContain('#### `assets/logo.png`')
    expect(diffs).not.toContain('#### `src/new.ts`')
  })
})
