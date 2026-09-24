// @ts-check
// The settings dialog: the personal settings this browser can change, the reading level a review
// opens at, how layers show, and the chat settings, and a read-only look at the project config,
// which is committed and belongs to the repository.
/** @typedef {import('./contract-types.js').AgentsResponse} AgentsResponse */
/** @typedef {import('./contract-types.js').SettingsResponse} SettingsResponse */
import { fetchAgents, fetchSettings, probeAgent, saveSettings } from './api.js'
import { runCommand } from './commands.js'
import { esc, qs } from './dom.js'
import { isFoldLevel } from './fold-levels.js'
import { isLayerView, LAYER_VIEW_LABELS, LAYER_VIEWS } from './layer-views.js'
import { foldLevelOptionsHtml } from './reading-level.js'

export const SETTINGS_DIALOG_ID = 'settings-dialog'

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
 * Model ids the input suggests per agent. Free text is allowed; this is only a shortcut. The
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
 * The chat agent's fields, with the notice about acpx when it is missing.
 * @param {SettingsResponse['settings']} settings
 * @param {AgentsResponse} agents
 * @returns {string}
 */
function chatFieldsHtml(settings, agents) {
  const options = agents.agents
    .map(a => {
      const reason = a.available ? '' : ` (${a.reason ?? 'not available'})`
      return `<option value="${esc(a.id)}"${a.id === settings.agent ? ' selected' : ''}${a.available ? '' : ' disabled'}>${esc(a.id)}${esc(reason)}</option>`
    })
    .join('')
  return (
    (agents.acpx.installed
      ? ''
      : '<p class="notice" role="status">acpx is not on PATH, so AI Chat is off. Install acpx and reload.</p>') +
    '<div class="field"><label for="set-agent">Agent</label>' +
    `<select id="set-agent">${options}</select></div>` +
    '<div class="field"><label for="set-model">Model</label>' +
    `<input id="set-model" list="model-list" value="${esc(settings.model ?? '')}" placeholder="the agent's default">` +
    `<datalist id="model-list">${modelOptionsHtml(settings.agent)}</datalist></div>` +
    '<div class="field"><label for="set-timeout">Chat timeout (seconds)</label>' +
    `<input id="set-timeout" type="number" min="30" max="3600" value="${esc(settings.chatTimeoutSec)}"></div>` +
    '<div class="field"><label for="set-turns">Max turns</label>' +
    `<input id="set-turns" type="number" min="1" max="100" value="${esc(settings.maxTurns ?? '')}" placeholder="the agent's default"></div>` +
    '<p class="muted small">Changing the agent starts a new chat thread; the old ones stay in the list.</p>'
  )
}

/**
 * @param {SettingsResponse} data
 * @param {AgentsResponse | null} agents null when the project turns chat off, so the dialog holds
 *   only what the page itself reads
 * @returns {string}
 */
export function settingsDialogHtml(data, agents) {
  const { settings, overrides, project } = data
  const overrideNote =
    overrides.agent === undefined && overrides.model === undefined
      ? ''
      : `<p class="notice" role="status">A serve flag wins over this file for now: ${esc(
          [
            overrides.agent === undefined ? '' : `--agent ${overrides.agent}`,
            overrides.model === undefined ? '' : `--model ${overrides.model}`,
          ]
            .filter(Boolean)
            .join(' ')
        )}</p>`
  return (
    `<dialog id="${SETTINGS_DIALOG_ID}" class="settings" aria-labelledby="settings-h">` +
    '<h2 id="settings-h">Settings</h2>' +
    overrideNote +
    '<div class="field"><label for="set-fold-level">Hide code by default</label>' +
    `<select id="set-fold-level">${foldLevelOptionsHtml(settings.foldLevel)}</select></div>` +
    '<p class="muted small">The level every review opens at. The Hide code control and the <span class="mono">f</span> key change it for one page.</p>' +
    '<div class="field"><label for="set-layer-view">Show layers</label>' +
    `<select id="set-layer-view">${layerViewOptionsHtml(settings.layerView)}</select></div>` +
    '<p class="muted small">One at a time shows the overview or a single layer. The rail and the <span class="mono">j</span> and <span class="mono">k</span> keys move between them.</p>' +
    (agents === null ? '' : chatFieldsHtml(settings, agents)) +
    `<p class="muted small mono">${esc(data.file)}</p>` +
    '<div class="panel-ro"><h3>Project config (read-only)</h3>' +
    `<ul class="plain"><li>chat enabled: ${project.chatEnabled ? 'yes' : 'no'}</li>` +
    `<li>canvas kept for an identical diff: ${project.keepForIdenticalDiff ? 'yes' : 'no'}</li>` +
    `<li>rulebook: ${esc(project.rulebook ?? 'none')}</li>` +
    `<li>configured layer suggestions: ${project.layers}</li>` +
    `<li>high-risk patterns: ${project.highRisk}</li>` +
    `<li>max repair rounds: ${project.maxRepairRounds}</li>` +
    `<li>inline diff max lines: ${project.inlineDiffMaxLines}</li>` +
    `<li>small change set: ${project.smallPrHunks} chunks</li></ul>` +
    `<p class="muted small mono">${esc(project.file ?? 'built-in defaults (no pr-review.config.yml)')}</p></div>` +
    '<p class="probe-result" role="status"></p>' +
    '<div class="dialog-actions">' +
    (agents === null
      ? ''
      : '<button class="cmd" type="button" data-act="settings-probe">test agent</button>') +
    '<button class="cmd fill" type="button" data-act="settings-save">save</button>' +
    '<button class="cmd" type="button" data-act="settings-close">close</button>' +
    '</div></dialog>'
  )
}

/**
 * The four requests the dialog makes. Tests pass their own.
 * @typedef {{
 *   fetchSettings: typeof fetchSettings,
 *   saveSettings: typeof saveSettings,
 *   fetchAgents: typeof fetchAgents,
 *   probeAgent: typeof probeAgent,
 * }} SettingsApi
 */

/**
 * Opens the dialog, filling it from the server. The caller passes the command that opened it so
 * its pending state shows while the two requests are in flight.
 * @param {HTMLElement} root
 * @param {HTMLElement} opener
 * @param {{ api?: Partial<SettingsApi>, onSaved?: (data: SettingsResponse) => void }} [opts]
 */
export async function openSettingsDialog(root, opener, opts = {}) {
  const api = { fetchSettings, saveSettings, fetchAgents, probeAgent, ...opts.api }
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
  root.insertAdjacentHTML('beforeend', settingsDialogHtml(loaded.data, loaded.agents))
  const dialog = qs(`#${SETTINGS_DIALOG_ID}`, root)
  if (!(dialog instanceof HTMLDialogElement)) {
    return null
  }
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
  const agent = qs('#set-agent', dialog)
  const model = qs('#set-model', dialog)
  const timeout = qs('#set-timeout', dialog)
  const turns = qs('#set-turns', dialog)
  /** @type {import('./contract-types.js').SettingsInput} */
  const input = {}
  if (foldLevel instanceof HTMLSelectElement && isFoldLevel(foldLevel.value)) {
    input.foldLevel = foldLevel.value
  }
  if (layerView instanceof HTMLSelectElement && isLayerView(layerView.value)) {
    input.layerView = layerView.value
  }
  if (agent instanceof HTMLSelectElement && agent.value !== '') {
    input.agent = /** @type {import('./contract-types.js').ChatAgent} */ (agent.value)
  }
  if (model instanceof HTMLInputElement) {
    input.model = model.value.trim() === '' ? null : model.value.trim()
  }
  if (timeout instanceof HTMLInputElement && timeout.value !== '') {
    input.chatTimeoutSec = Number(timeout.value)
  }
  if (turns instanceof HTMLInputElement) {
    input.maxTurns = turns.value.trim() === '' ? null : Number(turns.value)
  }
  return input
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {SettingsApi} api
 * @param {((data: SettingsResponse) => void) | undefined} onSaved
 */
export function wireSettingsDialog(dialog, api, onSaved) {
  dialog.addEventListener('change', event => {
    if (event.target instanceof HTMLSelectElement && event.target.id === 'set-agent') {
      const list = dialog.querySelector('#model-list')
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
      const agent = qs('#set-agent', dialog)
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
