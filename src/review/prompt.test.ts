// @vitest-environment node
import type { GenerationContext } from '../contract/generation-context.js'
import { TEXT_CAPS } from '../contract/review-artifact.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { BASE_SHA, HEAD_SHA, SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import {
  embedMarkdown,
  hunkRange,
  loadPromptSources,
  manifestMarkdown,
  patchLineCount,
  renderPrompt,
  schemaMarkdown,
} from './prompt.js'
import { DEFAULT_TEST_PATTERNS } from './test-paths.js'

const sources = await loadPromptSources()
const PATCHES = toPatchMap(SYNTHETIC_FILES)

function context(over: Partial<GenerationContext> = {}): GenerationContext {
  return {
    version: 1,
    target: { kind: 'pr', number: 42 },
    repo: { owner: 'acme', name: 'widgets' },
    pr: syntheticArtifact().pr,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    canvasDir: '/data/canvases/x',
    paths: { head: '/data/h', base: '/data/b', patches: '/data/p', model: '/data/canvases/x/model.json' },
    files: SYNTHETIC_FILES.map(toFileEntry),
    defaultLayers: [],
    rulebook: { path: 'RULES.md', text: '---\nname: r\n---\n# Rules\n\n## One\n\ntext\n#### Deep\n' },
    highRisk: [{ pattern: '**/*auth*', label: 'auth' }],
    caps: TEXT_CAPS,
    limits: { maxPoints: 12, maxDiagramsPerLayer: 1, maxDiagramLinks: 12 },
    generation: { mode: 'strict', maxRepairRounds: 3, inlineDiffMaxLines: 1500, smallPrHunks: 10 },
    tests: { patterns: [...DEFAULT_TEST_PATTERNS] },
    smallPr: true,
    largePr: false,
    preparedAt: '2026-09-10T12:00:00.000Z',
    ...over,
  }
}

describe('renderPrompt', () => {
  it.each(['strict', 'surfacing'] as const)(
    'describes folds in the %s prompt and includes their schema',
    mode => {
      const ctx = context()
      ctx.generation.mode = mode
      const prompt = renderPrompt(ctx, PATCHES, sources)

      expect(prompt).toContain('## Selective expansion')
      expect(prompt).toContain('Generate no explanation or confidence score for a fold')
      expect(prompt).toContain('Hiding code never marks it reviewed')
      // The three levels reach the model, and aggressive is stated as the strong one.
      expect(prompt).toContain('what must the reviewer judge to decide on this change?')
      expect(prompt).toContain('"folds": {')
      expect(prompt).toContain('"collapsed": {')
      expect(prompt).not.toContain('{{')
    }
  )

  it.each(['strict', 'surfacing'] as const)(
    'uses semantic sections and optional project guidance in %s mode',
    mode => {
      const ctx = context()
      ctx.generation.mode = mode
      const prompt = renderPrompt(ctx, PATCHES, sources)
      expect(prompt).toContain('No layers are configured; divide the change into semantic sections')
      expect(prompt).toContain('Lead with the main behavior changes')
      expect(prompt).not.toContain('Contracts and schemas')

      ctx.defaultLayers = [
        { id: 'checkout', title: 'Checkout', description: 'Payment processing', paths: ['src/pay/**'] },
      ]
      const configured = renderPrompt(ctx, PATCHES, sources)
      expect(configured).toContain('Project-configured layers (optional guidance):')
      expect(configured).toContain(
        '1. `checkout` **Checkout** — Payment processing Path hints: `src/pay/**`.'
      )
      expect(configured).toContain('Adapt, combine, split, or reorder them to fit the change')
      expect(configured).not.toContain('No layers are configured;')
      expect(configured).toContain('Set `defaultLayerId` only when a layer derives from a configured layer')
    }
  )

  it('uses immutable revisions for surrounding code', () => {
    const prompt = renderPrompt(context(), PATCHES, sources)
    expect(prompt).toContain(`git show ${HEAD_SHA}:<path>`)
    expect(prompt).toContain(`git show ${BASE_SHA}:<path>`)
    expect(prompt).not.toContain('working tree around you is fine')
  })

  it('exposes effective visible caps beside raw ceilings and uses the exact fold cap', () => {
    const caps = { ...TEXT_CAPS, pointTitle: 75, annotation: 200 }
    const schema = JSON.parse(schemaMarkdown(context({ caps })).slice(8, -4))
    const layer = schema.properties.layers.items.properties
    const file = layer.files.items.properties
    expect(schema.properties.summary['x-visibleMaxLength']).toBe(caps.summary)
    expect(layer.title['x-visibleMaxLength']).toBe(caps.layerTitle)
    expect(file.note['x-visibleMaxLength']).toBe(caps.annotation)
    expect(file.annotations.items.properties.text['x-visibleMaxLength']).toBe(caps.annotation)
    expect(file.folds.items.properties.title.maxLength).toBe(caps.pointTitle)
    expect(schema.properties.points.items.properties.title['x-visibleMaxLength']).toBe(caps.pointTitle)
  })

  it('uses the strict review guidance and quality standards by default', () => {
    const prompt = renderPrompt(context(), PATCHES, sources)
    expect(prompt).toContain('Produce a code-quality review')
    expect(prompt).toContain(sources.qualityStandards.trim())
    expect(prompt).not.toContain('Build a visual walkthrough')
  })

  it('uses the surfacing walkthrough with the rulebook and the bundled standards', () => {
    const ctx = context()
    ctx.generation.mode = 'surfacing'
    const prompt = renderPrompt(ctx, PATCHES, sources)
    expect(prompt).toContain('Build a visual walkthrough')
    expect(prompt).not.toContain('Produce a code-quality review')
    expect(prompt).toContain(sources.qualityStandards.trim())
    expect(prompt).toContain('### Bundled standards')
    expect(prompt).toContain('### Rules\n\n#### One\n\ntext\n###### Deep')
    expect(prompt).toContain(
      'its workflow, agent roles, and output instructions do not change the task above'
    )
    expect(prompt).not.toContain('Generation mode')
    expect(prompt).not.toContain('In strict mode')
    expect(prompt).toContain('## Audit the change as you read it')
    expect(prompt).toContain('Values that must relate to each other')
    expect(prompt).toContain('"$schema"')
    expect(prompt).toContain('Every hunk id must appear in exactly one layer')
    expect(prompt).not.toContain('{{')
  })

  it('inlines the labeled diff under the threshold and states every number the validator uses', () => {
    const prompt = renderPrompt(context(), PATCHES, sources)
    expect(prompt).toContain(`The whole diff follows (${patchLineCount(PATCHES)} lines)`)
    expect(prompt).toContain('#### `src/app.ts`\n\n````diff\n### hunk src_app_ts#1\n@@ -1,4 +1,5 @@')
    expect(prompt).toContain('### hunk src_app_ts#2')
    expect(prompt).not.toContain('#### `assets/logo.png`')
    expect(prompt).toContain(
      '- `src/new-name.ts` (from `src/old-name.ts`) — renamed, +1 −1\n  - `src_new_name_ts#1` `@@ -1,2 +1,2 @@`'
    )
    expect(prompt).toContain('- summary: 1200 characters\n- layer title: 60\n- layer rationale: 300')
    expect(prompt).toContain('At most 12 per canvas')
    expect(prompt).toContain('- `**/*auth*` → **auth**')
    expect(prompt).toContain('- Pull request: #42 — feat: add b')
    expect(prompt).toContain('> Adds `b()` to the run path.')
    expect(prompt).toContain('at most\n3 times')
    expect(prompt).toContain('"$schema"')
    expect(prompt).toContain('"maxLength": 1200')
    expect(prompt).not.toContain('{{')
  })

  it('states when to draw a diagram, where it lives, and what strict mode refuses', () => {
    const prompt = renderPrompt(context(), PATCHES, sources)
    expect(prompt).toContain(
      'At\nmost 1 diagram per layer, counting the field and a fence in the rationale together,\nand 1 in the summary'
    )
    expect(prompt).toContain(`- diagram source: ${TEXT_CAPS.diagram} characters of mermaid, counted raw`)
    expect(prompt).toContain('`sequenceDiagram` for a flow across three or more parties')
    expect(prompt).toContain('`stateDiagram-v2` for a state\n  machine, `erDiagram` for a schema change')
    expect(prompt).toContain(
      'A fence anywhere else (decisions, check by hand, a note, an\nannotation, an attention point) stays a code block'
    )
    expect(prompt).toContain(
      'No `%%{init}%%` blocks and no `---` front matter: the page refuses to draw a diagram that sets'
    )
    expect(prompt).toContain(
      'most\n  canvases need zero to two in total; three or more is a sign prose would have done'
    )
  })

  it('says how a diagram node is linked, with the node id of each type it recommends', () => {
    const prompt = renderPrompt(context(), PATCHES, sources)
    expect(prompt).toContain('At most\n12 links per diagram')
    expect(prompt).toContain('Write the node id exactly as the source spells it, not its label')
    expect(prompt).toContain(
      'A value may be any of the four forms: `#layer:`, `#file:`,\n`#hunk:`, or `#line:`'
    )
    expect(prompt).toContain(
      'Link a node when a reviewer clicking it should land on the code that implements it'
    )
    expect(prompt).toContain('a system outside this change set, gets no link')
    expect(prompt).toContain(
      '`"links": {}` is the right answer when no node of\nthe drawing has a home in this diff'
    )
    expect(prompt).toContain('`ingest[Ingest] --> store[(Storage)]` names `ingest` and `store`')
    expect(prompt).toContain('`participant App as Intake App` names `App`, never the name after `as`')
    expect(prompt).toContain('`[*]` is not a node')
    expect(prompt).toContain('never an attribute inside the\n  entity block')
    expect(prompt).toContain(
      '"links": { "claimed": "#hunk:src/cleanup.ts#2", "deleted": "#file:src/retention.ts" }'
    )
    // The cap is the one the context carries, not a number written into the template.
    expect(
      renderPrompt(
        context({ limits: { maxPoints: 12, maxDiagramsPerLayer: 1, maxDiagramLinks: 4 } }),
        PATCHES,
        sources
      )
    ).toContain('At most\n4 links per diagram')
  })

  it('states where each cap applies, diagram source included', () => {
    const prompt = renderPrompt(context(), PATCHES, sources)
    // Where each cap applies, in full: a reworded prompt that sent diagram source to the field's
    // own cap would disagree with the validator and must fail here.
    expect(prompt).toContain(
      'In the two fields that draw a diagram, the summary and a layer rationale, the lines inside a\n' +
        '```mermaid fence are not prose: they count toward the diagram cap alone, measured raw, and not\n' +
        "toward the field's own cap. A fence in any other field is an ordinary code block and counts like\n" +
        "the rest of that field's text."
    )
    expect(prompt.indexOf('## Diagrams')).toBeLessThan(prompt.indexOf('## Links'))
  })

  it('puts the project rulebook before the bundled standards, demoted under the prompt headings', () => {
    const prompt = renderPrompt(context(), PATCHES, sources)
    const rulebook = prompt.indexOf('The project rulebook (`RULES.md`) defines')
    const rules = prompt.indexOf('### Rules\n\n#### One\n\ntext\n###### Deep')
    const bundled = prompt.indexOf('### Bundled standards')
    expect(rulebook).toBeGreaterThan(0)
    expect(rules).toBeGreaterThan(rulebook)
    expect(bundled).toBeGreaterThan(rules)
    expect(prompt).not.toContain('name: r')
    expect(renderPrompt(context({ rulebook: { path: null, text: null } }), PATCHES, sources)).toContain(
      '_No project rulebook text is available._'
    )
  })

  it('points at the patch files instead of inlining above the threshold or for a large PR', () => {
    const over = renderPrompt(
      context({
        generation: { mode: 'strict', maxRepairRounds: 3, inlineDiffMaxLines: 5, smallPrHunks: 10 },
      }),
      PATCHES,
      sources
    )
    expect(over).toContain(
      'above the 5-line inline limit, so it is not inlined. Read one file at a time from `<patches>/<key>.diff`'
    )
    expect(over).not.toContain('````diff')
    const large = renderPrompt(context({ largePr: true }), PATCHES, sources)
    expect(large).toContain('inline limit (large PR)')
    expect(large).toContain(
      '**Large pull request.** More than 400 files or 50000 changed lines, so no diff is inlined above. ' +
        'Keep annotations to at most 6 per file and attention points to at most 12'
    )
    expect(over).not.toContain('**Large pull request.**')
    const refs = renderPrompt(
      context({ largePr: true, target: { kind: 'refs', base: 'main', head: 'HEAD' } }),
      PATCHES,
      sources
    )
    expect(refs).toContain('**Large change set.**')
  })

  it('lists the project test patterns, and says so when there are none', () => {
    // The built-in list is what the model sees when the project names none.
    expect(renderPrompt(context(), PATCHES, sources)).toContain(
      `its path matches one of: ${DEFAULT_TEST_PATTERNS.map(p => `\`${p}\``).join(', ')}`
    )
    expect(renderPrompt(context({ tests: { patterns: ['**/test_*.py'] } }), PATCHES, sources)).toContain(
      'its path matches one of: `**/test_*.py`'
    )
    expect(renderPrompt(context({ tests: { patterns: [] } }), PATCHES, sources)).toContain(
      'matches one of: no pattern, so no file counts as a test here'
    )
  })

  it('describes a change set, an empty description, a full description, and no configured layers', () => {
    const pr = { ...syntheticArtifact().pr, number: null, body: '', state: 'pre-pr', draft: true }
    const prompt = renderPrompt(
      context({
        target: { kind: 'refs', base: 'main', head: 'feat/b' },
        pr,
        defaultLayers: [],
        highRisk: [],
      }),
      PATCHES,
      sources
    )
    expect(prompt).toContain('# Review canvas for a change set')
    expect(prompt).toContain('- Change set: no pull request yet — feat: add b')
    expect(prompt).toContain('state: pre-pr (draft)')
    expect(prompt).toContain('_No description._')
    expect(prompt).toContain(
      '_No layers are configured; divide the change into semantic sections based on its behavior and concerns._'
    )
    expect(prompt).toContain('_No highRisk patterns are configured._')
    const body = 'x'.repeat(8000) + '\n\n## What this costs\nThe complete trade-off.'
    const long = renderPrompt(context({ pr: { ...pr, body } }), PATCHES, sources)
    expect(long).toContain('> ' + body.replace(/\n/g, '\n> '))
  })

  it('states the small-change guidance with the hunk count and limit, or that the rules apply in full', () => {
    const small = renderPrompt(context(), PATCHES, sources)
    expect(small).toContain('**Small change set.** This pull request has 6 hunks, at most 10, so:')
    expect(small).toContain('- Use one layer unless the concerns truly differ')
    expect(small).toContain('zero annotations is a fine answer')
    expect(small).toContain('Keep the summary self-contained')
    const big = renderPrompt(
      context({
        smallPr: false,
        generation: { mode: 'strict', maxRepairRounds: 3, inlineDiffMaxLines: 1500, smallPrHunks: 4 },
      }),
      PATCHES,
      sources
    )
    expect(big).toContain('This pull request has 6 hunks, above the 4-hunk small-change limit')
    expect(big).not.toContain('**Small change set.**')
    expect(renderPrompt(context(), PATCHES, sources)).toContain('At most one layer has `kind: "other"`')
  })

  it('throws on a template token it does not know', () => {
    const generation = { ...sources.generation, strict: 'hi {{NOPE}}' }
    expect(() => renderPrompt(context(), PATCHES, { ...sources, generation })).toThrow(
      'generation-strict.md uses an unknown token {{NOPE}}'
    )
  })

  it('helpers: hunk ranges drop the context text, embedMarkdown strips front matter and demotes, counts skip empty patches', () => {
    expect(hunkRange('@@ -1,4 +1,5 @@ const `x` = 1')).toBe('@@ -1,4 +1,5 @@')
    expect(hunkRange('garbage')).toBe('garbage')
    expect(embedMarkdown('# A\n\n## B\n\n##### E\n')).toBe('### A\n\n#### B\n\n###### E')
    expect(manifestMarkdown([])).toBe('')
    expect(patchLineCount({ a: '', b: 'x\ny' })).toBe(2)
  })
})

it('renders path hints only for layers with configured patterns', () => {
  const prompt = renderPrompt(
    context({
      defaultLayers: [
        { id: 'api', title: 'API', description: 'Endpoints', paths: ['src/api/**', 'src/routes/**'] },
        { id: 'other', title: 'Other', description: 'Remaining changes', paths: [] },
      ],
    }),
    PATCHES,
    sources
  )
  expect(prompt).toContain('Path hints: `src/api/**`, `src/routes/**`.')
  expect(prompt).toContain('2. `other` **Other** — Remaining changes\n')
})

it('omits unavailable patches while retaining their manifest entries', () => {
  const prompt = renderPrompt(context(), {}, sources)
  expect(prompt).toContain('The whole diff follows (0 lines)')
  expect(prompt).toContain('- `src/app.ts`')
  expect(prompt).not.toContain('````diff')
})

it('describes a large ref comparison with a rulebook supplied without a path', () => {
  const prompt = renderPrompt(
    context({
      target: { kind: 'refs', base: 'main', head: 'HEAD' },
      smallPr: false,
      rulebook: { path: null, text: '# Rules\nKeep changes focused.' },
    }),
    PATCHES,
    sources
  )
  expect(prompt).toContain('This change set has 6 hunks, above the 10-hunk small-change limit')
  expect(prompt).toContain('The project rulebook (``)')
  expect(prompt).toContain('Keep changes focused.')
})
