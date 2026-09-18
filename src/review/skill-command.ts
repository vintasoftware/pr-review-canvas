import { keyToString, type ReviewKey } from '../contract/review-key.js'

/** The exact command the user runs in Claude Code or Codex to generate a canvas for a target. */
export function buildSkillCommand(key: ReviewKey, opts: { force: boolean }): string {
  return `/pr-review-canvas ${keyToString(key)}${opts.force ? ' --force' : ''}`
}
