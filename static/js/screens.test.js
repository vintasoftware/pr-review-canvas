// @ts-check
// @vitest-environment happy-dom
// Header, overview, empty state, and AI Chat shell over the synthetic bundle.
import { emptyState } from '../../src/contract/state.js'
import { UNKNOWN_CAPABILITIES } from '../../src/host/capabilities.js'
import { mapReviewComment } from '../../src/github/comments.js'
import { GH_ISSUE_COMMENTS, GH_REVIEW_COMMENTS, syntheticArtifact } from '../../src/testing/synthetic.js'
import { renderChatShell } from './chat.js'
import { renderEmptyState, renderStaleState, sharedCanvasCalloutHtml, staleBarHtml } from './empty-state.js'
import { progressHtml, refreshProgress, renderHeader, riskLineHtml, statePill } from './header.js'
import { conversationHtml, renderOverview, summaryHtml } from './overview.js'
import { foldLevelControlHtml, foldLevelHint, refreshFoldLevel } from './reading-level.js'

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
    selfReview: false,
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

describe('review history', () => {
  it('shows outdated threads and their replies below review history, excluding current threads', () => {
    const data = bundle()
    data.comments.reviewComments = GH_REVIEW_COMMENTS.map(comment => mapReviewComment(comment, new Set()))
    const root = data.comments.reviewComments.find(comment => comment.outdated)
    if (!root) throw new Error('Missing outdated fixture')
    data.comments.reviewComments.push({
      ...root,
      id: 9999,
      inReplyToId: root.id,
      body: 'Outdated reply',
      resolved: true,
    })
    data.comments.reviews = [{ ...root, state: 'APPROVED', body: '' }]
    document.body.innerHTML = renderOverview(data, { paths: new Set(), now: NOW })
    const section = document.querySelector('.outdated-comments')
    expect(document.querySelector('.review-history')?.nextElementSibling).toBe(section)
    expect(section?.querySelector('summary')?.textContent).toContain('Outdated comments · 2')
    expect(section?.querySelectorAll('.cmt')).toHaveLength(2)
    expect(section?.textContent).toContain('src/app.ts:2 (original) · resolved')
    expect(section?.textContent).toContain('Outdated remark')
    expect(section?.textContent).toContain('Outdated reply')
    expect(section?.textContent).not.toContain('Why not')
    expect(section?.querySelector('a')?.getAttribute('href')).toBe(root.url)

    data.comments.reviewComments = data.comments.reviewComments.filter(comment => !comment.outdated)
    document.body.innerHTML = renderOverview(data, { paths: new Set(), now: NOW })
    expect(document.querySelector('.outdated-comments')).toBeNull()
  })

  it('hides empty commented events and retains written reviews and decisions', () => {
    const data = bundle()
    data.comments.reviews = [
      { state: 'COMMENTED', body: '' },
      { state: 'COMMENTED', body: ' \n\t' },
      { state: 'COMMENTED', body: 'Please check the migration.' },
      { state: 'APPROVED', body: '' },
      { state: 'CHANGES_REQUESTED', body: '' },
      { state: 'DISMISSED', body: '' },
    ].map((review, id) => ({
      id,
      author: 'reviewer',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      url: `https://github.com/acme/widgets/pull/42#pullrequestreview-${id}`,
      ...review,
    }))
    document.body.innerHTML = renderOverview(data, { paths: new Set(), now: NOW })
    const history = document.querySelector('.review-history')
    expect(history?.querySelector('summary')?.textContent).toContain('Review history · 4')
    expect([...document.querySelectorAll('.review-entry .pill')].map(el => el.textContent)).toEqual([
      'commented',
      'approved',
      'changes requested',
      'dismissed',
    ])
    expect(history?.textContent).toContain('Please check the migration.')
    expect(history?.textContent).not.toContain('Coverage 99%')
    expect(document.querySelector('.conversation')?.textContent).toContain('Coverage 99%')

    data.comments.reviews = data.comments.reviews.slice(0, 2)
    document.body.innerHTML = renderOverview(data, { paths: new Set(), now: NOW })
    expect(document.querySelector('.review-history')).toBeNull()
  })
})

describe('header', () => {
  it('renders brand, commands, title, meta, risk line, progress, and the sign-off gate for a ready bundle', () => {
    document.body.innerHTML = renderHeader(bundle(), {
      host: 'localhost:3010',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    const hdr = document.querySelector('header.hdr')
    expect(hdr?.querySelector('.brand-wordmark')?.textContent).toBe('PR review canvas')
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
    expect([...(hdr?.querySelectorAll('.hdr-actions .cmd:disabled') ?? [])].map(b => b.textContent)).toEqual(
      []
    )
    // Without acpx or chat, settings still holds the reading level a review opens at.
    document.body.innerHTML = renderHeader(bundle({ chat: { enabled: false, acpx: false } }), {
      host: 'localhost:3010',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    expect(document.querySelector('#settings')?.hasAttribute('disabled')).toBe(false)
    document.body.innerHTML = renderHeader(bundle(), {
      host: 'localhost:3010',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    expect(hdr?.querySelector('#export-zip')?.hasAttribute('disabled')).toBe(false)
    expect(hdr?.querySelector('#regenerate')?.hasAttribute('disabled')).toBe(false)
    expect(hdr?.querySelector('h1')?.textContent).toBe('#42feat: add b')
    expect(hdr?.querySelector('.title a.cmd')?.getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/42'
    )
    expect(hdr?.querySelector('.meta .pill.open')?.textContent).toBe('open')
    expect(hdr?.querySelector('.diffstat')?.textContent).toBe('+7 −5')
    expect(hdr?.querySelector('.pill.agent')?.textContent).toBe('claude · claude-opus-4-1 · claude-code')
    expect(hdr?.querySelector('.touches')?.textContent).toBe('touches:schema')
    expect(hdr?.querySelector('.ptext')?.textContent).toBe('0 of 1 layers reviewed')
    expect(hdr?.querySelector('.pline span')?.getAttribute('style')).toBe('width:0%')
    expect([...(hdr?.querySelectorAll('.signoff .cmd') ?? [])].map(b => b.textContent)).toEqual([
      'approve on github',
      'request changes',
      'comment',
    ])
    // Approve waits for every layer; request changes is allowed at any time.
    expect([...(hdr?.querySelectorAll('.signoff .cmd:disabled') ?? [])].map(b => b.textContent)).toEqual([
      'approve on github',
    ])
    expect(hdr?.querySelector('#approve')?.getAttribute('title')).toBe(
      '1 layer is not reviewed yet: Run path'
    )
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
    document.body.innerHTML = renderHeader(
      bundle({ largePr: true, status: 'missing', artifact: undefined }),
      {
        host: 'h',
        theme: 'auto',
        skin: 'terminal',
        now: NOW,
      }
    )
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
    const state = { ...emptyState('x'), reviewed: { 'layer:run-path': /** @type {const} */ (true) } }
    document.body.innerHTML = renderHeader(bundle({ state }), {
      host: 'h',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
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
    const done = { ...base, reviewed: { 'layer:run-path': /** @type {const} */ (true) } }
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
    expect(root.querySelector('#approve')?.getAttribute('title')).toBe(
      '1 layer is not reviewed yet: Run path'
    )
  })

  it('changes nothing on a page that has no progress line', () => {
    document.body.innerHTML = '<div id="bare"></div>'
    const root = document.querySelector('#bare')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    expect(refreshProgress(root, syntheticArtifact(), emptyState('x'))).toEqual({
      done: 0,
      total: 1,
      percent: 0,
    })
  })
  it('keeps export and regenerate live on a stale canvas', () => {
    document.body.innerHTML = renderHeader(bundle({ status: 'stale' }), {
      host: 'localhost:3010',
      theme: 'auto',
      skin: 'terminal',
      now: NOW,
    })
    expect(document.querySelector('#export-zip')?.hasAttribute('disabled')).toBe(false)
    expect(document.querySelector('#regenerate')?.hasAttribute('disabled')).toBe(false)
  })

  it('drops the forge link and speaks of local work when the canvas has no pull request', () => {
    const artifact = syntheticArtifact()
    document.body.innerHTML = renderHeader(
      bundle({
        local: 'uncommitted',
        pr: { ...artifact.pr, number: null, url: '', state: 'uncommitted' },
      }),
      { host: 'localhost:3010', theme: 'auto', skin: 'terminal', now: NOW }
    )
    const hdr = document.querySelector('header.hdr')
    expect(hdr?.querySelector('h1')?.textContent).toBe('feat: add b')
    expect(hdr?.querySelector('.title a.cmd')).toBeNull()
    expect(hdr?.querySelector('#refresh')?.getAttribute('title')).toBe(
      'Snapshot the working tree again and redraw'
    )
    expect(hdr?.querySelector('#regenerate')?.getAttribute('title')).toBe(
      'Generate a new canvas for this local work'
    )
    expect(hdr?.querySelector('.pill')?.textContent).toBe('uncommitted')
  })
})

describe('overview', () => {
  const paths = new Set(['src/app.ts'])

  it('renders the summary as one prose block with its links, headings demoted', () => {
    document.body.innerHTML = summaryHtml(syntheticArtifact().summary, paths)
    expect(document.querySelector('.summary.prose a[href="#hunk:src/app.ts#1"]')?.textContent).toBe('app.ts')
    expect(summaryHtml('plain summary', paths)).toBe(
      '<div class="summary prose"><p>plain summary</p>\n</div>'
    )
    document.body.innerHTML = summaryHtml('## Heading\n\nbody', paths)
    expect(document.querySelector('.summary h4')?.textContent).toBe('Heading')
  })

  it('renders the conversation with bots collapsed and a comment command', () => {
    document.body.innerHTML = conversationHtml(bundle().comments.issueComments, NOW)
    expect(document.querySelector('h3.lbl.sub')?.textContent).toBe('Conversation · 2')
    expect(document.querySelector('.cmt .who b')?.textContent).toBe('reviewer')
    expect(document.querySelector('.cmt .prose strong')?.textContent).toBe('good')
    expect(document.querySelector('details.bots summary .chev + span')?.textContent).toBe('1 bot comment')
    expect(document.querySelector('details.bots summary > .chev')?.getAttribute('aria-hidden')).toBe('true')
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
    expect(panel?.querySelector('details.pr-desc summary > .chev')?.getAttribute('aria-hidden')).toBe('true')
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
      name: 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      namesHead: true,
      downloadable: true,
    }
    expect(sharedCanvasCalloutHtml(bundle({ sharedCanvas: shared }))).toContain('importing&hellip;')
    const failed = sharedCanvasCalloutHtml(
      bundle({ sharedCanvas: { ...shared, downloadable: false, reason: 'auth-required' } })
    )
    expect(failed).toContain('callout warn')
    expect(failed).toContain('auth-required')
    expect(failed).toContain('id="fetch-shared"')
    expect(sharedCanvasCalloutHtml(bundle({ sharedCanvas: { ...shared, downloadable: false } }))).toContain(
      '(unknown)'
    )
    expect(sharedCanvasCalloutHtml(bundle())).toBe('')
  })
  it('keeps the stale screen readable when the bundle names no older commit', () => {
    const stale = renderStaleState(bundle({ status: 'stale' }))
    expect(stale).toContain('Canvas is outdated')
    expect(stale).toContain('<p class="hint"></p>')
  })

  it('offers the drop zone on the stale screen of a pull request', () => {
    const stale = renderStaleState(
      bundle({
        status: 'stale',
        stale: {
          canvasHeadSha: 'a'.repeat(40),
          currentHeadSha: 'b'.repeat(40),
          relation: 'ancestor',
          commitsBehind: 3,
        },
      })
    )
    expect(stale).toContain('3 commits behind the head bbbbbbb')
    expect(stale).toContain('id="view-stale"')
    expect(stale).toContain('Drop a canvas zip here')
  })

  it('names the branch review on its own empty screen', () => {
    expect(
      renderEmptyState(
        bundle({
          status: 'missing',
          artifact: undefined,
          local: 'branch',
          skillCommand: '/pr-review-canvas branch',
        })
      )
    ).toContain('No review canvas for this branch yet')
  })

  it('leaves the canvas transfer out of a local review and says whose work it is', () => {
    const local = renderEmptyState(
      bundle({
        status: 'missing',
        artifact: undefined,
        local: 'uncommitted',
        skillCommand: '/pr-review-canvas uncommitted',
      })
    )
    expect(local).toContain('No review canvas for your uncommitted work yet')
    expect(local).toContain('/pr-review-canvas uncommitted')
    expect(local).not.toContain('drop')

    const stale = renderStaleState(
      bundle({
        status: 'stale',
        local: 'uncommitted',
        stale: { canvasHeadSha: 'a'.repeat(40), currentHeadSha: 'b'.repeat(40), relation: 'unrelated' },
      })
    )
    expect(stale).toContain('your work has moved on to bbbbbbb')
    expect(stale).not.toContain('drop')
    expect(
      staleBarHtml(
        { canvasHeadSha: 'a'.repeat(40), currentHeadSha: 'b'.repeat(40), relation: 'unrelated' },
        'uncommitted'
      )
    ).toContain('your work has moved on')
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

describe('the reading level control', () => {
  it('offers the three levels and says what the chosen one hides', () => {
    document.body.innerHTML = foldLevelControlHtml('light', { total: 40, hidden: 0 })
    const select = document.querySelector('select')
    expect([...(select?.options ?? [])].map(o => o.value)).toEqual(['light', 'moderate', 'aggressive'])
    expect(select?.value).toBe('light')
    expect(document.querySelector('label')?.getAttribute('for')).toBe(select?.id)
    expect(document.querySelector('.fold-hint')?.textContent).toContain(
      'imports, whitespace, moved blocks, and generated files'
    )
  })

  it('names what each level adds and how much of the diff it hides', () => {
    // A level that hides nothing says so rather than showing 0.
    expect(foldLevelHint('light', { total: 40, hidden: 0 })).toContain('nothing hidden yet')
    expect(foldLevelHint('moderate', { total: 40, hidden: 12 })).toContain(
      'also test bodies, helpers, wiring, templates'
    )
    expect(foldLevelHint('moderate', { total: 40, hidden: 12 })).toContain(
      '12 of 40 lines hidden of the diff'
    )
    expect(foldLevelHint('aggressive', { total: 40, hidden: 30 })).toContain(
      'only the code you have to judge'
    )
  })

  it('follows a level chosen with the keyboard', () => {
    document.body.innerHTML = foldLevelControlHtml('light', { total: 40, hidden: 0 })
    refreshFoldLevel(document.body, 'aggressive', { total: 40, hidden: 30 })

    expect(document.querySelector('select')?.value).toBe('aggressive')
    expect(document.querySelector('.fold-hint')?.textContent).toContain('only the code you have to judge')
  })
})
