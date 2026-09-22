/**
 * A saved model id names a family, not a frozen version: every turn runs the newest model of it.
 *
 * Claude has family aliases (`opus`, `sonnet[1m]`, ...) that the Claude CLI resolves to its newest
 * model, so a versioned id is rewritten to its alias. GPT has no aliases, and a family's next model can
 * carry a new name (`gpt-5.6-terra` became `gpt-6-sol`), so the Codex catalog's own `upgrade` links
 * are followed instead. `pin:<id>` opts out: the id after it is sent as written.
 */

export const PIN_PREFIX = 'pin:'

/**
 * `claude-opus-4-8`, `claude-sonnet-5[1m]`, `claude-haiku-4-5-20251001`. Bedrock and Vertex ids
 * (`us.anthropic.claude-...`, `claude-...@date`) do not match, so they run as written too.
 */
const CLAUDE_VERSIONED = /^claude-(opus|sonnet|haiku|fable)-\d[\w.-]*?(\[[^\]]+\])?$/i

/** A trailing `[...]` is a setting on the model (`[1m]`, `[high]`), kept across the upgrade. */
const SUFFIX = /^([^[]+)(\[[^\]]+\])?$/

/** Old model slug to the slug that replaced it, as the agent's catalog reports it. */
export type ModelUpgrades = ReadonlyMap<string, string>

export function latestModel(agent: string, model: string, upgrades: ModelUpgrades): string {
  if (model.startsWith(PIN_PREFIX)) {
    return model.slice(PIN_PREFIX.length).trim()
  }
  if (agent === 'claude') {
    const versioned = CLAUDE_VERSIONED.exec(model)
    return versioned === null ? model : `${versioned[1]?.toLowerCase()}${versioned[2] ?? ''}`
  }
  const parts = SUFFIX.exec(model)
  if (parts?.[1] === undefined) {
    return model
  }
  let slug = parts[1]
  const seen = new Set([slug])
  for (let next = upgrades.get(slug); next !== undefined && !seen.has(next); next = upgrades.get(slug)) {
    seen.add(next)
    slug = next
  }
  return `${slug}${parts[2] ?? ''}`
}
