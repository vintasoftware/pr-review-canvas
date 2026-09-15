// @ts-check
// @vitest-environment happy-dom
// Header, overview, empty state, and AI Chat shell over the synthetic bundle.
import { emptyState } from '../../src/contract/state.js'
import { UNKNOWN_CAPABILITIES } from '../../src/github/capabilities.js'
import { GH_ISSUE_COMMENTS, syntheticArtifact } from '../../src/testing/synthetic.js'
import { renderChatShell } from './chat.js'
import { renderEmptyState, sharedCanvasCalloutHtml } from './empty-state.js'
import { progressHtml, refreshProgress, renderHeader, riskLineHtml, statePill } from './header.js'
import { conversationHtml, renderOverview, summaryHtml } from './overview.js'

/** @typedef {import('./contract-types.js').PrBundle} PrBundle */

const NOW = new Date('2026-09-10T12:00:00.000Z')

/**
 * @param {{ [K in keyof PrBundle]?: PrBundle[K] | undefined }} [over]
 * @returns {PrBundle}
 */
function bundle(over = {}) {
  const artifact = syntheticArtifact()
  /** @type {PrBundle} */
  const base = {
    status: 'ready',
    pr: artifact.pr,
    files: artifact.files,
    derivable: true,
    artifact,
    canvas: { headSha: artifact.pr.headSha, source: 'local', manifest: null },
    skillCommand: '/pr-review-canvas 42 --force',
    comments: {
      fetchedAt: NOW.toISOString(),
      headSha: artifact.pr.headSha,
      reviewComments: [],
      issueComments: [
        {
          id: 2001,
          author: 'ci-bot[bot]',
          body: 'Coverage 99%',
          createdAt: '2026-09-09T11:00:00Z',
          updatedAt: '2026-09-09T11:00:00Z',
          url: 'u1',
        },
        {
          id: 2002,
          author: 'reviewer',
          body: 'Looks **good**',
          createdAt: '2026-09-09T12:00:00Z',
          updatedAt: '2026-09-09T12:00:00Z',
          url: 'u2',
        },
      ],
    },
    state: emptyState(NOW.toISOString()),
    capabilities: UNKNOWN_CAPABILITIES,
    chat: { enabled: true, acpx: true },
    largePr: false,
    warnings: [],
  }
  const merged = { ...base, ...over }
  for (const key of Object.keys(merged)) {
    if (merged[/** @type {keyof PrBundle} */ (key)] === undefined) {
      delete merged[/** @type {keyof PrBundle} */ (key)]
    }
  }
  return /** @type {PrBundle} */ (merged)
}

describe('header', () => {
  it('renders brand, commands, title, meta, risk line, progress, and the sign-off gate for a ready bundle', () => {
    document.body.innerHTML = renderHeader(bundle(), {
      host: 'localhost:3010',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    const hdr = document.querySelector('header.hdr')
    expect(hdr?.querySelector('.brand .box')?.textContent).toBe('PR review canvas')
    expect([...(hdr?.querySelectorAll('.hdr-actions .cmd') ?? [])].map(b => b.textContent)).toEqual([
      'regenerate',
      'export zip',
      'refresh',
      'settings',
      'help',
      'skin: terminal',
      'theme: auto',
    ])
    // Every header command works on a ready bundle with acpx installed.
    expect([...(hdr?.querySelectorAll('.hdr-actions .cmd:disabled') ?? [])].map(b => b.textContent)).toEqual([])
    // Without acpx there is nothing to configure, so settings is disabled with the reason.
    document.body.innerHTML = renderHeader(bundle({ chat: { enabled: false, acpx: false } }), {
      host: 'localhost:3010',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    const off = document.querySelector('#settings')
    expect(off?.hasAttribute('disabled')).toBe(true)
    expect(off?.getAttribute('title')).toBe('acpx is not installed')
    document.body.innerHTML = renderHeader(bundle(), {
      host: 'localhost:3010',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    expect(hdr?.querySelector('#export-zip')?.hasAttribute('disabled')).toBe(false)
    expect(hdr?.querySelector('#regenerate')?.hasAttribute('disabled')).toBe(false)
    expect(hdr?.querySelector('h1')?.textContent).toBe('#42feat: add b')
    expect(hdr?.querySelector('.title a.cmd')?.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/42')
    expect(hdr?.querySelector('.meta .pill.open')?.textContent).toBe('open')
    expect(hdr?.querySelector('.diffstat')?.textContent).toBe('+7 −5')
    expect(hdr?.querySelector('.pill.agent')?.textContent).toBe('claude · claude-opus-4-1 · claude-code')
    expect(hdr?.querySelector('.touches')?.textContent).toBe('touches:schema')
    expect(hdr?.querySelector('.ptext')?.textContent).toBe('0 of 1 layers reviewed')
    expect(hdr?.querySelector('.pline span')?.getAttribute('style')).toBe('width:0%')
    expect([...(hdr?.querySelectorAll('.signoff .cmd') ?? [])].map(b => b.textContent)).toEqual([
      'approve on github',
      'request changes',
    ])
    // Approve waits for every layer; request changes is allowed at any time.
    expect([...(hdr?.querySelectorAll('.signoff .cmd:disabled') ?? [])].map(b => b.textContent)).toEqual([
      'approve on github',
    ])
    expect(hdr?.querySelector('#approve')?.getAttribute('title')).toBe('1 layer is not reviewed yet: Run path')
    expect(hdr?.querySelector('.stripe')).not.toBeNull()
    // A normal change set says nothing about caps.
    expect(hdr?.querySelector('.notice.large-pr')).toBeNull()
  })

  it('says the canvas was capped when the change set is large, on every screen', () => {
    document.body.innerHTML = renderHeader(bundle({ largePr: true }), {
      host: 'h',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    expect(document.querySelector('.notice.large-pr')?.textContent).toBe(
      'Large change set: the canvas keeps at most 6 annotations per file and 12 attention points, ' +
        'and diffs were not inlined for the generator.'
    )
    document.body.innerHTML = renderHeader(bundle({ largePr: true, status: 'missing', artifact: undefined }), {
      host: 'h',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    expect(document.querySelector('.notice.large-pr')).not.toBeNull()
  })

  it('omits the agent pill, risk line, and progress when there is no canvas', () => {
    document.body.innerHTML = renderHeader(bundle({ status: 'missing', artifact: undefined }), {
      host: 'h',
      theme: 'dark',
      skin: 'github',
      now: NOW,
    })
    expect(document.querySelector('.pill.agent')).toBeNull()
    expect(document.querySelector('#regenerate')?.hasAttribute('disabled')).toBe(true)
    expect(document.querySelector('.touches')).toBeNull()
    expect(document.querySelector('.progress')).toBeNull()
    expect(document.querySelector('#theme-toggle')?.textContent).toBe('theme: dark')
    expect(document.querySelector('#skin-toggle')?.textContent).toBe('skin: github')
  })

  it('shows draft, merged, and reviewed progress', () => {
    const pr = syntheticArtifact().pr
    expect(statePill({ ...pr, draft: true })).toBe('<span class="pill draft">draft</span>')
    expect(statePill({ ...pr, state: 'merged' })).toBe('<span class="pill merged">merged</span>')
    expect(riskLineHtml([])).toBe('')
    expect(riskLineHtml([{ label: 'auth', source: 'model', reason: 'touches tokens' }])).toBe(
      '<p class="touches"><span>touches:</span><span class="pill risk model" title="touches tokens">auth</span></p>'
    )
    const state = { ...emptyState('x'), reviewed: { 'layer:layer-1': /** @type {const} */ (true) } }
    document.body.innerHTML = renderHeader(bundle({ state }), { host: 'h', theme: 'auto', skin: 'terminal', now: NOW })
    expect(document.querySelector('.ptext')?.textContent).toBe('1 of 1 layers reviewed')
    const artifact = syntheticArtifact()
    artifact.generator = { agent: 'codex', harness: 'codex', attempts: 1 }
    document.body.innerHTML = renderHeader(bundle({ artifact }), {
      host: 'h',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    expect(document.querySelector('.pill.agent')?.textContent).toBe('codex · codex')
  })

  it('redraws the line, its text, and the approve gate from the state', () => {
    const artifact = syntheticArtifact()
    const base = emptyState('x')
    document.body.innerHTML = `<div id="root">${progressHtml(artifact, base)}<nav class="rail"></nav></div>`
    const root = document.querySelector('#root')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    expect(root.querySelector('#approve')?.hasAttribute('disabled')).toBe(true)
    const done = { ...base, reviewed: { 'layer:layer-1': /** @type {const} */ (true) } }
    expect(refreshProgress(root, artifact, done)).toEqual({ done: 1, total: 1, percent: 100 })
    expect(root.querySelector('.ptext')?.textContent).toBe('1 of 1 layers reviewed')
    expect(root.querySelector('.pline')?.getAttribute('aria-valuenow')).toBe('1')
    expect(root.querySelector('.pline span')?.getAttribute('style')).toContain('100%')
    const approve = root.querySelector('#approve')
    expect(approve?.hasAttribute('disabled')).toBe(false)
    expect(approve?.getAttribute('title')).toBe('Write and preview an approving review on GitHub')
    expect(root.querySelector('.tree')).not.toBeNull()
    // Marking it open again puts the gate and its reason back.
    refreshProgress(root, artifact, base)
    expect(root.querySelector('#approve')?.getAttribute('title')).toBe('1 layer is not reviewed yet: Run path')
  })

  it('changes nothing on a page that has no progress line', () => {
    document.body.innerHTML = '<div id="bare"></div>'
    const root = document.querySelector('#bare')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    expect(refreshProgress(root, syntheticArtifact(), emptyState('x'))).toEqual({ done: 0, total: 1, percent: 0 })
  })
})

describe('overview', () => {
  const paths = new Set(['src/app.ts'])

  it('renders the summary as one prose block with its links, headings demoted', () => {
    document.body.innerHTML = summaryHtml(syntheticArtifact().summary, paths)
    expect(document.querySelector('.summary.prose a[href="#hunk:src/app.ts#1"]')?.textContent).toBe('app.ts')
    expect(summaryHtml('plain summary', paths)).toBe('<div class="summary prose"><p>plain summary</p>\n</div>')
    document.body.innerHTML = summaryHtml('## Heading\n\nbody', paths)
    expect(document.querySelector('.summary h4')?.textContent).toBe('Heading')
  })

  it('renders the conversation with bots collapsed and a comment command', () => {
    document.body.innerHTML = conversationHtml(bundle().comments.issueComments, NOW)
    expect(document.querySelector('h3.lbl.sub')?.textContent).toBe('Conversation · 2')
    expect(document.querySelector('.cmt .who b')?.textContent).toBe('reviewer')
    expect(document.querySelector('.cmt .prose strong')?.textContent).toBe('good')
    expect(document.querySelector('details.bots summary .chev + span')?.textContent).toBe('1 bot comment')
    expect(document.querySelector('details.bots summary > .chev')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('details.bots')?.hasAttribute('open')).toBe(false)
    expect(document.querySelector('details.bots summary .cmd')).toBeNull()
    expect(document.querySelector('button.cmd[data-act="pr-comment"]')?.textContent).toBe('comment')
    document.body.innerHTML = conversationHtml([], NOW)
    expect(document.querySelector('p.muted')?.textContent).toBe('No PR-level comments yet.')
    document.body.innerHTML = conversationHtml(
      GH_ISSUE_COMMENTS.map(c => ({
        id: c.id,
        author: c.user.login,
        body: c.body ?? '',
        createdAt: c.created_at,
        updatedAt: c.created_at,
        url: c.html_url,
      })),
      NOW
    )
    expect(document.querySelector('details.bots summary .chev + span')?.textContent).toBe('1 bot comment')
    const two = bundle().comments.issueComments.map(c => ({ ...c, author: 'x[bot]' }))
    document.body.innerHTML = conversationHtml(two, NOW)
    expect(document.querySelector('details.bots summary .chev + span')?.textContent).toBe('2 bot comments')
  })

  it('assembles the overview panel with the sevsum linking to layers, description, and conversation, and no point cards', () => {
    document.body.innerHTML = renderOverview(bundle(), { paths, now: NOW })
    const panel = document.querySelector('section.panel#overview')
    expect(panel?.querySelector('.panel-h h2')?.textContent).toBe('Overview')
    expect([...(panel?.querySelectorAll('.sevsum > a') ?? [])].map(a => a.getAttribute('href'))).toEqual([
      '#layer-run-path',
      '#layer-other',
      '#layer-other',
    ])
    expect(panel?.querySelector('.findings')).toBeNull()
    expect(panel?.querySelector('.lbl.sub')?.textContent).toBe('Conversation · 2')
    expect(panel?.querySelector('details.pr-desc summary .chev + span')?.textContent).toBe(
      'PR description (from GitHub)'
    )
    expect(panel?.querySelector('details.pr-desc summary > .chev')?.getAttribute('aria-expanded')).toBe('false')
    expect(panel?.querySelector('details.pr-desc')?.hasAttribute('open')).toBe(false)
    expect(panel?.querySelector('details.pr-desc summary .cmd')).toBeNull()
    expect(panel?.querySelector('details.pr-desc a.loc')?.getAttribute('href')).toBe('#line:src/app.ts:4')
    const noBody = bundle()
    noBody.pr = { ...noBody.pr, body: '  ' }
    document.body.innerHTML = renderOverview(noBody, { paths, now: NOW })
    expect(document.querySelector('.pr-desc.muted')?.textContent).toBe('No PR description.')
    document.body.innerHTML = renderOverview(bundle({ artifact: undefined }), { paths, now: NOW })
    expect(document.querySelector('.summary')).toBeNull()
    expect(document.querySelector('.sevsum')).toBeNull()
  })
})

describe('empty state', () => {
  it('shows the skill command with one filled copy command, a live drop zone, and no callout', () => {
    document.body.innerHTML = renderEmptyState(
      bundle({ status: 'missing', artifact: undefined, skillCommand: '/pr-review-canvas 42' })
    )
    expect(document.querySelector('.cmdbox code')?.textContent).toBe('/pr-review-canvas 42')
    const copy = document.querySelector('.cmdbox .cmd.fill')
    expect(copy?.textContent).toBe('copy')
    expect(copy?.getAttribute('data-copy')).toBe('/pr-review-canvas 42')
    expect(document.querySelectorAll('.cmd.fill').length).toBe(1)
    expect(document.querySelector('.drop input')?.hasAttribute('disabled')).toBe(false)
    expect(document.querySelector('.callout')).toBeNull()
  })

  it('renders the shared-canvas callout in both states', () => {
    const shared = {
      url: 'https://github.com/x.zip',
      name: 'pr-review-canvas-acme-widgets-pr42-aaaaaaa.zip',
      matchesHead: true,
      downloadable: true,
    }
    expect(sharedCanvasCalloutHtml(bundle({ sharedCanvas: shared }))).toContain('importing&hellip;')
    const failed = sharedCanvasCalloutHtml(
      bundle({ sharedCanvas: { ...shared, downloadable: false, reason: 'auth-required' } })
    )
    expect(failed).toContain('callout warn')
    expect(failed).toContain('auth-required')
    expect(failed).toContain('id="fetch-shared"')
    expect(sharedCanvasCalloutHtml(bundle({ sharedCanvas: { ...shared, downloadable: false } }))).toContain('(unknown)')
    expect(sharedCanvasCalloutHtml(bundle())).toBe('')
  })
})

describe('chat shell', () => {
  it('renders the live pane, or nothing when chat is off', () => {
    document.body.innerHTML = renderChatShell({ enabled: true })
    const aside = document.querySelector('aside.chat')
    expect(aside?.querySelector('.chat-h h2')?.textContent).toBe('AI Chat')
    expect(aside?.querySelector('.handle')?.getAttribute('aria-label')).toBe('Resize AI Chat')
    expect(aside?.querySelector('.transcript .empty')?.textContent).toMatch(/^Ask AI Chat about/)
    expect(aside?.querySelector('select')?.hasAttribute('disabled')).toBe(false)
    expect(aside?.querySelector('.ctx-line')?.textContent).toBe('Context: whole PR clear')
    expect(aside?.querySelector('textarea')?.hasAttribute('disabled')).toBe(false)
    expect(aside?.querySelector('.chat-composer .cmd.fill')?.textContent).toBe('send')
    expect(aside?.querySelectorAll('button:disabled').length).toBe(0)
    expect(renderChatShell({ enabled: false })).toBe('')
  })
})
