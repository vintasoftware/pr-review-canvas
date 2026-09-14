// @ts-check
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MODEL_SUGGESTIONS,
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
    agent: 'claude',
    model: null,
    chatTimeoutSec: 600,
    maxTurns: null,
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
      probeAgent: async () => ({ id: 'claude', ok: true, ms: 1250, reply: 'OK', at: '', cached: false }),
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

  it('shows the project config read-only, with its path', () => {
    const html = settingsDialogHtml(SETTINGS, AGENTS)
    expect(html).toContain('Project config (read-only)')
    expect(html).toContain('layers in the taxonomy: 8')
    expect(html).toContain('high-risk patterns: 2')
    expect(html).toContain('/repo/pr-review.config.yml')
    expect(html).toContain('/repo/.pr-review/settings.yml')
  })

  it('says when the defaults are in use because there is no project file', () => {
    const html = settingsDialogHtml(
      { ...SETTINGS, project: { ...SETTINGS.project, file: null, rulebook: null } },
      AGENTS
    )
    expect(html).toContain('built-in defaults')
    expect(html).toContain('rulebook: none')
  })

  it('names the serve flags that win over the file', () => {
    const html = settingsDialogHtml({ ...SETTINGS, overrides: { agent: 'codex', model: 'x' } }, AGENTS)
    expect(html).toContain('--agent codex --model x')
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
      agent: 'claude',
      model: null,
      chatTimeoutSec: 600,
      maxTurns: null,
    })
  })
})

describe('openSettingsDialog', () => {
  it('fills the dialog from the server and opens it', async () => {
    const dialog = await open()
    expect(dialog.id).toBe(SETTINGS_DIALOG_ID)
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(el(dialog, '#set-agent')).toBeTruthy()
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
      data => saved.push(data.settings.agent)
    )
    const agent = el(dialog, '#set-agent')
    if (!(agent instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    agent.value = 'codex'
    el(dialog, '[data-act="settings-save"]').click()
    await flush()
    expect(saved[0]).toEqual({ agent: 'codex', model: null, chatTimeoutSec: 600, maxTurns: null })
    expect(saved[1]).toBe('claude')
    expect(dialog.hasAttribute('open')).toBe(false)
  })

  it('swaps the model suggestions when the agent changes', async () => {
    const dialog = await open()
    const agent = el(dialog, '#set-agent')
    if (!(agent instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    agent.value = 'codex'
    agent.dispatchEvent(new Event('change', { bubbles: true }))
    expect(el(dialog, '#model-list').innerHTML).toContain(MODEL_SUGGESTIONS.codex[0] ?? '')
  })

  it('reports how long the agent took to answer a probe', async () => {
    const dialog = await open()
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.probe-result')?.textContent).toBe('claude answered in 1.3s')
  })

  it('reports a probe that failed', async () => {
    const dialog = await open({
      probeAgent: async () => ({
        id: 'codex',
        ok: false,
        ms: 10,
        reply: '',
        code: 'AGENT_AUTH_REQUIRED',
        message: 'not logged in',
        at: '',
        cached: false,
      }),
    })
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
      { ...SETTINGS, settings: { ...SETTINGS.settings, model: 'gpt-5.2', maxTurns: 6, chatTimeoutSec: 120 } },
      AGENTS
    )
    expect(readSettingsForm(holder)).toEqual({
      agent: 'claude',
      model: 'gpt-5.2',
      chatTimeoutSec: 120,
      maxTurns: 6,
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
    expect(settingsDialogHtml({ ...SETTINGS, overrides: { model: 'x' } }, AGENTS)).toContain('--model x')
  })

  it('does nothing for a change that is not the agent select', async () => {
    const dialog = await open()
    const model = el(dialog, '#set-model')
    model.dispatchEvent(new Event('change', { bubbles: true }))
    expect(el(dialog, '#model-list').innerHTML).toContain(MODEL_SUGGESTIONS.claude[0] ?? '')
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
    dialog.querySelector('#set-agent')?.remove()
    el(dialog, '[data-act="settings-probe"]').click()
    await flush()
    expect(dialog.querySelector('.cmd-err')).toBeNull()
  })
})
