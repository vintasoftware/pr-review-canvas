/** The exact command the user runs in Claude Code or Codex to generate a canvas for a PR. */
export function buildSkillCommand(prNumber: number, opts: { force: boolean }): string {
  return `/pr-review-canvas ${prNumber}${opts.force ? ' --force' : ''}`
}
