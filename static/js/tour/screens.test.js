// @ts-check
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { freshReaderState } from '../../../src/contract/tour-api.js'
import { missingTourBundle, syntheticTourBundle } from '../../../src/testing/tour-page.js'
import { setHost } from '../host.js'
import {
  chunkHtml,
  fileLinker,
  coverHtml,
  decisionHtml,
  helpHtml,
  inline,
  plain,
  tryItStepHtml,
  landmarkHtml,
  literateHtml,
  missingHtml,
  navHtml,
  planHtml,
  quizHtml,
  railHtml,
  returnBannerHtml,
  staleBarHtml,
  stripHtml,
  tourHeaderHtml,
} from './screens.js'
import { buildSteps, planBasis } from './steps.js'

const NOW = new Date('2026-09-10T13:00:00.000Z')
const LOOK = /** @type {const} */ ({ host: 'localhost:3010', theme: 'auto', now: NOW })

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
    expect(inline('a `<b>` & c')).toBe('a <code class="nw">&lt;b&gt;</code> &amp; c')
  })

  it('keeps short code and flags whole, and lets long code wrap', () => {
    const long = 'x'.repeat(41)
    expect(inline(`run \`${long}\``)).toBe(`run <code>${long}</code>`)
    expect(inline('Text by default; JSON only with --json (or -q)')).toBe(
      'Text by default; JSON only with <span class="nw">--json</span> (or <span class="nw">-q</span>)'
    )
    // A hyphen inside a word is not a flag.
    expect(plain('human-readable <x>')).toBe('human-readable &lt;x&gt;')
  })
})

describe('tourHeaderHtml', () => {
  it('names the tour, links the canvas and the forge, and says who generated it', () => {
    document.body.innerHTML = tourHeaderHtml(bundleWith(), LOOK)
    expect(document.querySelector('#canvas-link')?.getAttribute('href')).toBe('/review/42')
    expect(document.querySelector('.tour-forge')?.getAttribute('aria-label')).toBe('Open #42 on GitHub')
    expect(document.querySelector('.tour-forge')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/42'
    )
    expect(document.querySelector('.hdr-title h1')?.textContent).toBe('Tour feat: add b #42')
    expect(document.querySelector('.pill.agent')?.textContent).toBe('tour by claude · claude-code')
    expect(document.querySelector('.meta a')?.getAttribute('href')).toBe('https://github.com/octocat')
    expect(document.querySelector('#skin-toggle')).toBeNull()
    expect(document.querySelector('#theme-toggle')?.textContent).toBe('theme: auto')
    expect(document.querySelector('.tour-skyline')?.getAttribute('aria-hidden')).toBe('true')
    for (const button of document.querySelectorAll('.hdr button')) {
      expect(button.getAttribute('title')).toMatch(/\S/)
    }
  })

  it('draws a local review with no forge link and a plain author', () => {
    const bundle = missingTourBundle({ local: 'branch' })
    const pr = { ...bundle.pr, url: '', number: null }
    document.body.innerHTML = tourHeaderHtml({ ...bundle, pr }, LOOK)
    expect(document.querySelector('#canvas-link')?.getAttribute('href')).toBe('/review/branch')
    expect(document.querySelector('.tour-forge')).toBeNull()
    expect(document.querySelector('.meta a')).toBeNull()
    expect(document.querySelector('.pill.agent')).toBeNull()
  })
})

describe('railHtml and navHtml', () => {
  it('marks the steps done, current, open, and ahead, and labels the groups', () => {
    const bundle = bundleWith({ picks: { 'sum-over-product': { pick: 'keep', approved: true } } })
    const states = () =>
      [...document.querySelectorAll('.tour-rail-seg')].map(s => s.getAttribute('data-state'))
    // A landmark passed without being on screen stays open: only a seen one is done.
    document.body.innerHTML = railHtml(stepsOf(bundle), 2, bundle.reader, tourOf(bundle))
    expect(states()).toEqual(['done', 'open', 'current', 'open', 'open', 'done', 'open', 'ahead'])
    const firstLandmark = tourOf(bundle).landmarks[0]?.id ?? ''
    bundle.reader.seen[firstLandmark] = true
    document.body.innerHTML = railHtml(stepsOf(bundle), 2, bundle.reader, tourOf(bundle))
    expect(states()).toEqual(['done', 'done', 'current', 'open', 'open', 'done', 'open', 'ahead'])
    // A decision taken back is open again, even with the reader past it.
    const undone = {
      ...bundle.reader,
      picks: {},
      quiz: { [tourOf(bundle).quiz[0]?.id ?? '']: { answered: 0, right: true } },
    }
    document.body.innerHTML = railHtml(stepsOf(bundle), 7, undone, tourOf(bundle))
    expect(states()[5]).toBe('open')
    // The plan is done once confirmed as it stands, and open again when it changed after.
    const finished = {
      at: 'x',
      promptPath: 'p',
      prompt: 'q',
      sharing: /** @type {const} */ ({ status: 'off' }),
    }
    const confirmed = {
      ...bundle.reader,
      finished: { ...finished, basis: planBasis(tourOf(bundle), bundle.reader) },
    }
    document.body.innerHTML = railHtml(stepsOf(bundle), 0, confirmed, tourOf(bundle))
    expect(states()[7]).toBe('done')
    const changed = { ...confirmed, picks: {} }
    document.body.innerHTML = railHtml(stepsOf(bundle), 0, changed, tourOf(bundle))
    expect(states()[7]).not.toBe('done')
    expect([...document.querySelectorAll('.tour-rail-label')].map(l => l.textContent)).toEqual([
      'start',
      '4 landmarks',
      '1 decision',
      '1 question',
      'plan',
    ])
    // Each stop wears its sign: a check once visited, a landmark's number, D, ?, and the plan's star.
    expect([...document.querySelectorAll('.tour-rail-seg > span')].map(s => s.textContent)).toEqual([
      '▸',
      '✓',
      '2',
      '3',
      '4',
      'D',
      '?',
      '★',
    ])
    expect(document.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe('0')
    expect(document.querySelector('.tour-rail-legend')?.getAttribute('aria-hidden')).toBe('true')
    // A closed stop stays focusable and says what opens it; the rail is one tab stop.
    const ahead = document.querySelector('.tour-rail-seg[data-state="ahead"]')
    expect(ahead?.hasAttribute('disabled')).toBe(false)
    expect(ahead?.getAttribute('aria-disabled')).toBe('true')
    expect(ahead?.getAttribute('aria-label')).toBe('What does run() return now? · opens after decision 1')
    const tabStops = [...document.querySelectorAll('.tour-rail-seg[tabindex="0"]')]
    expect(tabStops.map(s => s.getAttribute('data-step'))).toEqual(['0'])
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
    // The cover's own button is the primary one, not the nav's.
    expect(document.querySelector('[data-nav="next"]')?.classList.contains('fill')).toBe(false)
    expect(document.querySelector('.tour-nav-why')?.textContent).toBe('')
    document.body.innerHTML = navHtml(stepsOf(bundle), 1, bundle.reader)
    expect(document.querySelector('[data-nav="next"]')?.classList.contains('fill')).toBe(true)
    // A closed next says why, beside it.
    document.body.innerHTML = navHtml(stepsOf(bundle), 5, bundle.reader)
    expect(document.querySelector('[data-nav="next"]')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('.tour-nav-why')?.textContent).toBe('pick one to continue')
    expect(document.querySelector('[data-nav="next"]')?.getAttribute('aria-describedby')).toBe('nav-why')
    document.body.innerHTML = navHtml(stepsOf(bundle), 6, bundle.reader)
    expect(document.querySelector('.tour-nav-why')?.textContent).toBe('answer to continue')
    document.body.innerHTML = navHtml(stepsOf(bundle), 7, bundle.reader)
    expect(document.querySelector('[data-nav="next"]')?.textContent).toBe('done →')
    expect(document.querySelector('.tour-nav-why')?.textContent).toBe('confirm the plan to finish')
    document.body.innerHTML = navHtml(stepsOf(bundle), 7, bundle.reader, { preview: true })
    expect(document.querySelector('.tour-nav-why')?.textContent).toBe(
      'a preview is not finished: publish the tour first'
    )
  })
})

describe('coverHtml', () => {
  it('sums the tour up and offers to start, or to continue', () => {
    document.body.innerHTML = coverHtml(bundleWith())
    expect(document.querySelector('.tour-title')?.textContent).toBe('feat: add b')
    // The route by landmark title, not a landmark's lead told twice.
    expect(document.querySelector('.tour-lead')).toBeNull()
    expect([...document.querySelectorAll('.tour-agenda li')].map(li => li.textContent)).toEqual([
      'Before this changerun() returned a() alone',
      'The worldrun() now adds b()',
      'WhySum, not product',
      'What to respectKeep run() total',
    ])
    // The strip and the rail give the tour's size; the cover does not count it a third time.
    expect(document.querySelector('.tour-budget')).toBeNull()
    expect(document.querySelector('.tour-cover-meta')?.textContent).toBe('touches: schema')
    // The header names the change, its author, and its branch; the cover does not again.
    expect(document.querySelector('.tour-eyebrow')).toBeNull()
    expect(document.querySelector('[data-nav="next"]')?.textContent).toBe('start the tour')
    const back = bundleWith({ step: 3 })
    const tour = { ...tourOf(back), guide: 'docs/pr-tour.md', blastRadius: [] }
    document.body.innerHTML = coverHtml({ ...back, tour, options: { ...back.options, finalQuiz: 'off' } })
    expect(document.querySelector('[data-nav="next"]')?.textContent).toBe('continue the tour')
    expect(document.querySelector('.tour-cover-meta')).toBeNull()
    const finished = bundleWith({
      finished: { at: 'x', promptPath: '/p', prompt: 'p', sharing: { status: 'off' } },
    })
    document.body.innerHTML = coverHtml({ ...finished, pr: { ...finished.pr, url: '' } })
    expect(document.body.textContent).toContain('You finished this tour')
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
  it('draws the prose, the scene host, the chips, the note, and the code closed', () => {
    const bundle = bundleWith({ notes: { sum: 'hm <b>' } })
    const steps = stepsOf(bundle)
    const sum = tourOf(bundle).landmarks[2]
    if (sum === undefined) {
      throw new Error('no landmark')
    }
    document.body.innerHTML = landmarkHtml(bundle, steps, sum)
    // The strip says which stop and stage this is; the screen does not say it again.
    expect(document.querySelector('.tour-eyebrow')).toBeNull()
    expect(document.querySelector('.tour-frame-host')?.getAttribute('data-kind')).toBe('scene')
    expect(document.querySelector('.tour-frame-host[data-kind="micro"]')).toBeNull()
    expect(document.querySelector('.tour-chip')?.textContent).toBe('one decision waits here')
    expect(document.querySelector('.tour-chip.link')?.getAttribute('data-decision')).toBe('sum-over-product')
    expect(document.querySelector('textarea[data-act="note"]')?.textContent).toBe('hm <b>')
    expect(document.querySelector('.tour-code')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('[data-act="code"]')?.textContent).toContain('code behind this landmark')
    // The tabs are drawn with the code, hidden with it.
    expect(document.querySelector('.tour-code-tabs')).not.toBeNull()
  })

  it('opens the code in the literate view, or the raw one', () => {
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

  it('links each file to the forge at the commit the tour reads, and local work to nothing', () => {
    const bundle = bundleWith()
    const { headSha, repo } = tourOf(bundle)
    const link = fileLinker(bundle)
    const at = `https://github.com/${repo.owner}/${repo.name}/blob`
    expect(link({ path: 'src/b.ts', diff: '@@ -3,2 +5,4 @@ run\n+x' })).toBe(`${at}/${headSha}/src/b.ts#L5`)
    // A removed file is gone at the head, so it opens where it last lived.
    expect(link({ path: 'src/old.ts', diff: '@@ -1,3 +0,0 @@\n-a' })).toBe(
      `${at}/${bundle.pr.mergeBaseSha}/src/old.ts#L1`
    )
    document.body.innerHTML = chunkHtml({ path: 'src/b.ts', diff: '@@ -1 +1 @@\n+x' }, link)
    expect(document.querySelector('.tour-file-link')?.getAttribute('aria-label')).toBe(
      'Open src/b.ts on GitHub'
    )
    expect(document.querySelector('.tour-file-link')?.getAttribute('target')).toBe('_blank')
    const local = { ...bundle, pr: { ...bundle.pr, url: '' } }
    expect(fileLinker(local)({ path: 'src/b.ts', diff: '' })).toBeNull()
    document.body.innerHTML = chunkHtml({ path: 'src/b.ts', diff: '' })
    expect(document.querySelector('.tour-file-link')).toBeNull()
  })
})

describe('decisionHtml', () => {
  it('marks the side the tour recommends, keep or the alternative', () => {
    const bundle = bundleWith()
    const decision = tourOf(bundle).decisions[0]
    if (decision === undefined) {
      throw new Error('no decision')
    }
    const recommended = () =>
      [...document.querySelectorAll('.tour-option[data-recommended]')].map(o => o.getAttribute('data-pick'))
    document.body.innerHTML = decisionHtml(bundle, stepsOf(bundle), decision)
    expect(recommended()).toEqual(['keep'])
    document.body.innerHTML = decisionHtml(bundle, stepsOf(bundle), { ...decision, recommended: 'change' })
    expect(recommended()).toEqual(['change'])
    expect(document.querySelector('[data-pick="change"] .rec')?.textContent).toBe('the tour recommends')
  })

  it('shows a bare try-it command as code, and a step in words as prose with code in it', () => {
    expect(tryItStepHtml('pnpm install')).toBe('<li><code>pnpm install</code></li>')
    expect(tryItStepHtml('Open `/review/68` and pick layer 1')).toBe(
      '<li>Open <code class="nw">/review/68</code> and pick layer 1</li>'
    )
  })

  it('offers three options with nothing chosen', () => {
    const bundle = bundleWith({ notes: { sum: 'my note' } })
    const decision = tourOf(bundle).decisions[0]
    if (decision === undefined) {
      throw new Error('no decision')
    }
    document.body.innerHTML = decisionHtml(bundle, stepsOf(bundle), decision)
    expect(document.querySelector('.tour-stage-tag')).toBeNull()
    expect(document.querySelector('.tour-eyebrow a')?.textContent).toBe('from landmark 3: Sum, not product')
    expect([...document.querySelectorAll('.tour-option')].map(o => o.getAttribute('data-pick'))).toEqual([
      'keep',
      'change',
      'other',
    ])
    expect(
      [...document.querySelectorAll('.tour-option-k > span:first-child')].map(s => s.textContent)
    ).toEqual(['keep', 'alternative', 'something else'])
    expect(document.querySelector('.tour-option[aria-checked="true"]')).toBeNull()
    expect(document.querySelector('.tour-option .now')?.textContent).toBe('· what the code does')
    expect(document.querySelector('[data-pick="other"] .tour-option-l')?.textContent).toBe(
      'Say what you want instead'
    )
    expect(document.querySelector('.tour-landmark-note')?.textContent).toContain('my note')
    expect(document.querySelector('.tour-actions .tour-hint')?.textContent).toBe(
      'pick one: k keep · a alternative · c something else'
    )
    expect(document.querySelector('.tour-tryit')).toBeNull()
    expect(document.querySelector('.tour-anchor')?.textContent).toBe('src/app.ts:4')
  })

  it('shows something else being talked through, a settled keep, the alternative, a settled change, and a try-it recipe', () => {
    const bundle = bundleWith({ picks: { 'sum-over-product': { pick: 'other', approved: false } } })
    const steps = stepsOf(bundle)
    const decision = tourOf(bundle).decisions[0]
    if (decision === undefined) {
      throw new Error('no decision')
    }
    document.body.innerHTML = decisionHtml(bundle, steps, decision)
    expect(document.querySelector('.tour-option[aria-checked="true"]')?.getAttribute('data-pick')).toBe(
      'other'
    )
    expect(document.querySelector('[data-act="grill"]')?.textContent).toContain('continue the conversation')
    // A side picked and taken back is not chosen.
    bundle.reader.picks['sum-over-product'] = { pick: 'change', approved: false }
    document.body.innerHTML = decisionHtml(bundle, steps, decision)
    expect(document.querySelector('.tour-option[aria-checked="true"]')).toBeNull()
    bundle.reader.picks['sum-over-product'] = { pick: 'change', approved: true }
    document.body.innerHTML = decisionHtml(bundle, steps, decision)
    expect(document.querySelector('.tour-option[aria-checked="true"]')?.getAttribute('data-pick')).toBe(
      'change'
    )
    expect(document.querySelector('.tour-state.change')?.textContent).toBe('✓ alternative · in the plan')
    bundle.reader.picks['sum-over-product'] = { pick: 'keep', approved: true, tried: true }
    const withTry = {
      ...decision,
      landmark: 'nope',
      tryIt: { steps: ['pnpm start'], look: ['the sum'], verified: true },
    }
    document.body.innerHTML = decisionHtml(bundle, steps, withTry)
    expect(document.querySelector('.tour-state')?.textContent).toBe('✓ kept')
    expect(document.querySelector('[data-act="unsettle"]')).not.toBeNull()
    expect(document.querySelector('.tour-tryit ol code')?.textContent).toBe('pnpm start')
    expect(document.querySelector('.tour-tryit .tour-card-h')?.textContent).toContain('verified')
    expect(document.querySelector('input[data-act="tried"]')?.hasAttribute('checked')).toBe(true)
    expect(document.querySelector('.tour-eyebrow a')).toBeNull()
    bundle.reader.picks['sum-over-product'] = {
      pick: 'other',
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
          pick: 'other',
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
    expect(document.querySelector('[data-act="confirm"]')?.textContent).toBe('confirm the plan')
    expect(document.querySelector('.tour-not li .path')?.textContent).toBe('src/new-name.ts')
  })

  it("lists the tour's alternative as a change with nothing said to stay", () => {
    const bundle = bundleWith({ picks: { 'sum-over-product': { pick: 'change', approved: true } } })
    document.body.innerHTML = planHtml(bundle)
    expect(document.querySelector('.tour-title')?.textContent).toBe('1 change to make, 0 kept')
    const item = document.querySelector('.tour-plan-list li')
    expect(item?.textContent).toContain('Product. Grows faster; the spec would have to change.')
    expect(item?.querySelectorAll('.where')).toHaveLength(1)
  })

  it('says nothing to change, and hides the record line when nothing is shared', () => {
    const bundle = bundleWith({ picks: { 'sum-over-product': { pick: 'keep', approved: true } } })
    document.body.innerHTML = planHtml({ ...bundle, shares: false })
    expect(document.querySelector('.tour-title')?.textContent).toBe('Nothing to change. 1 decision kept.')
    expect(document.querySelector('.tour-lead')?.textContent).not.toContain('shared')
    expect(document.querySelector('.tour-kept li')?.textContent).toBe(
      'SumWhat the spec says; a product reads the same at the call site.'
    )
    expect(document.querySelector('.tour-hint')?.textContent).toBe('writes the prompt')
    document.body.innerHTML = planHtml({ ...bundle, preview: true })
    expect(document.querySelector('[data-act="confirm"]')).toBeNull()
    expect(document.querySelector('.tour-actions')).toBeNull()
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
    // What went into a reviewer's pending review.
    const withQueued = finished({ status: 'off' })
    const done = /** @type {import('../contract-types.js').TourFinished} */ (withQueued.reader.finished)
    withQueued.reader.finished = { ...done, queued: 1 }
    document.body.innerHTML = planHtml(withQueued)
    expect(document.querySelector('.tour-sharing')?.textContent).toContain(
      '1 change request added to your pending review'
    )
    withQueued.reader.finished = { ...done, queued: 0 }
    document.body.innerHTML = planHtml(withQueued)
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
  it('lists every landmark on the cover, names the model, and skips what is empty', () => {
    const bundle = bundleWith()
    const tour = tourOf(bundle)
    const noWorld = {
      ...tour,
      landmarks: tour.landmarks.map(l =>
        l.stage === 'world' ? { ...l, stage: /** @type {const} */ ('why') } : l
      ),
      generator: { ...tour.generator, model: 'opus' },
      notToured: [],
    }
    document.body.innerHTML = coverHtml({ ...bundle, tour: noWorld })
    expect([...document.querySelectorAll('.tour-agenda-stage')].map(s => s.textContent)).toEqual([
      'Before this change',
      'Why',
      'Why',
      'What to respect',
    ])
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
    document.body.innerHTML = stripHtml(bundle, stepsOf(bundle), 5)
    expect(document.querySelector('.tour-strip-what')?.textContent).toBe('Trade-off')
    const oddBundle = { ...bundle, tour: { ...tour, decisions: [odd] } }
    document.body.innerHTML = stripHtml(oddBundle, stepsOf(oddBundle), 5)
    expect(document.querySelector('.tour-strip-what')?.textContent).toBe('other')
    const changed = bundleWith({
      picks: {
        'sum-over-product': {
          pick: 'other',
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
  it('offers the tour as a zip in the header, and a drop zone for a shared one on a PR with none', () => {
    document.body.innerHTML = tourHeaderHtml(bundleWith(), LOOK)
    expect(document.querySelector('#export-zip')?.getAttribute('title')).toBe(
      'Download this tour as a zip to share on GitHub'
    )
    document.body.innerHTML = tourHeaderHtml({ ...bundleWith(), preview: true }, LOOK)
    expect(document.querySelector('#export-zip')).toBeNull()
    document.body.innerHTML = tourHeaderHtml(missingTourBundle(), LOOK)
    expect(document.querySelector('#export-zip')).toBeNull()

    document.body.innerHTML = missingHtml(missingTourBundle())
    expect(document.querySelector('label.drop')?.textContent).toContain('Drop a tour zip here')
    document.body.innerHTML = missingHtml(missingTourBundle({ local: 'branch' }))
    expect(document.querySelector('label.drop')).toBeNull()
    expect(document.querySelector('#fetch-shared')).toBeNull()
    document.body.innerHTML = missingHtml(missingTourBundle())
    expect(document.querySelector('#fetch-shared')?.textContent).toBe('look for a shared tour')
    const stale = /** @type {const} */ ({
      tourHeadSha: 'a'.repeat(40),
      currentHeadSha: 'c'.repeat(40),
      relation: 'unrelated',
    })
    expect(staleBarHtml({ ...bundleWith(), stale })).toContain('id="fetch-shared"')
    expect(staleBarHtml({ ...bundleWith(), stale, local: 'branch' })).not.toContain('fetch-shared')
  })

  it('offers no generate command to a reader tour.generate leaves out, and says why to a non-author', () => {
    const chat = { enabled: true, acpx: true, agent: 'claude', model: null }
    document.body.innerHTML = missingHtml(missingTourBundle({ chat, generate: 'not-author' }))
    expect(document.querySelector('#generate-start')).toBeNull()
    expect(document.body.textContent).toContain('Only the author generates the tour here')
    document.body.innerHTML = missingHtml(missingTourBundle({ chat, generate: 'off' }))
    expect(document.querySelector('#generate-start')).toBeNull()
    expect(document.body.textContent).not.toContain('Only the author')
    document.body.innerHTML = tourHeaderHtml({ ...bundleWith(), chat, generate: 'not-author' }, LOOK)
    expect(document.querySelector('#regenerate')).toBeNull()
  })

  it('offers to generate the tour where an agent runs, and only the skill command where none does', () => {
    const chat = { enabled: true, acpx: true, agent: 'claude', model: null }
    document.body.innerHTML = missingHtml(missingTourBundle({ chat }))
    expect(document.querySelector('#generate-start')?.textContent).toBe('generate tour')
    expect(document.querySelector('button[data-copy]')?.getAttribute('data-copy')).toBe('/pr-tour 42')
    document.body.innerHTML = missingHtml(missingTourBundle({ chat, preview: true }))
    expect(document.querySelector('#generate-start')).toBeNull()
    document.body.innerHTML = missingHtml(missingTourBundle())
    expect(document.querySelector('#generate-start')).toBeNull()

    const stale = {
      ...bundleWith(),
      chat,
      stale: /** @type {const} */ ({
        tourHeadSha: 'a'.repeat(40),
        currentHeadSha: 'c'.repeat(40),
        relation: 'unrelated',
      }),
    }
    document.body.innerHTML = staleBarHtml(stale)
    expect(document.querySelector('#stale-generate')?.textContent).toBe('update the tour')
    expect(staleBarHtml({ ...stale, chat: { enabled: false, acpx: false } })).not.toContain('stale-generate')

    document.body.innerHTML = tourHeaderHtml({ ...bundleWith(), chat }, LOOK)
    expect(document.querySelector('#regenerate')?.textContent).toBe('regenerate')
    expect(document.querySelector('#regenerate')?.getAttribute('title')).toBe(
      'Generate the tour of this PR again'
    )
    document.body.innerHTML = tourHeaderHtml(bundleWith(), LOOK)
    expect(document.querySelector('#regenerate')).toBeNull()
  })

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
    expect(unrelated).toContain('which is not in this branch any more')
    expect(ancestor).toContain('<strong>Tour is outdated.</strong>')
    expect(
      staleBarHtml({
        ...bundle,
        local: 'branch',
        stale: { tourHeadSha: 'a'.repeat(40), currentHeadSha: 'c'.repeat(40), relation: 'unrelated' },
      })
    ).toContain('your work has moved on to')
    document.body.innerHTML = helpHtml()
    expect(document.querySelectorAll('dt')).toHaveLength(6)
    expect(document.querySelector('[data-act="close-help"]')).not.toBeNull()
  })
})
