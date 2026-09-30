// @ts-check
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkoutListHtml,
  formatBytes,
  MODEL_SUGGESTIONS,
  SETTINGS_TAB_KEY,
  modelOptionsHtml,
  openSettingsDialog,
  readSettingsForm,
  SETTINGS_DIALOG_ID,
  settingsDialogHtml,
} from './settings.js'

/** @type {import('./contract-types.js').SettingsResponse} */
const SETTINGS = {
  settings: {
    version: 1,
    skin: 'terminal',
    theme: 'auto',
    foldLevel: 'light',
    layerView: 'all',
    chatAgent: 'claude',
    chatModel: null,
    chatTimeoutSec: 600,
    maxTurns: null,
    checkoutEnabled: true,
    checkoutIdleDays: 7,
    checkoutSweepMinutes: 60,
    canvasComment: null,
    mentionCanvas: null,
    tourComment: null,
  },
  overrides: {},
  file: '/repo/.pr-review/settings.yml',
  project: {
    file: '/repo/pr-review.config.yml',
    chatEnabled: true,
    rulebook: 'ai-tools/skills/thermo/SKILL.md',
    maxRepairRounds: 3,
    inlineDiffMaxLines: 1500,
    smallPrHunks: 10,
    generationModels: { claude: 'opus' },
    keepForIdenticalDiff: true,
    layers: 8,
    highRisk: 2,
  },
}

/** @type {import('./contract-types.js').AgentsResponse} */
const AGENTS = {
  acpx: { installed: true, version: '0.13.2' },
  agents: [
    { id: 'claude', available: true, installed: true, authenticated: true },
    { id: 'codex', available: false, installed: true, authenticated: false, reason: 'log in first' },
  ],
}

/** @type {HTMLElement} */
let root

beforeEach(() => {
  root = document.createElement('div')
  document.body.replaceChildren(root)
})

/**
 * @param {Partial<import('./settings.js').SettingsApi>} [api]
 * @param {(data: import('./contract-types.js').SettingsResponse) => void} [onSaved]
 */
async function open(api = {}, onSaved = () => undefined) {
  const opener = document.createElement('button')
  opener.textContent = 'settings'
  root.appendChild(opener)
  const dialog = await openSettingsDialog(root, opener, {
    api: {
      fetchSettings: async () => SETTINGS,
      fetchAgents: async () => AGENTS,
      saveSettings: async () => SETTINGS,
      probeAgent: async id => ({
        id: asChatAgent(id),
        ok: true,
        ms: 1250,
        reply: 'OK',
        at: '',
        cached: false,
      }),
      fetchCheckouts: async () => ({ root: '/repo/.pr-review/repos/acme__widgets/checkouts', checkouts: [] }),
      ...api,
    },
    onSaved,
  })
  if (dialog === null) {
    throw new Error('the dialog did not open')
  }
  return dialog
}

/** @param {ParentNode} where @param {string} selector */
function el(where, selector) {
  const found = where.querySelector(selector)
  if (!(found instanceof HTMLElement)) {
    throw new Error(`no ${selector}`)
  }
  return found
}

/** The id the dialog asked about, as the probe route would echo it. */
const asChatAgent = (/** @type {string} */ id) => /** @type {import('./contract-types.js').ChatAgent} */ (id)

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('settingsDialogHtml', () => {
  it('disables an agent that cannot run and says why', () => {
    const html = settingsDialogHtml(SETTINGS, AGENTS)
    expect(html).toContain('<option value="codex" disabled>codex (log in first)</option>')
    expect(html).toContain('<option value="claude" selected>claude</option>')
  })

  it('says that changing the agent starts a new thread', () => {
    expect(settingsDialogHtml(SETTINGS, AGENTS)).toContain('starts a new chat thread')
  })

  it('offers the three reading levels with the saved one selected', () => {
    const html = settingsDialogHtml(
      { ...SETTINGS, settings: { ...SETTINGS.settings, foldLevel: 'moderate' } },
      AGENTS
    )
    expect(html).toContain('<label for="set-fold-level">Hide code by default</label>')
    expect(html).toContain('<option value="light">light</option>')
    expect(html).toContain('<option value="moderate" selected>moderate</option>')
    expect(html).toContain('<option value="aggressive">aggressive</option>')
    expect(html).toContain('The level every review opens at')
  })

  it('shows the project config read-only, with its path', () => {
    const html = settingsDialogHtml(SETTINGS, AGENTS)
    expect(html).toContain('Project config (read-only)')
    expect(html).toContain('configured layer suggestions: 8')
    expect(html).toContain('high-risk patterns: 2')
    expect(html).toContain('/repo/pr-review.config.yml')
    expect(html).toContain('/repo/.pr-review/settings.yml')
  })

  it('labels the chat fields as AI Chat, apart from the canvas generation models', () => {
    const html = settingsDialogHtml(SETTINGS, AGENTS)
    expect(html).toContain('role="tab" class="settings-tab" id="settings-tab-chat"')
    expect(html).toContain('<label for="set-chat-agent">Chat agent</label>')
    expect(html).toContain('<label for="set-chat-model">Chat model</label>')
    expect(html).toContain('They do not change which model generates canvases')
    expect(html).toContain('<h4>Canvas generation</h4>')
    expect(html).toContain(
      'canvas generation models: <span class="mono">claude → opus</span>. Any other agent keeps the session\'s model'
    )
  })

  it('lists each canvas generation model the project sets, by agent', () => {
    const project = { ...SETTINGS.project, generationModels: { claude: 'opus', codex: '<gpt>' } }
    const html = settingsDialogHtml({ ...SETTINGS, project }, AGENTS)
    expect(html).toContain(
      'canvas generation models: <span class="mono">claude → opus</span>, <span class="mono">codex → &lt;gpt&gt;</span>. ' +
        "Any other agent keeps the session's model"
    )
  })

  it('says when the defaults are in use because there is no project file', () => {
    const html = settingsDialogHtml(
      { ...SETTINGS, project: { ...SETTINGS.project, file: null, rulebook: null } },
      AGENTS
    )
    expect(html).toContain('built-in defaults')
    expect(html).toContain('rulebook: none')
  })

  it('shows disabled chat and an agent-only override without adding a model flag', () => {
    const html = settingsDialogHtml(
      {
        ...SETTINGS,
        overrides: { chatAgent: 'codex' },
        project: { ...SETTINGS.project, chatEnabled: false },
      },
      AGENTS
    )
    expect(html).toContain('chat enabled: no')
    expect(html).toContain('canvas kept for an identical diff: yes')
    expect(
      settingsDialogHtml(
        { ...SETTINGS, project: { ...SETTINGS.project, keepForIdenticalDiff: false } },
        AGENTS
      )
    ).toContain('canvas kept for an identical diff: no')
    expect(html).toContain('--chat-agent codex')
    expect(html).not.toContain('--chat-model')
  })

  it('names the serve flags that win over the file', () => {
    const html = settingsDialogHtml(
      { ...SETTINGS, overrides: { chatAgent: 'codex', chatModel: 'x' } },
      AGENTS
    )
    expect(html).toContain(
      'overrides the AI Chat settings in this file for now: <code class="flag">--chat-agent codex</code> <code class="flag">--chat-model x</code>'
    )
  })

  it('offers both layer views with the saved one selected', () => {
    const html = settingsDialogHtml(SETTINGS, AGENTS)
    expect(html).toContain('<option value="all" selected>all at once</option>')
    expect(html).toContain('<option value="one">one at a time</option>')
  })

  it('says that a missing acpx turns the pane off', () => {
    const html = settingsDialogHtml(SETTINGS, { acpx: { installed: false, version: null }, agents: [] })
    expect(html).toContain('acpx is not on PATH')
  })
})

describe('modelOptionsHtml', () => {
  it('suggests the models of the agent in the select', () => {
    expect(modelOptionsHtml('claude')).toContain(MODEL_SUGGESTIONS.claude[0] ?? '')
    expect(modelOptionsHtml('codex')).toContain(MODEL_SUGGESTIONS.codex[0] ?? '')
  })
})

describe('readSettingsForm', () => {
  it('reads every field, with the empty ones as null', () => {
    const holder = document.createElement('div')
    holder.innerHTML = settingsDialogHtml(SETTINGS, AGENTS)
    expect(readSettingsForm(holder)).toEqual({
      foldLevel: 'light',
      layerView: 'all',
      chatAgent: 'claude',
      chatModel: null,
      chatTimeoutSec: 600,
      maxTurns: null,
      checkoutEnabled: true,
      checkoutIdleDays: 7,
      checkoutSweepMinutes: 60,
    })
  })

  it('reads the reading level the reader picked', () => {
    const holder = document.createElement('div')
    holder.innerHTML = settingsDialogHtml(SETTINGS, AGENTS)
    const select = holder.querySelector('#set-fold-level')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no level select')
    }
    select.value = 'aggressive'
    expect(readSettingsForm(holder).foldLevel).toBe('aggressive')
  })

  it('reads the layer view the reader picked', () => {
    const holder = document.createElement('div')
    holder.innerHTML = settingsDialogHtml(
      { ...SETTINGS, settings: { ...SETTINGS.settings, layerView: 'one' } },
      AGENTS
    )
    expect(holder.querySelector('#set-layer-view option[selected]')?.textContent).toBe('one at a time')
    expect(readSettingsForm(holder).layerView).toBe('one')
  })
})

describe('openSettingsDialog', () => {
  it('fills the dialog from the server and opens it', async () => {
    const dialog = await open()
    expect(dialog.id).toBe(SETTINGS_DIALOG_ID)
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(el(dialog, '#set-chat-agent')).toBeTruthy()
  })

  it('holds only the reading level when the project turns chat off, and asks for no agents', async () => {
    let asked = false
    const dialog = await open({
      fetchSettings: async () => ({ ...SETTINGS, project: { ...SETTINGS.project, chatEnabled: false } }),
      fetchAgents: async () => {
        asked = true
        return AGENTS
      },
    })
    expect(asked).toBe(false)
    expect(el(dialog, '#set-fold-level')).toBeTruthy()
    expect(dialog.querySelector('#set-chat-agent')).toBeNull()
    expect(dialog.querySelector('[data-act="settings-probe"]')).toBeNull()
  })

  it('shows the failure next to the command when the settings cannot be read', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'settings'
    root.appendChild(opener)
    const dialog = await openSettingsDialog(root, opener, {
      api: {
        fetchSettings: async () => {
          throw new Error('gone')
        },
        fetchAgents: async () => AGENTS,
      },
    })
    expect(dialog).toBeNull()
    expect(root.querySelector('.cmd-err')?.textContent).toBe('gone')
  })

  it('saves what the form holds and tells the caller', async () => {
    /** @type {unknown[]} */
    const saved = []
    const dialog = await open(
      {
        saveSettings: async input => {
          saved.push(input)
          return SETTINGS
        },
      },
      data => saved.push(data.settings.chatAgent)
    )
    const agent = el(dialog, '#set-chat-agent')
    if (!(agent instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    agent.value = 'codex'
    el(dialog, '[data-act="settings-save"]').click()
    await flush()
    expect(saved[0]).toEqual({
      foldLevel: 'light',
      layerView: 'all',
      chatAgent: 'codex',
      chatModel: null,
      chatTimeoutSec: 600,
      maxTurns: null,
      checkoutEnabled: true,
      checkoutIdleDays: 7,
      checkoutSweepMinutes: 60,
    })
    expect(saved[1]).toBe('claude')
    expect(dialog.hasAttribute('open')).toBe(false)
  })

  it('swaps the model suggestions when the agent changes', async () => {
    const dialog = await open()
    const agent = el(dialog, '#set-chat-agent')
    if (!(agent instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    agent.value = 'codex'
    agent.dispatchEvent(new Event('change', { bubbles: true }))
    expect(el(dialog, '#chat-model-list').innerHTML).toContain(MODEL_SUGGESTIONS.codex[0] ?? '')
  })

  it('reports how long the agent took to answer a probe', async () => {
    const dialog = await open()
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.probe-result')?.textContent).toBe('claude answered in 1.3s')
  })

  it('reports a probe that failed', async () => {
    const dialog = await open({
      probeAgent: async id => ({
        id: asChatAgent(id),
        ok: false,
        ms: 10,
        reply: '',
        code: 'AGENT_AUTH_REQUIRED',
        message: 'not logged in',
        at: '',
        cached: false,
      }),
    })
    const agent = el(dialog, '#set-chat-agent')
    if (!(agent instanceof HTMLSelectElement)) {
      throw new Error('no chat agent select')
    }
    agent.value = 'codex'
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.probe-result')?.textContent).toBe('codex failed: not logged in')
  })

  it('closes on the close command, and ignores a click that is no command', async () => {
    const dialog = await open()
    dialog.click()
    expect(dialog.hasAttribute('open')).toBe(true)
    el(dialog, '[data-act="settings-close"]').click()
    expect(dialog.hasAttribute('open')).toBe(false)
  })

  it('replaces an older dialog rather than stacking a second one', async () => {
    await open()
    await open()
    expect(root.querySelectorAll(`#${SETTINGS_DIALOG_ID}`)).toHaveLength(1)
  })
})

describe('the dialog with parts missing', () => {
  it('reads an empty form as no change at all', () => {
    const empty = document.createElement('div')
    expect(readSettingsForm(empty)).toEqual({})
  })

  it('reads the values the reader typed', () => {
    const holder = document.createElement('div')
    holder.innerHTML = settingsDialogHtml(
      {
        ...SETTINGS,
        settings: { ...SETTINGS.settings, chatModel: 'gpt-5.2', maxTurns: 6, chatTimeoutSec: 120 },
      },
      AGENTS
    )
    expect(readSettingsForm(holder)).toEqual({
      foldLevel: 'light',
      layerView: 'all',
      chatAgent: 'claude',
      chatModel: 'gpt-5.2',
      chatTimeoutSec: 120,
      maxTurns: 6,
      checkoutEnabled: true,
      checkoutIdleDays: 7,
      checkoutSweepMinutes: 60,
    })
  })

  it('says an agent is unavailable even when it gives no reason', () => {
    const html = settingsDialogHtml(SETTINGS, {
      acpx: { installed: true, version: '0.13.2' },
      agents: [{ id: 'codex', available: false, installed: false, authenticated: false }],
    })
    expect(html).toContain('(not available)')
  })

  it('names a model-only override', () => {
    expect(settingsDialogHtml({ ...SETTINGS, overrides: { chatModel: 'x' } }, AGENTS)).toContain(
      '--chat-model x'
    )
  })

  it('does nothing for a change that is not the agent select', async () => {
    const dialog = await open()
    const model = el(dialog, '#set-chat-model')
    model.dispatchEvent(new Event('change', { bubbles: true }))
    expect(el(dialog, '#chat-model-list').innerHTML).toContain(MODEL_SUGGESTIONS.claude[0] ?? '')
  })

  it('reports a probe failure that carries only a code', async () => {
    const dialog = await open({
      probeAgent: async () => ({
        id: 'claude',
        ok: false,
        ms: 1,
        reply: '',
        code: 'AGENT_TIMEOUT',
        at: '',
        cached: false,
      }),
    })
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.probe-result')?.textContent).toBe('claude failed: AGENT_TIMEOUT')
  })

  it('reports a probe failure that says nothing at all', async () => {
    const dialog = await open({
      probeAgent: async () => ({ id: 'claude', ok: false, ms: 1, reply: '', at: '', cached: false }),
    })
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.probe-result')?.textContent).toBe('claude failed: unknown')
  })

  it('says a cached probe is one', async () => {
    const dialog = await open({
      probeAgent: async () => ({ id: 'claude', ok: true, ms: 900, reply: 'OK', at: '', cached: true }),
    })
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.probe-result')?.textContent).toBe('claude answered in 0.9s (cached)')
  })

  it('shows a failed save next to the command and leaves the dialog open', async () => {
    const dialog = await open({
      saveSettings: async () => {
        throw new Error('disk full')
      },
    })
    el(dialog, '[data-act="settings-save"]').click()
    await flush()
    expect(dialog.querySelector('.cmd-err')?.textContent).toBe('disk full')
    expect(dialog.hasAttribute('open')).toBe(true)
  })
})

describe('the dialog click handler', () => {
  it('ignores a click that is not on a command', async () => {
    const dialog = await open()
    el(dialog, '#settings-h').click()
    expect(dialog.hasAttribute('open')).toBe(true)
  })

  it('ignores a command it does not know', async () => {
    const dialog = await open()
    const stray = document.createElement('button')
    stray.setAttribute('data-act', 'settings-nope')
    dialog.appendChild(stray)
    stray.click()
    expect(dialog.hasAttribute('open')).toBe(true)
  })
})

describe('the probe with the dialog cut down', () => {
  it('does not fail when the result line is gone', async () => {
    const dialog = await open()
    dialog.querySelector('.probe-result')?.remove()
    dialog.querySelector('#set-chat-agent')?.remove()
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.cmd-err')).toBeNull()
  })
})

describe('the settings tabs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  /** @param {HTMLElement} dialog */
  const visiblePanels = dialog =>
    [...dialog.querySelectorAll('[role="tabpanel"]')].filter(p => !p.hasAttribute('hidden')).map(p => p.id)

  it('opens on Reading, shows one panel at a time, and remembers the last tab', async () => {
    const dialog = await open()
    expect([...dialog.querySelectorAll('[role="tab"]')].map(t => t.textContent)).toEqual([
      'Reading',
      'AI Chat',
      'Checkouts',
      'Project',
    ])
    expect(visiblePanels(dialog)).toEqual(['settings-panel-reading'])
    el(dialog, '#settings-tab-project').click()
    expect(visiblePanels(dialog)).toEqual(['settings-panel-project'])
    expect(el(dialog, '#settings-tab-project').getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem(SETTINGS_TAB_KEY)).toBe('project')
    dialog.close()
    const again = await open()
    expect(visiblePanels(again)).toEqual(['settings-panel-project'])
  })

  it('moves between tabs with the arrow keys', async () => {
    const dialog = await open()
    const reading = el(dialog, '#settings-tab-reading')
    reading.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(visiblePanels(dialog)).toEqual(['settings-panel-project'])
    expect(document.activeElement?.id).toBe('settings-tab-project')
    const project = el(dialog, '#settings-tab-project')
    project.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(visiblePanels(dialog)).toEqual(['settings-panel-reading'])
    // Other keys, and arrows outside the tab list, leave the tab where it is.
    reading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    el(dialog, '#set-fold-level').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    )
    expect(visiblePanels(dialog)).toEqual(['settings-panel-reading'])
  })

  it.each([new Error('gone'), 'gone'])('says so when the checkouts cannot be listed: %s', async failure => {
    const dialog = await open({
      fetchCheckouts: async () => {
        throw failure
      },
    })
    el(dialog, '#settings-tab-checkouts').click()
    await flush()
    expect(el(dialog, '.checkout-list').textContent).toBe('could not list the checkouts: gone')
  })

  it('lists the checkouts only once their tab is shown', async () => {
    let asked = 0
    const dialog = await open({
      fetchCheckouts: async () => {
        asked += 1
        return {
          root: '/data/checkouts',
          checkouts: [
            {
              key: 42,
              sha: 'a'.repeat(40),
              lastUsedAt: '2026-09-20T12:30:00.000Z',
              locked: true,
              bytes: 5 * 1024 * 1024,
            },
          ],
        }
      },
    })
    expect(asked).toBe(0)
    el(dialog, '#settings-tab-checkouts').click()
    await flush()
    expect(asked).toBe(1)
    const list = el(dialog, '.checkout-list').textContent ?? ''
    expect(list).toContain('#42 (in use)')
    expect(list).toContain('aaaaaaa')
    expect(list).toContain('2026-09-20 12:30')
    expect(list).toContain('5 MB')
  })

  it('shows the saved checkout settings, and reads the fields into the saved settings', async () => {
    const dialog = await open({
      fetchSettings: async () => ({
        ...SETTINGS,
        settings: { ...SETTINGS.settings, checkoutEnabled: false },
      }),
    })
    expect(/** @type {HTMLInputElement} */ (el(dialog, '#set-checkout-enabled')).checked).toBe(false)
    const enabled = /** @type {HTMLInputElement} */ (el(dialog, '#set-checkout-enabled'))
    const idle = /** @type {HTMLInputElement} */ (el(dialog, '#set-checkout-idle'))
    const sweep = /** @type {HTMLInputElement} */ (el(dialog, '#set-checkout-sweep'))
    enabled.checked = false
    idle.value = '-1'
    sweep.value = '30'
    expect(readSettingsForm(dialog)).toMatchObject({
      checkoutEnabled: false,
      checkoutIdleDays: -1,
      checkoutSweepMinutes: 30,
    })
  })

  it('has no AI Chat or Checkouts tab when the project turns chat off', () => {
    const holder = document.createElement('div')
    holder.innerHTML = settingsDialogHtml(SETTINGS, null, 'checkouts')
    expect([...holder.querySelectorAll('[role="tab"]')].map(t => t.textContent)).toEqual([
      'Reading',
      'Project',
    ])
    expect(holder.querySelector('#settings-panel-reading')?.hasAttribute('hidden')).toBe(false)
  })
})

describe('checkoutListHtml', () => {
  it('says there are none yet', () => {
    expect(checkoutListHtml({ root: '/x', checkouts: [] })).toContain('No review checkouts yet')
  })

  it('names local reviews by what they are', () => {
    const html = checkoutListHtml({
      root: '/x',
      checkouts: [
        {
          key: 'branch',
          sha: 'b'.repeat(40),
          lastUsedAt: '2026-09-20T12:00:00.000Z',
          locked: false,
          bytes: 10,
        },
      ],
    })
    expect(html).toContain('Branch review')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB')
  })
})

it('describes an empty generation model map without an orphan separator', () => {
  const html = settingsDialogHtml(
    { ...SETTINGS, project: { ...SETTINGS.project, generationModels: {} } },
    AGENTS,
    'project'
  )
  expect(html).toContain("canvas generation models: Any other agent keeps the session's model.")
})
