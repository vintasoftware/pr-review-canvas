// A tour model of the synthetic pull request, valid against its diff: what the tour tests write
// and what the validator is expected to pass.
import type { TourArtifact, TourModel } from '../contract/tour.js'
import { BASE_SHA, HEAD_SHA, syntheticArtifact } from './synthetic.js'

const SCENE = (text: string) =>
  `<div class="scene"><div class="banner good"><i data-icon="check"></i>${text}</div></div>`

export function syntheticTourModel(): TourModel {
  return {
    landmarks: [
      {
        id: 'before',
        stage: 'background',
        title: 'run() returned a() alone',
        lead: 'Every caller of run() got the value of a(), and other() computed x.',
        body: ['`run()` in `src/app.ts` returned `a()`. The one test pinned that value at 1.'],
        scene: SCENE('one function, one value'),
        code: [],
        literate: [],
        guards: [],
      },
      {
        id: 'world',
        stage: 'world',
        title: 'run() now adds b()',
        lead: 'A caller of run() gets a() plus b(); the test expects 3.',
        body: ['The sum replaces the single value, and `other()` gains `y`.'],
        scene: SCENE('run() = a() + b()'),
        code: [
          {
            path: 'src/app.ts',
            diff: "@@ -1,4 +1,5 @@\n import { a } from './a'\n+import { b } from './b'\n export function run() {\n-  return a()\n+  return a() + b()\n }",
          },
        ],
        literate: ['The import first, then the sum:', { chunk: 0 }],
        guards: [{ testPath: 'src/app.test.ts', behavior: 'run() returns 3' }],
      },
      {
        id: 'sum',
        stage: 'why',
        title: 'Sum, not product',
        lead: 'The spec says sum; a product would read the same at the call site.',
        body: ['`a() + b()` is what the description asks for.'],
        scene: SCENE('sum'),
        code: [{ path: 'src/app.ts', diff: '@@ -1,4 +1,5 @@\n-  return a()\n+  return a() + b()' }],
        literate: [{ chunk: 0 }],
        guards: [],
      },
      {
        id: 'respect',
        stage: 'respect',
        title: 'Keep run() total',
        lead: 'A later change adds to the sum, never replaces it.',
        body: ['Callers depend on the total.'],
        scene: SCENE('add, never replace'),
        code: [],
        literate: [],
        guards: [{ testPath: 'src/app.test.ts', behavior: 'run() is not 1 anymore' }],
      },
    ],
    decisions: [
      {
        key: 'sum-over-product',
        category: 'trade-off',
        landmark: 'sum',
        title: 'Sum over product?',
        context: 'The description says sum; the tests would pass either way for 1 and 2.',
        keep: { label: 'Sum', consequence: 'What the spec says; a product reads the same at the call site.' },
        change: { label: 'Product', consequence: 'Grows faster; the spec would have to change.' },
        recommended: 'keep',
        reason: { text: 'Sum is what the spec says.', place: 'pr' },
        anchor: { path: 'src/app.ts', line: 4 },
      },
    ],
    quiz: [
      {
        id: 'q-run',
        landmark: 'world',
        question: 'What does run() return now?',
        options: ['a()', 'a() + b()', 'a() * b()'],
        answer: 1,
        why: 'The sum replaces the single value.',
      },
    ],
    notToured: [{ title: 'The renamed file', path: 'src/new-name.ts' }],
  }
}

/** The synthetic tour as the store keeps it: published for PR #42 at HEAD_SHA, toured by no one. */
export function syntheticTour(over: Partial<TourArtifact> = {}): TourArtifact {
  return {
    version: 1,
    pr: syntheticArtifact().pr,
    repo: { owner: 'acme', name: 'widgets' },
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    blastRadius: ['schema'],
    budget: { landmarks: 4, decisions: 2, quiz: 2 },
    guide: null,
    ...syntheticTourModel(),
    generatedAt: '2026-09-10T12:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
    source: 'local',
    record: { touredBy: [] },
    ...over,
  }
}
