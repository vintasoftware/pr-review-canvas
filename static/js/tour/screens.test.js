// @ts-check
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { freshReaderState } from '../../../src/contract/tour-api.js'
import { missingTourBundle, syntheticTourBundle } from '../../../src/testing/tour-page.js'
import { setHost } from '../host.js'
import {
  chunkHtml,
  coverHtml,
  decisionHtml,
  helpHtml,
  inline,
  landmarkHtml,
  literateHtml,
  missingHtml,
  navHtml,
  planHtml,
  quizHtml,
  railHtml,
  returnBannerHtml,
  staleBarHtml,
  tourHeaderHtml,
  worldLandmark,
} from './screens.js'
import { buildSteps } from './steps.js'

const NOW = new Date('2026-09-10T13:00:00.000Z')
const LOOK = /** @type {const} */ ({ host: 'localhost:3010', theme: 'auto', skin: 'github', now: NOW })

/** @param {Partial<import('../contract-types.js').TourReaderState>} [reader] */
function bundleWith(reader = {}) {
  return syntheticTourBundle({ reader: { ...freshReaderState(), ...reader } })
}

/** @param {import('../contract-types.js').TourBundle} bundle */
function stepsOf(bundle) {
  return buildSteps(/** @type {import('../contract-types.js').TourPageTour} */ (bundle.tour), bundle.options)
}

/** @param {import('../contract-types.js').TourBundle} bundle */
function tourOf(bundle) {
  return /** @type {import('../contract-types.js').TourPageTour} */ (bundle.tour)
}

beforeEach(() => {
  setHost({ kind: 'github', label: 'GitHub', webBase: 'https://github.com' })
})

describe('inline', () => {
  it('escapes, then turns backtick spans into code', () => {
    expect(inline('a `<b>` & c')).toBe('a <code>&lt;b&gt;</code> &amp; c')
    expect(worldLandmark(tourOf(bundleWith())).id).toBe('world')
  })
})

describe('tourHeaderHtml', () => {
  it('names the tour, links the canvas and the forge, and says who generated it', () => {
    document.body.innerHTML = tourHeaderHtml(bundleWith(), LOOK)
    expect(document.querySelector('#canvas-link')?.getAttribute('href')).toBe('/review/42')
    expect(document.querySelector('.title a.cmd')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/42'
    )
    expect(document.querySelector('.hdr-title h1')?.textContent).toBe('Tour #42feat: add b')
    expect(document.querySelector('.pill.agent')?.textContent).toBe('tour by claude · claude-code')
    expect(document.querySelector('.meta a')?.getAttribute('href')).toBe('https://github.com/octocat')
    expect(document.querySelector('#skin-toggle')?.textContent).toBe('skin: github')
    for (const button of document.querySelectorAll('.hdr button')) {
      expect(button.getAttribute('title')).toMatch(/\S/)
    }
  })

  it('draws a local review with no forge link and a plain author', () => {
    const bundle = missingTourBundle({ local: 'branch' })
    const pr = { ...bundle.pr, url: '', number: null }
    document.body.innerHTML = tourHeaderHtml({ ...bundle, pr }, LOOK)
    expect(document.querySelector('#canvas-link')?.getAttribute('href')).toBe('/review/branch')
    expect(document.querySelector('.title a.cmd')).toBeNull()
    expect(document.querySelector('.meta a')).toBeNull()
    expect(document.querySelector('.pill.agent')).toBeNull()
  })
})

describe('railHtml and navHtml', () => {
  it('marks the steps done, current, open, and ahead, and labels the groups', () => {
    const bundle = bundleWith({ picks: { 'sum-over-product': { pick: 'keep', approved: true } } })
    document.body.innerHTML = railHtml(stepsOf(bundle), 2, bundle.reader, tourOf(bundle))
    const states = [...document.querySelectorAll('.tour-rail-seg')].map(s => s.getAttribute('data-state'))
    expect(states).toEqual(['done', 'done', 'current', 'open', 'open', 'done', 'open', 'ahead'])
    expect([...document.querySelectorAll('.tour-rail-label')].map(l => l.textContent)).toEqual([
      '',
      '4 landmarks',
      '1 decision',
      '1 question',
      '',
    ])
    expect(document.querySelector('.tour-rail-seg[data-state="ahead"]')?.hasAttribute('disabled')).toBe(true)
    document.body.innerHTML = railHtml(stepsOf(bundle), 2, bundle.reader, tourOf(bundle), { preview: true })
    expect(document.querySelector('.tour-rail-seg[data-state="ahead"]')).toBeNull()
    const off = { ...bundle, options: { ...bundle.options, finalQuiz: /** @type {const} */ ('off') } }
    document.body.innerHTML = railHtml(stepsOf(off), 0, off.reader, tourOf(off))
    expect(document.querySelector('.tour-rail-group[data-kind="quiz"]')).toBeNull()
  })

  it('enables next only once the step is settled', () => {
    const bundle = bundleWith()
    document.body.innerHTML = navHtml(stepsOf(bundle), 0, bundle.reader)
    expect(document.querySelector('[data-nav="prev"]')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('[data-nav="next"]')?.textContent).toBe('start →')
    document.body.innerHTML = navHtml(stepsOf(bundle), 5, bundle.reader)
    expect(document.querySelector('[data-nav="next"]')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('.tour-nav-pos')?.textContent).toBe('1 of 1 decision')
    document.body.innerHTML = navHtml(stepsOf(bundle), 7, bundle.reader)
    expect(document.querySelector('[data-nav="next"]')?.textContent).toBe('done →')
  })
})

describe('coverHtml', () => {
  it('sums the tour up and offers to start, or to continue', () => {
    document.body.innerHTML = coverHtml(bundleWith())
    expect(document.querySelector('.tour-title')?.textContent).toBe('feat: add b')
    expect(document.querySelector('.tour-lead')?.textContent).toBe(
      'A caller of run() gets a() plus b(); the test expects 3.'
    )
    expect([...document.querySelectorAll('.tour-budget b')].map(b => b.textContent)).toEqual([
      '4',
      '1',
      '1',
      '~6',
    ])
    expect(document.querySelector('.tour-cover-meta')?.textContent).toContain('no guide on file')
    expect(document.querySelector('.tour-cover-meta')?.textContent).toContain('touches: schema')
    expect(document.querySelector('[data-nav="next"]')?.textContent).toBe('Start the tour')
    const back = bundleWith({ step: 3 })
    const tour = { ...tourOf(back), guide: 'docs/pr-tour.md', blastRadius: [] }
    document.body.innerHTML = coverHtml({ ...back, tour, options: { ...back.options, finalQuiz: 'off' } })
    expect(document.querySelector('[data-nav="next"]')?.textContent).toBe('Continue the tour')
    expect(document.querySelector('.tour-cover-meta')?.textContent).toContain('guide: docs/pr-tour.md')
    expect(document.querySelector('.tour-cover-meta')?.textContent).not.toContain('touches')
    expect([...document.querySelectorAll('.tour-budget b')].map(b => b.textContent)).toEqual([
      '4',
      '1',
      '0',
      '~6',
    ])
    const finished = bundleWith({
      finished: { at: 'x', promptPath: '/p', prompt: 'p', sharing: { status: 'off' } },
    })
    document.body.innerHTML = coverHtml({ ...finished, pr: { ...finished.pr, url: '' } })
    expect(document.body.textContent).toContain('You finished this tour')
    expect(document.querySelector('.tour-eyebrow')?.textContent).toContain('feat/b')
  })
})

describe('returnBannerHtml', () => {
  it('offers the way back to where the jump came from', () => {
    const bundle = bundleWith()
    const steps = stepsOf(bundle)
    const tour = tourOf(bundle)
    expect(returnBannerHtml(steps, tour, null)).toBe('')
    expect(returnBannerHtml(steps, tour, 99)).toBe('')
    expect(returnBannerHtml(steps, tour, 6)).toContain('back to the question')
    expect(returnBannerHtml(steps, tour, 2)).toContain('Jumped from landmark 2')
    expect(returnBannerHtml(steps, tour, 5)).toContain('back to the decision')
  })
})

describe('landmarkHtml', () => {
  it('draws the prose, the scene host, the guards, the chips, the note, and the code closed', () => {
    const bundle = bundleWith({ notes: { sum: 'hm <b>' } })
    const steps = stepsOf(bundle)
    const sum = tourOf(bundle).landmarks[2]
    if (sum === undefined) {
      throw new Error('no landmark')
    }
    document.body.innerHTML = landmarkHtml(bundle, steps, sum)
    expect(document.querySelector('.tour-stage-tag')?.textContent).toBe('Why')
    expect(document.querySelector('.tour-eyebrow')?.textContent).toContain('landmark 3 of 4')
    expect(document.querySelector('.tour-frame-host')?.getAttribute('data-kind')).toBe('scene')
    expect(document.querySelector('.tour-frame-host[data-kind="micro"]')).toBeNull()
    expect(document.querySelector('.tour-chip')?.textContent).toBe('one decision waits here')
    expect(document.querySelector('.tour-chip.link')?.getAttribute('data-decision')).toBe('sum-over-product')
    expect(document.querySelector('textarea[data-act="note"]')?.textContent).toBe('hm <b>')
    expect(document.querySelector('.tour-code')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('[data-act="code"]')?.textContent).toContain('code behind this landmark')
    // The tabs are drawn with the code, hidden with it.
    expect(document.querySelector('.tour-code-tabs')).not.toBeNull()
    expect(document.querySelector('.tour-guards')).toBeNull()
  })

  it('opens the code in the literate view, or the raw one, and lists the guards', () => {
    const bundle = bundleWith({ codeOpen: { world: true } })
    const steps = stepsOf(bundle)
    const tour = tourOf(bundle)
    const world = tour.landmarks[1]
    if (world === undefined) {
      throw new Error('no landmark')
    }
    document.body.innerHTML = landmarkHtml(bundle, steps, world)
    expect(document.querySelector('.tour-code')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('[data-act="code"]')?.textContent).toContain('hide code')
    expect(document.querySelector('.tour-code-tab[aria-selected="true"]')?.textContent).toBe('literate diff')
    expect(document.querySelector('.tour-literate p')?.textContent).toBe('The import first, then the sum:')
    expect(document.querySelector('.tour-literate .tour-diff .add')?.textContent).toBe(
      "+import { b } from './b'"
    )
    expect(document.querySelector('.tour-guards')?.textContent).toContain('src/app.test.ts')
    expect(document.querySelector('.tour-chips')).toBeNull()
    bundle.reader.codeView['world'] = 'raw'
    document.body.innerHTML = landmarkHtml(bundle, steps, world)
    expect(document.querySelector('.tour-code-tab[aria-selected="true"]')?.textContent).toBe('raw diff')
    expect(document.querySelector('.tour-literate')).toBeNull()
    expect(document.querySelectorAll('.tour-diff')).toHaveLength(1)
    // A landmark with no code has no code control; a micro-world and a state flag are shown.
    const before = { ...tour.landmarks[0], micro: true, state: true }
    document.body.innerHTML = landmarkHtml(bundle, steps, /** @type {never} */ (before))
    expect(document.querySelector('[data-act="code"]')).toBeNull()
    expect(document.querySelector('.tour-frame-host[data-kind="micro"]')).not.toBeNull()
    expect(document.querySelector('.tour-state-tag')?.textContent).toBe('state landmark')
  })

  it('embeds chunks by index or inline, and skips an index that names nothing', () => {
    const world = tourOf(bundleWith()).landmarks[1]
    if (world === undefined) {
      throw new Error('no landmark')
    }
    const literate = [
      'Prose <x>',
      { chunk: 0 },
      { chunk: 9 },
      { path: 'src/b.ts', diff: '@@ -1 +1 @@\n-old\n+new\n same' },
    ]
    document.body.innerHTML = literateHtml({ ...world, literate })
    expect(document.querySelector('p')?.textContent).toBe('Prose <x>')
    expect(document.querySelectorAll('.tour-code-file')).toHaveLength(2)
    expect([...(document.querySelectorAll('.tour-diff')[1]?.children ?? [])].map(d => d.className)).toEqual([
      'hunk',
      'del',
      'add',
      '',
    ])
    expect(chunkHtml({ path: 'a', diff: '' })).toContain('<div> </div>')
  })
})

describe('decisionHtml', () => {
  it('preselects the recommendation, records the reason, and offers keep', () => {
    const bundle = bundleWith({ notes: { sum: 'my note' } })
    const decision = tourOf(bundle).decisions[0]
    if (decision === undefined) {
      throw new Error('no decision')
    }
    document.body.innerHTML = decisionHtml(bundle, stepsOf(bundle), decision)
    expect(document.querySelector('.tour-stage-tag')?.textContent).toBe('Trade-off')
    expect(document.querySelector('.tour-eyebrow a')?.textContent).toBe('from landmark 3: Sum, not product')
    expect(document.querySelector('.tour-option[aria-checked="true"]')?.getAttribute('data-pick')).toBe(
      'keep'
    )
    expect(document.querySelector('.tour-option .now')?.textContent).toBe('what the code does')
    expect(document.querySelector('.tour-option .rec')?.textContent).toBe('recommended')
    expect(document.querySelector('.tour-landmark-note')?.textContent).toContain('my note')
    expect(document.querySelector('.tour-reason q')?.textContent).toBe('Sum is what the spec says.')
    expect(document.querySelector('select[data-act="place"] option[selected]')?.getAttribute('value')).toBe(
      'pr'
    )
    expect(document.querySelector('[data-act="keep"]')).not.toBeNull()
    expect(document.querySelector('.tour-tryit')).toBeNull()
    expect(document.querySelector('.tour-anchor')?.textContent).toBe('src/app.ts:4')
  })

  it('shows a change pick, a settled keep, a settled change, and a try-it recipe', () => {
    const bundle = bundleWith({ picks: { 'sum-over-product': { pick: 'change', approved: false } } })
    const steps = stepsOf(bundle)
    const decision = tourOf(bundle).decisions[0]
    if (decision === undefined) {
      throw new Error('no decision')
    }
    document.body.innerHTML = decisionHtml(bundle, steps, decision)
    expect(document.querySelector('.tour-reason')).toBeNull()
    expect(document.querySelector('[data-act="grill"]')?.textContent).toContain('Say what you want instead')
    bundle.reader.picks['sum-over-product'] = { pick: 'keep', approved: true, place: 'code', tried: true }
    const withTry = {
      ...decision,
      landmark: 'nope',
      tryIt: { steps: ['pnpm start'], look: ['the sum'], verified: true },
    }
    document.body.innerHTML = decisionHtml(bundle, steps, withTry)
    expect(document.querySelector('.tour-state')?.textContent).toBe('✓ kept · reason code comment')
    expect(document.querySelector('[data-act="unsettle"]')).not.toBeNull()
    expect(document.querySelector('.tour-tryit ol code')?.textContent).toBe('pnpm start')
    expect(document.querySelector('.tour-tryit .tour-card-h')?.textContent).toContain('verified')
    expect(document.querySelector('input[data-act="tried"]')?.hasAttribute('checked')).toBe(true)
    expect(document.querySelector('.tour-eyebrow a')).toBeNull()
    bundle.reader.picks['sum-over-product'] = {
      pick: 'change',
      approved: true,
      restatement: { what: 'Multiply.', where: ['src/app.ts'], unchanged: 'Callers.' },
    }
    document.body.innerHTML = decisionHtml(bundle, steps, {
      ...withTry,
      tryIt: { ...withTry.tryIt, verified: false },
    })
    expect(document.querySelector('.tour-state.change')?.textContent).toBe('✓ change approved · in the plan')
    expect(document.querySelector('.tour-restated')?.textContent).toContain('Multiply.')
    expect(document.querySelector('.tour-tryit .tour-card-h')?.textContent).not.toContain('verified')
  })
})

describe('quizHtml', () => {
  it('numbers the options, and after an answer says why, or reopens the landmark', () => {
    const bundle = bundleWith()
    const q = tourOf(bundle).quiz[0]
    if (q === undefined) {
      throw new Error('no question')
    }
    document.body.innerHTML = quizHtml(bundle, q)
    expect(document.querySelectorAll('.tour-quiz-opt')).toHaveLength(3)
    expect(document.querySelector('.tour-quiz-opt')?.getAttribute('data-n')).toBe('1')
    expect(document.querySelector('.tour-quiz-hint')).not.toBeNull()
    bundle.reader.quiz['q-run'] = { answered: 0, right: false }
    document.body.innerHTML = quizHtml(bundle, q)
    expect(document.querySelector('.tour-quiz-opt[data-result="wrong"]')?.getAttribute('data-i')).toBe('0')
    expect(document.querySelector('.tour-quiz-why.wrong')?.textContent).toContain('Not quite.')
    expect(document.querySelector('[data-act="reopen"]')?.textContent).toBe(
      'reopen landmark 2: run() now adds b()'
    )
    bundle.reader.quiz['q-run'] = { answered: 1, right: true }
    document.body.innerHTML = quizHtml(bundle, q)
    expect(document.querySelector('.tour-quiz-opt[data-result="right"]')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('.tour-quiz-why.right')?.textContent).toBe(
      'The sum replaces the single value.'
    )
    bundle.reader.quiz['q-run'] = { answered: 0, right: false }
    document.body.innerHTML = quizHtml(bundle, { ...q, landmark: 'nope' })
    expect(document.querySelector('[data-act="reopen"]')).toBeNull()
  })
})

describe('planHtml', () => {
  it('lists the changes, the notes, and the kept decisions, and offers to confirm', () => {
    const bundle = bundleWith({
      picks: {
        'sum-over-product': {
          pick: 'change',
          approved: true,
          restatement: { what: 'Multiply.', where: ['src/app.ts'], unchanged: 'Callers.' },
        },
      },
      notes: { world: 'a note' },
    })
    document.body.innerHTML = planHtml(bundle)
    expect(document.querySelector('.tour-title')?.textContent).toBe('1 change to make, 0 kept')
    expect(document.querySelector('.tour-lead')?.textContent).toContain('the record is shared')
    expect(document.querySelector('.tour-plan-list li')?.textContent).toContain('Multiply.')
    expect(document.querySelectorAll('.tour-kept')[0]?.textContent).toContain('a note')
    expect(document.querySelectorAll('.tour-kept')[1]?.textContent).toBe('none')
    expect(document.querySelector('[data-act="confirm"]')?.textContent).toBe('Confirm the plan')
    expect(document.querySelector('.tour-not li .path')?.textContent).toBe('src/new-name.ts')
  })

  it('says nothing to change, and hides the record line when nothing is shared', () => {
    const bundle = bundleWith({ picks: { 'sum-over-product': { pick: 'keep', approved: true } } })
    document.body.innerHTML = planHtml({ ...bundle, shares: false })
    expect(document.querySelector('.tour-title')?.textContent).toBe('Nothing to change. 1 decision kept.')
    expect(document.querySelector('.tour-lead')?.textContent).not.toContain('shared')
    expect(document.querySelector('.tour-kept li .place')?.textContent).toBe('PR comment')
    expect(document.querySelector('.tour-hint')?.textContent).toBe('writes the prompt')
    document.body.innerHTML = planHtml({ ...bundle, preview: true })
    expect(document.querySelector('[data-act="confirm"]')).toBeNull()
    expect(document.body.textContent).toContain('A preview is not finished')
  })

  it('reports each way the record was shared once finished, with the prompt to copy', () => {
    const bundle = bundleWith({
      picks: { 'sum-over-product': { pick: 'keep', approved: true } },
      quiz: { 'q-run': { answered: 1, right: true } },
    })
    /** @param {import('../contract-types.js').TourSharing} sharing */
    const finished = sharing => /** @type {import('../contract-types.js').TourBundle} */ ({
      ...bundle,
      reader: {
        ...bundle.reader,
        finished: { at: 'x', promptPath: '/data/prompt.md', prompt: '# P', sharing },
      },
    })
    document.body.innerHTML = planHtml(finished({ status: 'shared', url: 'https://x.test/c' }))
    expect(document.querySelector('.tour-sharing a')?.getAttribute('href')).toBe('https://x.test/c')
    expect(document.querySelector('.tour-sharing .private')?.textContent).toBe(
      'Quiz 1 of 1, kept on this machine.'
    )
    expect(document.querySelector('#prompt')?.textContent).toBe('# P')
    expect(document.body.textContent).toContain('/pr-tour-apply 42')
    expect(document.querySelector('[data-act="confirm"]')).toBeNull()
    // What went to the pull request, for the author and for a reviewer.
    const withPosted = finished({ status: 'off' })
    const done = /** @type {import('../contract-types.js').TourFinished} */ (withPosted.reader.finished)
    withPosted.reader.finished = { ...done, posted: 2, warnings: ['one was not posted: boom'] }
    document.body.innerHTML = planHtml(withPosted)
    expect(document.querySelector('.tour-sharing')?.textContent).toContain(
      '2 kept reasons posted as comments on their lines.'
    )
    expect(document.querySelector('.tour-sharing .failed')?.textContent).toBe('one was not posted: boom')
    withPosted.reader.finished = { ...done, posted: 0 }
    document.body.innerHTML = planHtml(withPosted)
    expect(document.querySelector('.tour-sharing')?.textContent).toContain(
      'No kept reason belonged on the pull request'
    )
    withPosted.reader.finished = { ...done, queued: 1 }
    document.body.innerHTML = planHtml(withPosted)
    expect(document.querySelector('.tour-sharing')?.textContent).toContain(
      '1 change request added to your pending review'
    )
    withPosted.reader.finished = { ...done, queued: 0 }
    document.body.innerHTML = planHtml(withPosted)
    expect(document.querySelector('.tour-sharing')?.textContent).toContain(
      'Nothing new for your pending review.'
    )
    document.body.innerHTML = planHtml(finished({ status: 'failed', warning: 'boom', zipPath: '/z.zip' }))
    expect(document.querySelector('.tour-sharing .failed')?.textContent).toContain('boom')
    document.body.innerHTML = planHtml(finished({ status: 'off' }))
    expect(document.querySelector('.tour-sharing .private')?.textContent).toContain('Sharing is off')
    const local = finished({ status: 'local' })
    document.body.innerHTML = planHtml({
      ...local,
      local: 'branch',
      options: { ...local.options, finalQuiz: 'off' },
    })
    expect(document.querySelector('.tour-sharing .private')?.textContent).toContain('A local review')
    expect(document.body.textContent).not.toContain('Quiz 1 of 1')
    expect(document.body.textContent).toContain('/pr-tour-apply branch')
  })
})

describe('the corners of the screens', () => {
  it('leads with the first landmark when none is the world, names the model, and skips what is empty', () => {
    const bundle = bundleWith()
    const tour = tourOf(bundle)
    const first = tour.landmarks[0]
    if (first === undefined) {
      throw new Error('no landmark')
    }
    const noWorld = {
      ...tour,
      landmarks: tour.landmarks.map(l =>
        l.stage === 'world' ? { ...l, stage: /** @type {const} */ ('why') } : l
      ),
      generator: { ...tour.generator, model: 'opus' },
      notToured: [],
    }
    document.body.innerHTML = coverHtml({ ...bundle, tour: noWorld })
    expect(document.querySelector('.tour-lead')?.textContent).toBe(first.lead)
    document.body.innerHTML = tourHeaderHtml({ ...bundle, tour: noWorld }, LOOK)
    expect(document.querySelector('.pill.agent')?.textContent).toBe('tour by claude · opus · claude-code')
    document.body.innerHTML = planHtml({ ...bundle, tour: noWorld })
    expect(document.querySelector('.tour-not')).toBeNull()
    // A landmark without a scene draws no frame; two decisions on one landmark say so.
    const [before, world, sum] = tour.landmarks
    if (before === undefined || world === undefined || sum === undefined) {
      throw new Error('no landmarks')
    }
    document.body.innerHTML = landmarkHtml(bundle, stepsOf(bundle), { ...before, scene: false })
    expect(document.querySelector('.tour-frame-host')).toBeNull()
    const [decision] = tour.decisions
    if (decision === undefined) {
      throw new Error('no decision')
    }
    const two = { ...tour, decisions: [decision, { ...decision, key: 'second', title: 'Second?' }] }
    document.body.innerHTML = landmarkHtml({ ...bundle, tour: two }, stepsOf(bundle), sum)
    expect(document.querySelector('.tour-chip')?.textContent).toBe('2 decisions wait here')
    // An unknown category is shown as written; a change with sharing off says nothing of the record.
    const category = /** @type {import('../contract-types.js').Decision['category']} */ (
      /** @type {unknown} */ ('other')
    )
    const odd = { ...decision, category }
    document.body.innerHTML = decisionHtml(bundle, stepsOf(bundle), odd)
    expect(document.querySelector('.tour-stage-tag')?.textContent).toBe('other')
    const changed = bundleWith({
      picks: {
        'sum-over-product': {
          pick: 'change',
          approved: true,
          restatement: { what: 'w', where: ['x'], unchanged: 'u' },
        },
      },
    })
    document.body.innerHTML = planHtml({ ...changed, shares: false })
    expect(document.querySelector('.tour-lead')?.textContent).toBe(
      'Read it once. When you confirm, the prompt is written. No further plan review.'
    )
    // A stale ancestor with no count.
    expect(
      staleBarHtml({
        ...bundle,
        stale: { tourHeadSha: 'a'.repeat(40), currentHeadSha: 'c'.repeat(40), relation: 'ancestor' },
      })
    ).toContain('0 commits behind')
  })
})

describe('the other screens', () => {
  it('draws the missing screen, the stale bar, and the help', () => {
    const bundle = bundleWith()
    document.body.innerHTML = missingHtml(missingTourBundle())
    expect(document.querySelector('.tour-missing h2')?.textContent).toBe('No tour yet for this pull request')
    expect(document.querySelector('button[data-copy]')?.getAttribute('data-copy')).toBe('/pr-tour 42')
    document.body.innerHTML = missingHtml(missingTourBundle({ local: 'branch' }))
    expect(document.querySelector('.tour-missing h2')?.textContent).toBe('No tour yet for this local work')
    expect(staleBarHtml(bundle)).toBe('')
    const ancestor = staleBarHtml({
      ...bundle,
      stale: {
        tourHeadSha: 'a'.repeat(40),
        currentHeadSha: 'c'.repeat(40),
        relation: 'ancestor',
        commitsBehind: 2,
      },
    })
    expect(ancestor).toContain('2 commits behind the head')
    const unrelated = staleBarHtml({
      ...bundle,
      stale: { tourHeadSha: 'a'.repeat(40), currentHeadSha: 'c'.repeat(40), relation: 'unrelated' },
    })
    expect(unrelated).toContain('on a commit the head does not contain')
    document.body.innerHTML = helpHtml()
    expect(document.querySelectorAll('dt')).toHaveLength(6)
    expect(document.querySelector('[data-act="close-help"]')).not.toBeNull()
  })
})
