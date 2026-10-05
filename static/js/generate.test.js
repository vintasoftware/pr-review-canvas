// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyState } from '../../src/contract/state.js'
import { UNKNOWN_CAPABILITIES } from '../../src/host/capabilities.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import {
  createGeneration,
  elapsedText,
  GENERATE_DIALOG_ID,
  generationMode,
  generationStartHtml,
  generationStatusHtml,
  isRunning,
  runningLabel,
} from './generate.js'

/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').GenerationJob} GenerationJob */

const NOW = new Date('2026-10-05T12:03:12.000Z')

/**
 * @param {Partial<PrBundle>} [over]
 * @returns {PrBundle}
 */
function bundle(over = {}) {
  const artifact = syntheticArtifact()
  return {
    status: 'missing',
    pr: artifact.pr,
    files: artifact.files,
    derivable: true,
    skillCommand: '/pr-review-canvas 42',
    comments: { fetchedAt: 'x', headSha: artifact.pr.headSha, reviewComments: [], issueComments: [] },
    state: emptyState('x'),
    capabilities: UNKNOWN_CAPABILITIES,
    chat: { enabled: true, acpx: true, agent: 'claude', model: null },
    largePr: false,
    selfReview: false,
    mentionCanvas: true,
    canvasComment: true,
    warnings: [],
    ...over,
  }
}

/**
 * @param {Partial<GenerationJob>} [over]
 * @returns {GenerationJob}
 */
function job(over = {}) {
  return {
    key: 42,
    force: false,
    agent: 'claude',
    model: 'opus',
    phase: 'generating',
    round: 1,
    maxRounds: 4,
    startedAt: '2026-10-05T12:00:00.000Z',
    activity: [],
    ...over,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('helpers', () => {
  it('tells a running job from an ended one', () => {
    expect(isRunning({ phase: 'repairing' })).toBe(true)
    for (const phase of /** @type {const} */ (['done', 'failed', 'cancelled'])) {
      expect(isRunning({ phase })).toBe(false)
    }
  })

  it('writes how long a job ran', () => {
    expect(elapsedText(job(), NOW)).toBe('3m 12s')
    expect(elapsedText(job({ endedAt: '2026-10-05T12:00:09.000Z' }), NOW)).toBe('9s')
    expect(elapsedText(job({ startedAt: '2026-10-05T12:05:00.000Z' }), NOW)).toBe('0s')
  })
})

describe('generationMode', () => {
  it('generates the first canvas, with no earlier canvas to choose to update', () => {
    expect(generationMode(bundle())).toEqual({
      label: 'generate',
      title: 'Generate a canvas for this PR',
      heading: 'Generate the canvas',
      text: 'The agent reads the diff and writes the canvas. It usually takes several minutes.',
      blank: false,
      choice: false,
    })
    expect(generationMode(bundle({ local: 'branch' })).title).toBe('Generate a canvas for this local work')
  })

  it('updates an outdated canvas, with a blank page as the choice', () => {
    expect(generationMode(bundle({ status: 'stale' }))).toMatchObject({
      label: 'update',
      heading: 'Update the canvas',
      blank: false,
      choice: true,
    })
  })

  it('regenerates a ready canvas from a blank page, with a choice only for a carried-over one', () => {
    expect(generationMode(bundle({ status: 'ready' }))).toMatchObject({
      label: 'regenerate',
      heading: 'Regenerate the canvas',
      blank: true,
      choice: false,
    })
    const carried = { canvasHeadSha: 'c'.repeat(40), currentHeadSha: 'd'.repeat(40) }
    expect(generationMode(bundle({ status: 'ready', carriedOver: carried }))).toMatchObject({
      blank: true,
      choice: true,
    })
  })
})

describe('generationStartHtml', () => {
  it('names the agent, the sharing, the skill command, and the start command', () => {
    document.body.innerHTML = generationStartHtml(bundle())
    expect(document.querySelector('h2')?.textContent).toBe('Generate the canvas')
    expect(document.body.textContent).toContain('claude')
    expect(document.body.textContent).toContain('shares the canvas as a comment on the pull request')
    expect(document.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe('/pr-review-canvas 42')
    expect(document.querySelector('[data-gen="start"]')).not.toBeNull()
    expect(document.querySelector('input[name="force"]')).toBeNull()
  })

  it('says nothing is posted when sharing is off, and offers the blank page on an outdated canvas', () => {
    document.body.innerHTML = generationStartHtml(
      bundle({ status: 'stale', canvasComment: false, chat: { enabled: true, acpx: true } })
    )
    expect(document.body.textContent).toContain('nothing is posted')
    expect(document.body.textContent).toContain('the chat agent')
    const box = document.querySelector('input[name="force"]')
    expect(box instanceof HTMLInputElement && box.checked).toBe(false)
  })

  it('calls a local review a review', () => {
    expect(generationStartHtml(bundle({ local: 'branch' }))).toContain('comment on the review')
  })
})

describe('generationStatusHtml', () => {
  it('shows a running job with its activity, attempt, and stop command', () => {
    document.body.innerHTML = generationStatusHtml(
      job({
        phase: 'repairing',
        round: 2,
        activity: ['Read a.ts', 'Read <b>.ts'],
        problems: ['HUNK_UNASSIGNED x'],
      }),
      NOW
    )
    expect(document.querySelector('h2')?.textContent).toBe('The agent is fixing what publish rejected')
    expect(document.querySelector('.gen-meta')?.textContent).toBe('claude (opus) · 3m 12s · attempt 2 of 4')
    expect([...document.querySelectorAll('.gen-activity li')].map(li => li.textContent)).toEqual([
      'Read a.ts',
      'Read <b>.ts',
    ])
    expect(document.querySelector('.gen-problems')?.hasAttribute('open')).toBe(false)
    expect(document.querySelector('[data-gen="stop"]')?.hasAttribute('disabled')).toBe(false)
    expect(document.querySelector('[data-gen="again"]')).toBeNull()
  })

  it('shows a stopping job with its stop disabled', () => {
    document.body.innerHTML = generationStatusHtml(job({ stopping: true, model: null }), NOW)
    expect(document.querySelector('h2')?.textContent).toBe('Stopping…')
    expect(document.querySelector('.gen-meta')?.textContent).toBe('claude · 3m 12s')
    expect(document.querySelector('[data-gen="stop"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('shows a failed job with its error, open problems, and try again', () => {
    document.body.innerHTML = generationStatusHtml(
      job({
        phase: 'failed',
        endedAt: '2026-10-05T12:01:00.000Z',
        problems: ['A', 'B'],
        error: { code: 'MODEL_INVALID', message: 'rejected', hint: 'run the skill' },
      }),
      NOW
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('rejected — run the skill')
    expect(document.querySelector('.gen-problems summary')?.textContent).toBe('2 problems publish named')
    expect(document.querySelector('.gen-problems')?.hasAttribute('open')).toBe(true)
    expect(document.querySelector('[data-gen="again"]')).not.toBeNull()
    expect(document.querySelector('[data-gen="stop"]')).toBeNull()
  })

  it('says what publish did with the canvas of a done job', () => {
    const done = job({ phase: 'done', sharing: { status: 'local' } })
    expect(
      generationStatusHtml({ ...done, sharing: { status: 'shared', url: 'https://x/c' } }, NOW)
    ).toContain('href="https://x/c"')
    expect(generationStatusHtml({ ...done, sharing: { status: 'off' } }, NOW)).toContain(
      'Sharing is off, so nothing was posted.'
    )
    expect(generationStatusHtml(done, NOW)).toContain('The canvas is published.')
    expect(generationStatusHtml(done, NOW)).not.toContain('data-gen="again"')
  })

  it('shows a failed share with the warning publish wrote, once, and where the ZIP is', () => {
    // The warning as publish writes it (src/canvas/share.ts), which already says to upload the ZIP.
    const warning =
      'Automatic canvas sharing failed: gh: Not Found (HTTP 404). Upload the ZIP to the pull request description manually.'
    document.body.innerHTML = generationStatusHtml(
      job({ phase: 'done', sharing: { status: 'failed', warning, zipPath: '/x/c.zip' } }),
      NOW
    )
    expect(document.querySelector('.callout')?.textContent).toBe(`${warning} The ZIP: /x/c.zip`)
  })

  it('labels the header command with the running job', () => {
    expect(runningLabel(job(), NOW)).toBe('generating · 3m 12s')
    expect(runningLabel(job({ stopping: true }), NOW)).toBe('stopping · 3m 12s')
  })
})

/**
 * A fetch that answers from a list of jobs: each GET answers the next one, POST and DELETE what
 * the test sets.
 * @param {{ gets: Array<GenerationJob | null>, post?: () => Response, del?: () => Response }} script
 */
function fakeFetch(script) {
  /** @type {Array<{ method: string, url: string, body: unknown }>} */
  const calls = []
  let i = 0
  /** @type {typeof fetch} */
  const impl = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url: String(url),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    if (method === 'POST' && script.post) {
      return script.post()
    }
    if (method === 'DELETE' && script.del) {
      return script.del()
    }
    const next = script.gets[Math.min(i, script.gets.length - 1)] ?? null
    i += 1
    return new Response(JSON.stringify({ job: next }), { status: 200 })
  }
  return { impl, calls }
}

function page() {
  const root = document.createElement('div')
  root.innerHTML =
    '<header><div class="hdr-actions"><button id="regenerate">regenerate</button></div></header>'
  document.body.appendChild(root)
  return root
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('createGeneration', () => {
  it('starts a job from the dialog, polls it, and reports its end once', async () => {
    const root = page()
    const running = job()
    const fetches = fakeFetch({
      gets: [null, running, job({ phase: 'done', sharing: { status: 'local' }, endedAt: NOW.toISOString() })],
      post: () => new Response(JSON.stringify({ job: job({ phase: 'preparing' }) }), { status: 202 }),
    })
    const onEnded = vi.fn()
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded,
      fetchImpl: fetches.impl,
      now: () => NOW,
      pollMs: 1,
    })
    generation.attach(bundle())
    await flush()
    expect(root.querySelector('#regenerate')?.textContent).toBe('regenerate')

    generation.open(bundle())
    const dialog = root.querySelector(`#${GENERATE_DIALOG_ID}`)
    expect(dialog?.hasAttribute('open')).toBe(true)
    expect(dialog?.querySelector('h2')?.textContent).toBe('Generate the canvas')
    root.querySelector('[data-gen="start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(fetches.calls.find(c => c.method === 'POST')?.body).toEqual({ force: false })
    expect(root.querySelector('#regenerate')?.textContent).toContain('generating')
    expect(root.querySelector('#regenerate')?.classList.contains('gen-running')).toBe(true)
    expect(dialog?.querySelector('h2')?.textContent).toBe('Preparing the diff')

    for (let n = 0; n < 20 && onEnded.mock.calls.length === 0; n++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(onEnded).toHaveBeenCalledTimes(1)
    expect(onEnded.mock.calls[0]?.[0]).toMatchObject({ phase: 'done' })
    // The job ended, so the command has its own label and title back.
    expect(root.querySelector('#regenerate')?.textContent).toBe('regenerate')
    expect(root.querySelector('#regenerate')?.getAttribute('title')).toBe('')
    expect(root.querySelector('#regenerate')?.classList.contains('gen-running')).toBe(false)
    expect(dialog?.querySelector('h2')?.textContent).toBe('Done')
    generation.stop()
  })

  it('sends the blank-page choice the reader ticked', async () => {
    const root = page()
    const fetches = fakeFetch({
      gets: [null],
      post: () =>
        new Response(JSON.stringify({ job: job({ phase: 'done', sharing: { status: 'local' } }) }), {
          status: 202,
        }),
    })
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: fetches.impl,
      now: () => NOW,
    })
    generation.open(bundle({ status: 'stale' }))
    const box = root.querySelector('input[name="force"]')
    if (box instanceof HTMLInputElement) {
      box.checked = true
    }
    root.querySelector('[data-gen="start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(fetches.calls.find(c => c.method === 'POST')?.body).toEqual({ force: true })
    generation.stop()
  })

  it('picks up a job another tab started, shows it on the header command, and stops it', async () => {
    const root = page()
    const fetches = fakeFetch({
      gets: [job({ activity: ['Read a.ts'] })],
      del: () =>
        new Response(JSON.stringify({ cancelled: true, job: job({ stopping: true }) }), { status: 200 }),
    })
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: fetches.impl,
      now: () => NOW,
      pollMs: 60_000,
    })
    generation.attach(bundle())
    await flush()
    const button = root.querySelector('#regenerate')
    expect(button?.textContent).toBe('generating · 3m 12s')
    expect(button?.getAttribute('title')).toBe('Show the canvas generation')

    // A render replaces the header; attaching again puts the job on the new command.
    root.innerHTML = '<header><div class="hdr-actions"><button id="regenerate">update</button></div></header>'
    generation.attach(bundle())
    expect(root.querySelector('#regenerate')?.textContent).toBe('generating · 3m 12s')

    generation.open(bundle())
    const dialog = root.querySelector(`#${GENERATE_DIALOG_ID}`)
    expect(dialog?.hasAttribute('open')).toBe(true)
    expect(dialog?.querySelector('.gen-activity li')?.textContent).toBe('Read a.ts')

    // Opening from a button while a job runs shows that job, not the start screen.
    generation.open(bundle())
    expect(dialog?.querySelector('[data-gen="start"]')).toBeNull()

    root.querySelector('[data-gen="stop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(fetches.calls.some(c => c.method === 'DELETE' && c.url === '/api/prs/42/generate')).toBe(true)
    expect(dialog?.querySelector('h2')?.textContent).toBe('Stopping…')
    expect(root.querySelector('#regenerate')?.textContent).toContain('stopping')
    generation.stop()
  })

  it('reports a refused start and shows the job that refused it', async () => {
    const root = page()
    const fetches = fakeFetch({
      gets: [job()],
      post: () =>
        new Response(JSON.stringify({ error: { code: 'GENERATION_BUSY', message: 'already running' } }), {
          status: 409,
        }),
    })
    const onError = vi.fn()
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      onError,
      fetchImpl: fetches.impl,
      now: () => NOW,
      pollMs: 60_000,
    })
    generation.open(bundle())
    root.querySelector('[data-gen="start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()
    // The job that refused it is the one to follow, so the refusal itself is not shown.
    expect(onError).not.toHaveBeenCalled()
    expect(root.querySelector(`#${GENERATE_DIALOG_ID} h2`)?.textContent).toBe(
      'The agent is writing the canvas'
    )
    generation.stop()
  })

  it('keeps the start screen with the reason and hint when the server refuses a start', async () => {
    const root = page()
    const fetches = fakeFetch({
      gets: [null],
      post: () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'GH_UNAUTHENTICATED',
              message: 'gh is not logged in, so the canvas could not be shared on the PR',
              hint: 'run `gh auth login` in a terminal',
            },
          }),
          { status: 401 }
        ),
    })
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: fetches.impl,
      now: () => NOW,
      pollMs: 60_000,
    })
    generation.open(bundle())
    root.querySelector('[data-gen="start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()
    const dialog = root.querySelector(`#${GENERATE_DIALOG_ID}`)
    expect(dialog?.querySelector('h2')?.textContent).toBe('Generate the canvas')
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe(
      'gh is not logged in, so the canvas could not be shared on the PR — run `gh auth login` in a terminal'
    )
    // The start command is live again, and opening the dialog afresh drops the old reason.
    expect(dialog?.querySelector('[data-gen="start"]')?.hasAttribute('disabled')).toBe(false)
    generation.open(bundle())
    expect(dialog?.querySelector('[role="alert"]')).toBeNull()
    generation.stop()
  })

  it('shows a refusal that came without a hint, or as a plain network failure', async () => {
    const root = page()
    let calls = 0
    /** @type {typeof fetch} */
    const impl = async (_url, init) => {
      if (init?.method === 'POST') {
        calls += 1
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }), {
            status: 500,
          })
        }
        throw new TypeError('network down')
      }
      return new Response(JSON.stringify({ job: null }), { status: 200 })
    }
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: impl,
      now: () => NOW,
    })
    generation.open(bundle())
    root.querySelector('[data-gen="start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('boom')
    root.querySelector('[data-gen="start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('network down')
    generation.stop()
  })

  it('goes back to the start screen from a failed job, and shows the last job on request', async () => {
    const root = page()
    const fetches = fakeFetch({ gets: [job({ phase: 'failed', error: { code: 'INTERNAL', message: 'x' } })] })
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: fetches.impl,
      now: () => NOW,
    })
    generation.attach(bundle())
    await flush()
    generation.showLast()
    const dialog = root.querySelector(`#${GENERATE_DIALOG_ID}`)
    expect(dialog?.querySelector('h2')?.textContent).toBe('Generation failed')
    root.querySelector('[data-gen="again"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(dialog?.querySelector('[data-gen="start"]')).not.toBeNull()
    expect(generation.job?.phase).toBe('failed')
    generation.stop()
  })

  it('ticks the blank page for a carried-over canvas, and ignores clicks on anything else', async () => {
    const root = page()
    const fetches = fakeFetch({ gets: [null] })
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: fetches.impl,
      now: () => NOW,
    })
    generation.open(
      bundle({
        status: 'ready',
        carriedOver: { canvasHeadSha: 'c'.repeat(40), currentHeadSha: 'd'.repeat(40) },
      })
    )
    const box = root.querySelector('input[name="force"]')
    expect(box instanceof HTMLInputElement && box.checked).toBe(true)
    root.querySelector('#regenerate')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    root.dispatchEvent(new MouseEvent('click'))
    expect(fetches.calls).toEqual([])
    generation.stop()
  })

  it('reports a stop the server refused', async () => {
    const root = page()
    const fetches = fakeFetch({
      gets: [job()],
      del: () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'no' } }), { status: 500 }),
    })
    const onError = vi.fn()
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      onError,
      fetchImpl: fetches.impl,
      now: () => NOW,
      pollMs: 60_000,
    })
    generation.attach(bundle())
    await flush()
    generation.showLast()
    root.querySelector('[data-gen="stop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    await flush()
    expect(onError).toHaveBeenCalledWith('no')
    generation.stop()
  })

  it('opens the dialog by its attribute where showModal is missing', () => {
    const root = page()
    const showModal = HTMLDialogElement.prototype.showModal
    // @ts-expect-error: the method is removed to stand for an engine without it
    delete HTMLDialogElement.prototype.showModal
    try {
      const generation = createGeneration(root, { prNumber: 42, onEnded: () => undefined })
      generation.open(bundle())
      expect(root.querySelector(`#${GENERATE_DIALOG_ID}`)?.hasAttribute('open')).toBe(true)
      generation.stop()
    } finally {
      HTMLDialogElement.prototype.showModal = showModal
    }
  })

  it('runs on a screen with no header command, and with the default clock', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const fetches = fakeFetch({ gets: [job()] })
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: fetches.impl,
      pollMs: 60_000,
    })
    generation.attach(bundle())
    await flush()
    expect(generation.job?.phase).toBe('generating')
    expect(root.querySelector('.gen-running')).toBeNull()
    generation.stop()
  })

  it('keeps polling through a failed request', async () => {
    const root = page()
    let calls = 0
    /** @type {typeof fetch} */
    const impl = async () => {
      calls += 1
      if (calls === 2) {
        throw new Error('offline')
      }
      return new Response(JSON.stringify({ job: job() }), { status: 200 })
    }
    const generation = createGeneration(root, {
      prNumber: 42,
      onEnded: () => undefined,
      fetchImpl: impl,
      now: () => NOW,
      pollMs: 1,
    })
    generation.attach(bundle())
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3))
    generation.stop()
  })
})
