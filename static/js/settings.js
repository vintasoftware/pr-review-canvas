// @ts-check
// The settings dialog: the personal settings this browser can change, the reading level a review
// opens at, how layers show, and the AI Chat settings, and a read-only look at the project config,
// which is committed and belongs to the repository. The chat agent and model are personal and run
// AI Chat only; the canvas generation models come from the project config.
/** @typedef {import('./contract-types.js').AgentsResponse} AgentsResponse */
/** @typedef {import('./contract-types.js').SettingsResponse} SettingsResponse */
import { fetchAgents, fetchCheckouts, fetchSettings, probeAgent, saveSettings } from './api.js'
import { runCommand } from './commands.js'
import { esc, qs } from './dom.js'
import { isFoldLevel } from './fold-levels.js'
import { isLayerView, LAYER_VIEW_LABELS, LAYER_VIEWS } from './layer-views.js'
import { foldLevelOptionsHtml } from './reading-level.js'

export const SETTINGS_DIALOG_ID = 'settings-dialog'
/** The AI Chat fields, named once so the markup, the form reader, and the probe agree. */
const CHAT_AGENT_ID = 'set-chat-agent'
const CHAT_MODEL_ID = 'set-chat-model'
const CHAT_MODEL_LIST_ID = 'chat-model-list'

/**
 * The layer views as options, with one selected.
 * @param {import('./layer-views.js').LayerView} view
 * @returns {string}
 */
function layerViewOptionsHtml(view) {
  return LAYER_VIEWS.map(
    v => `<option value="${esc(v)}"${v === view ? ' selected' : ''}>${esc(LAYER_VIEW_LABELS[v])}</option>`
  ).join('')
}

/**
 * Chat model ids the input suggests per chat agent. Free text is allowed; this is only a shortcut. The
 * server runs the newest model of whichever family is saved, so these do not go stale.
 */
export const MODEL_SUGGESTIONS = {
  claude: ['opus', 'opus[1m]', 'sonnet', 'haiku', 'fable'],
  codex: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra[high]'],
}

/** @param {string} agent */
export function modelOptionsHtml(agent) {
  const list = agent === 'codex' ? MODEL_SUGGESTIONS.codex : MODEL_SUGGESTIONS.claude
  return list.map(id => `<option value="${esc(id)}"></option>`).join('')
}

/**
 * The AI Chat fields, with the notice about acpx when it is missing.
 * @param {SettingsResponse['settings']} settings
 * @param {AgentsResponse} agents
 * @returns {string}
 */
function chatFieldsHtml(settings, agents) {
  const options = agents.agents
    .map(a => {
      const reason = a.available ? '' : ` (${a.reason ?? 'not available'})`
      return `<option value="${esc(a.id)}"${a.id === settings.chatAgent ? ' selected' : ''}${a.available ? '' : ' disabled'}>${esc(a.id)}${esc(reason)}</option>`
    })
    .join('')
  return (
    (agents.acpx.installed
      ? ''
      : '<p class="notice" role="status">acpx is not on PATH, so AI Chat is off. Install acpx and reload.</p>') +
    '<p class="muted small">The agent and model that answer in the chat pane. They do not change which model generates canvases.</p>' +
    `<div class="field"><label for="${CHAT_AGENT_ID}">Chat agent</label>` +
    `<select id="${CHAT_AGENT_ID}">${options}</select></div>` +
    `<div class="field"><label for="${CHAT_MODEL_ID}">Chat model</label>` +
    `<input id="${CHAT_MODEL_ID}" list="${CHAT_MODEL_LIST_ID}" value="${esc(settings.chatModel ?? '')}" placeholder="the chat agent's default">` +
    `<datalist id="${CHAT_MODEL_LIST_ID}">${modelOptionsHtml(settings.chatAgent)}</datalist></div>` +
    '<div class="field"><label for="set-timeout">Chat timeout (seconds)</label>' +
    `<input id="set-timeout" type="number" min="30" max="3600" value="${esc(settings.chatTimeoutSec)}"></div>` +
    '<div class="field"><label for="set-turns">Max turns</label>' +
    `<input id="set-turns" type="number" min="1" max="100" value="${esc(settings.maxTurns ?? '')}" placeholder="the agent's default"></div>` +
    '<p class="muted small">Changing the chat agent starts a new chat thread; the old ones stay in the list.</p>' +
    '<button class="cmd" type="button" data-act="settings-probe">test agent</button>'
  )
}

/**
 * The project's `generation.models`, one `agent → model` per entry. An agent it does not name keeps
 * the model of the session that runs the skill.
 * @param {SettingsResponse['project']['generationModels']} models
 * @returns {string}
 */
function generationModelsHtml(models) {
  const entries = Object.entries(models).map(
    ([agent, model]) => `<span class="mono">${esc(agent)} → ${esc(model)}</span>`
  )
  return (
    (entries.length === 0 ? '' : `${entries.join(', ')}. `) + "Any other agent keeps the session's model."
  )
}

/** The dialog's tabs, in order. AI Chat and Checkouts exist only when the project turns chat on. */
export const SETTINGS_TABS = /** @type {const} */ ([
  { id: 'reading', label: 'Reading', chat: false },
  { id: 'chat', label: 'AI Chat', chat: true },
  { id: 'checkouts', label: 'Checkouts', chat: true },
  { id: 'project', label: 'Project', chat: false },
])
/** @typedef {(typeof SETTINGS_TABS)[number]['id']} SettingsTab */

/** Where this browser remembers the tab the dialog was last left on. */
export const SETTINGS_TAB_KEY = 'pr-review.settings-tab'

/**
 * The review checkout fields: whether AI Chat reads one, when an idle one is removed, and how often
 * `serve` looks. The list of checkouts fills in when the tab is first shown.
 * @param {SettingsResponse['settings']} settings
 * @returns {string}
 */
function checkoutFieldsHtml(settings) {
  return (
    '<p class="muted small">A review checkout is a copy of the repository at the reviewed commit, kept apart from your own checkout, which AI Chat reads code from. Uncommitted work is read from your working tree.</p>' +
    '<div class="field field-check"><label for="set-checkout-enabled">Read a review checkout</label>' +
    `<input id="set-checkout-enabled" type="checkbox"${settings.checkoutEnabled ? ' checked' : ''}></div>` +
    '<div class="field"><label for="set-checkout-idle">Remove after idle days</label>' +
    `<input id="set-checkout-idle" type="number" min="-1" max="365" value="${esc(settings.checkoutIdleDays)}"></div>` +
    '<p class="muted small">Days without a chat turn before a checkout is removed. -1 never removes one; <span class="mono">pr-review clean --all</span> still does.</p>' +
    '<div class="field"><label for="set-checkout-sweep">Check every (minutes)</label>' +
    `<input id="set-checkout-sweep" type="number" min="5" max="1440" value="${esc(settings.checkoutSweepMinutes)}"></div>` +
    '<h3>Current checkouts</h3>' +
    '<div class="checkout-list" aria-live="polite"><p class="muted small">loading…</p></div>'
  )
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }
  const mb = bytes / (1024 * 1024)
  return mb < 1024 ? `${Math.round(mb)} MB` : `${Math.round((mb / 1024) * 10) / 10} GB`
}

/**
 * The checkouts as a read-only table: which review, which commit, when it was last used.
 * @param {import('./contract-types.js').CheckoutsResponse} data
 * @returns {string}
 */
export function checkoutListHtml(data) {
  if (data.checkouts.length === 0) {
    return '<p class="muted small">No review checkouts yet. One is created on the first chat turn of a review.</p>'
  }
  const rows = data.checkouts
    .map(c => {
      // The uncommitted review reads the working tree and never has a checkout. A branch review is
      // one checkout's, so a linked worktree's names it; the clone's checkouts are listed together.
      const review =
        c.key === 'branch' ? `Branch review${c.worktree === null ? '' : ` (${c.worktree})`}` : `#${c.key}`
      const used = c.lastUsedAt.slice(0, 16).replace('T', ' ')
      return (
        `<tr><td>${esc(review)}${c.locked ? ' <span class="muted">(in use)</span>' : ''}</td>` +
        `<td class="mono">${esc(c.sha.slice(0, 7))}</td><td>${esc(used)}</td><td>${esc(formatBytes(c.bytes))}</td></tr>`
      )
    })
    .join('')
  return (
    '<table class="checkout-table"><thead><tr><th>Review</th><th>Commit</th><th>Last used (UTC)</th><th>Size</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>` +
    `<p class="muted small mono">${esc(data.root)}</p>`
  )
}

/**
 * @param {SettingsResponse} data
 * @param {AgentsResponse | null} agents null when the project turns chat off, so the dialog holds
 *   only what the page itself reads
 * @param {SettingsTab} [tab] the tab to open on; one that does not exist here opens the first
 * @returns {string}
 */
export function settingsDialogHtml(data, agents, tab = 'reading') {
  const { settings, overrides, project } = data
  const tabs = SETTINGS_TABS.filter(t => agents !== null || !t.chat)
  const open = tabs.some(t => t.id === tab) ? tab : 'reading'
  const overrideNote =
    overrides.chatAgent === undefined && overrides.chatModel === undefined
      ? ''
      : `<p class="notice" role="status">A serve flag overrides the AI Chat settings in this file for now: ${[
          overrides.chatAgent === undefined ? '' : `--chat-agent ${overrides.chatAgent}`,
          overrides.chatModel === undefined ? '' : `--chat-model ${overrides.chatModel}`,
        ]
          .filter(Boolean)
          .map(flag => `<code class="flag">${esc(flag)}</code>`)
          .join(' ')}</p>`
  /** @type {Record<SettingsTab, string>} */
  const panels = {
    reading:
      '<div class="field"><label for="set-fold-level">Hide code by default</label>' +
      `<select id="set-fold-level">${foldLevelOptionsHtml(settings.foldLevel)}</select></div>` +
      '<p class="muted small">The level every review opens at. The Hide code control and the <span class="mono">f</span> key change it for one page.</p>' +
      '<div class="field"><label for="set-layer-view">Show layers</label>' +
      `<select id="set-layer-view">${layerViewOptionsHtml(settings.layerView)}</select></div>` +
      '<p class="muted small">One at a time shows the overview or a single layer. The rail and the <span class="mono">j</span> and <span class="mono">k</span> keys move between them.</p>',
    chat: agents === null ? '' : chatFieldsHtml(settings, agents),
    checkouts: agents === null ? '' : checkoutFieldsHtml(settings),
    project:
      '<div class="panel-ro"><h3>Project config (read-only)</h3>' +
      `<ul class="plain"><li>chat enabled: ${project.chatEnabled ? 'yes' : 'no'}</li>` +
      `<li>canvas kept for an identical diff: ${project.keepForIdenticalDiff ? 'yes' : 'no'}</li>` +
      `<li>rulebook: ${esc(project.rulebook ?? 'none')}</li>` +
      `<li>configured layer suggestions: ${project.layers}</li>` +
      `<li>high-risk patterns: ${project.highRisk}</li></ul>` +
      '<h4>Canvas generation</h4>' +
      `<ul class="plain"><li>canvas generation models: ${generationModelsHtml(project.generationModels)}</li>` +
      `<li>max repair rounds: ${project.maxRepairRounds}</li>` +
      `<li>inline diff max lines: ${project.inlineDiffMaxLines}</li>` +
      `<li>small change set: ${project.smallPrHunks} chunks</li></ul>` +
      `<p class="muted small mono">${esc(project.file ?? 'built-in defaults (no pr-review.config.yml)')}</p></div>`,
  }
  const tabList = tabs
    .map(
      t =>
        `<button type="button" role="tab" class="settings-tab" id="settings-tab-${t.id}" data-act="settings-tab" data-tab="${t.id}" ` +
        `aria-controls="settings-panel-${t.id}" aria-selected="${t.id === open}" tabindex="${t.id === open ? 0 : -1}">${esc(t.label)}</button>`
    )
    .join('')
  const tabPanels = tabs
    .map(
      t =>
        `<section role="tabpanel" class="settings-panel" id="settings-panel-${t.id}" aria-labelledby="settings-tab-${t.id}"${t.id === open ? '' : ' hidden'}>` +
        `${panels[t.id]}</section>`
    )
    .join('')
  return (
    `<dialog id="${SETTINGS_DIALOG_ID}" class="settings" aria-labelledby="settings-h">` +
    '<h2 id="settings-h">Settings</h2>' +
    overrideNote +
    `<div class="settings-tabs" role="tablist" aria-label="Settings sections">${tabList}</div>` +
    tabPanels +
    `<p class="muted small mono">${esc(data.file)}</p>` +
    '<p class="probe-result" role="status"></p>' +
    '<div class="dialog-actions">' +
    '<button class="cmd fill" type="button" data-act="settings-save">save</button>' +
    '<button class="cmd" type="button" data-act="settings-close">close</button>' +
    '</div></dialog>'
  )
}

/**
 * The requests the dialog makes. Tests pass their own.
 * @typedef {{
 *   fetchSettings: typeof fetchSettings,
 *   saveSettings: typeof saveSettings,
 *   fetchAgents: typeof fetchAgents,
 *   probeAgent: typeof probeAgent,
 *   fetchCheckouts: typeof fetchCheckouts,
 * }} SettingsApi
 */

/** @returns {SettingsTab} */
function rememberedTab() {
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_KEY)
    return SETTINGS_TABS.find(t => t.id === saved)?.id ?? 'reading'
  } catch {
    return 'reading'
  }
}

/** @param {SettingsTab} tab */
function rememberTab(tab) {
  try {
    localStorage.setItem(SETTINGS_TAB_KEY, tab)
  } catch {
    // A browser that refuses storage opens on the first tab next time.
  }
}

/**
 * Opens the dialog, filling it from the server. The caller passes the command that opened it so
 * its pending state shows while the two requests are in flight.
 * @param {HTMLElement} root
 * @param {HTMLElement} opener
 * @param {{ api?: Partial<SettingsApi>, onSaved?: (data: SettingsResponse) => void }} [opts]
 */
export async function openSettingsDialog(root, opener, opts = {}) {
  const api = { fetchSettings, saveSettings, fetchAgents, probeAgent, fetchCheckouts, ...opts.api }
  const loaded = await runCommand(
    opener,
    async () => {
      // With chat off the agent routes do not exist, and the dialog holds only the reading level.
      const data = await api.fetchSettings()
      const agents = data.project.chatEnabled ? await api.fetchAgents() : null
      return { data, agents }
    },
    { pendingLabel: 'loading…' }
  )
  if (loaded === undefined) {
    return null
  }
  qs(`#${SETTINGS_DIALOG_ID}`, root)?.remove()
  root.insertAdjacentHTML('beforeend', settingsDialogHtml(loaded.data, loaded.agents, rememberedTab()))
  const dialog = qs(`#${SETTINGS_DIALOG_ID}`, root)
  if (!(dialog instanceof HTMLDialogElement)) {
    return null
  }
  dialog.addEventListener('close', () => opener.focus({ preventScroll: true }), { once: true })
  wireSettingsDialog(dialog, api, opts.onSaved)
  if (typeof dialog.showModal === 'function') {
    dialog.showModal()
  } else {
    dialog.setAttribute('open', '')
  }
  return dialog
}

/** The values the dialog holds right now, as the PUT body. */
export function readSettingsForm(/** @type {ParentNode} */ dialog) {
  const foldLevel = qs('#set-fold-level', dialog)
  const layerView = qs('#set-layer-view', dialog)
  const agent = qs(`#${CHAT_AGENT_ID}`, dialog)
  const model = qs(`#${CHAT_MODEL_ID}`, dialog)
  const timeout = qs('#set-timeout', dialog)
  const turns = qs('#set-turns', dialog)
  const checkoutEnabled = qs('#set-checkout-enabled', dialog)
  const checkoutIdle = qs('#set-checkout-idle', dialog)
  const checkoutSweep = qs('#set-checkout-sweep', dialog)
  /** @type {import('./contract-types.js').SettingsInput} */
  const input = {}
  if (foldLevel instanceof HTMLSelectElement && isFoldLevel(foldLevel.value)) {
    input.foldLevel = foldLevel.value
  }
  if (layerView instanceof HTMLSelectElement && isLayerView(layerView.value)) {
    input.layerView = layerView.value
  }
  if (agent instanceof HTMLSelectElement && agent.value !== '') {
    input.chatAgent = /** @type {import('./contract-types.js').ChatAgent} */ (agent.value)
  }
  if (model instanceof HTMLInputElement) {
    input.chatModel = model.value.trim() === '' ? null : model.value.trim()
  }
  if (timeout instanceof HTMLInputElement && timeout.value !== '') {
    input.chatTimeoutSec = Number(timeout.value)
  }
  if (turns instanceof HTMLInputElement) {
    input.maxTurns = turns.value.trim() === '' ? null : Number(turns.value)
  }
  if (checkoutEnabled instanceof HTMLInputElement) {
    input.checkoutEnabled = checkoutEnabled.checked
  }
  if (checkoutIdle instanceof HTMLInputElement && checkoutIdle.value !== '') {
    input.checkoutIdleDays = Number(checkoutIdle.value)
  }
  if (checkoutSweep instanceof HTMLInputElement && checkoutSweep.value !== '') {
    input.checkoutSweepMinutes = Number(checkoutSweep.value)
  }
  return input
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {SettingsApi} api
 * @param {((data: SettingsResponse) => void) | undefined} onSaved
 */
export function wireSettingsDialog(dialog, api, onSaved) {
  let checkoutsLoaded = false
  /** The checkout list walks every checkout on disk, so it loads only once its tab is shown. */
  const loadCheckouts = () => {
    // With chat off there is no Checkouts tab.
    const panel = dialog.querySelector('#settings-panel-checkouts')
    if (checkoutsLoaded || !(panel instanceof HTMLElement) || panel.hidden) {
      return
    }
    const list = /** @type {HTMLElement} */ (panel.querySelector('.checkout-list'))
    checkoutsLoaded = true
    void (async () => {
      try {
        list.innerHTML = checkoutListHtml(await api.fetchCheckouts())
      } catch (err) {
        list.innerHTML = `<p class="muted small">could not list the checkouts: ${esc(err instanceof Error ? err.message : String(err))}</p>`
      }
    })()
  }
  /**
   * Shows one tab's panel. The markup gives every tab a `data-tab` and a panel it controls.
   * @param {HTMLElement} chosen
   */
  const selectTab = chosen => {
    for (const tab of dialog.querySelectorAll('[role="tab"]')) {
      const selected = tab === chosen
      tab.setAttribute('aria-selected', String(selected))
      tab.setAttribute('tabindex', selected ? '0' : '-1')
      const panel = /** @type {HTMLElement} */ (dialog.querySelector(`#${tab.getAttribute('aria-controls')}`))
      panel.hidden = !selected
    }
    rememberTab(/** @type {SettingsTab} */ (chosen.dataset['tab']))
    loadCheckouts()
  }
  loadCheckouts()
  dialog.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    const current = /** @type {Element} */ (event.target).closest('[role="tab"]')
    if (step === undefined || current === null) {
      return
    }
    const tabs = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('[role="tab"]')])
    const next = /** @type {HTMLElement} */ (
      tabs[(tabs.indexOf(/** @type {HTMLElement} */ (current)) + step + tabs.length) % tabs.length]
    )
    event.preventDefault()
    selectTab(next)
    next.focus()
  })
  dialog.addEventListener('change', event => {
    if (event.target instanceof HTMLSelectElement && event.target.id === CHAT_AGENT_ID) {
      const list = dialog.querySelector(`#${CHAT_MODEL_LIST_ID}`)
      if (list !== null) {
        list.innerHTML = modelOptionsHtml(event.target.value)
      }
    }
  })
  dialog.addEventListener('click', event => {
    const el = event.target instanceof Element ? event.target.closest('[data-act]') : null
    if (!(el instanceof HTMLElement)) {
      return
    }
    const act = el.getAttribute('data-act')
    if (act === 'settings-tab') {
      selectTab(el)
      return
    }
    if (act === 'settings-close') {
      dialog.close()
      return
    }
    if (act === 'settings-save') {
      void runCommand(
        el,
        async () => {
          const saved = await api.saveSettings(readSettingsForm(dialog))
          onSaved?.(saved)
          dialog.close()
        },
        { pendingLabel: 'saving…' }
      )
      return
    }
    if (act === 'settings-probe') {
      const agent = qs(`#${CHAT_AGENT_ID}`, dialog)
      const id = agent instanceof HTMLSelectElement ? agent.value : ''
      void runCommand(
        el,
        async () => {
          const result = await api.probeAgent(id)
          const out = dialog.querySelector('.probe-result')
          if (out !== null) {
            out.textContent = result.ok
              ? `${result.id} answered in ${Math.round(result.ms / 100) / 10}s${result.cached ? ' (cached)' : ''}`
              : `${result.id} failed: ${result.message ?? result.code ?? 'unknown'}`
          }
        },
        { pendingLabel: 'testing…' }
      )
    }
  })
}
