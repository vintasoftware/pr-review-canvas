// `pr-review` with no command, `pr-review --help`, and `pr-review <command> --help`. One block per
// command, wrapped to the terminal, so a flag stays on one line.
import type { Writable } from 'node:stream'
import { styleText } from 'node:util'
import { intro, log, outro } from '@clack/prompts'
import { contentWidth, streamColumns, wrapParagraph } from './cli-text.js'
import { DEFAULT_PORT } from './config.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR } from './review/install-skill.js'

interface Flag {
  form: string
  detail?: string
}

interface CommandHelp {
  /** The invocation, in bold. A positional argument lives here. */
  name: string
  summary: string
  flags: Flag[]
  notes?: string[]
}

const COMMANDS: CommandHelp[] = [
  {
    name: 'serve',
    summary: 'Start the local review server.',
    flags: [
      { form: '--port <n>', detail: `default ${DEFAULT_PORT}` },
      { form: '--fixture-canvas <review.json>', detail: 'preview this canvas for every pull request' },
      { form: '--no-open', detail: 'leave the browser closed (also when CI is set)' },
      { form: '--chat-agent claude|codex', detail: 'the AI Chat agent for this run' },
      { form: '--chat-model <id>', detail: 'the AI Chat model for this run' },
    ],
    notes: [
      '--chat-agent and --chat-model win over .pr-review/settings.yml. They set AI Chat only, not canvas generation. --agent and --model are deprecated aliases.',
    ],
  },
  {
    name: 'prepare',
    summary: 'Collect a pull request, the current branch, or the working tree.',
    flags: [
      { form: '--pr <n>' },
      { form: '--branch', detail: 'the current branch against the default branch' },
      { form: '--uncommitted', detail: 'that branch, plus edits and new files' },
      { form: '--base <ref> --head <ref>', detail: 'any two refs' },
      { form: '--base <ref>', detail: 'with --branch or --uncommitted, another base' },
      { form: '--force' },
    ],
    notes: [
      '--branch and --uncommitted are for work with no pull request yet. They show at /review/branch and /review/uncommitted.',
    ],
  },
  {
    name: 'validate <model.json|review.json>',
    summary: 'Check a model file against a canvas.',
    flags: [
      { form: '--canvas <dir>' },
      { form: '--human', detail: 'print text instead of JSON' },
      { form: '--fix', detail: 'trim over-cap titles in place and report each one' },
    ],
  },
  {
    name: 'publish <canvasDir>',
    summary: 'Validate a canvas and share it.',
    flags: [
      { form: '--agent <id>', detail: 'the agent that generated the canvas' },
      { form: '--model <id>', detail: 'the model that generated it' },
      { form: '--harness claude-code|codex|other' },
      { form: '--allow-stale', detail: 'the prepared commit, after the head has moved' },
    ],
    notes: [
      '--agent and --model record who generated the canvas. generation.models in pr-review.config.yml sets the default generation model for the project.',
    ],
  },
  {
    name: 'install-skill',
    summary: 'Copy the skill into Claude Code and Codex.',
    flags: [
      { form: '--claude-dir <dir>', detail: `default ${CLAUDE_SKILLS_DIR}` },
      { form: '--codex-dir <dir>', detail: `default ${CODEX_SKILLS_DIR}` },
      { form: '--force' },
    ],
  },
  {
    name: 'export',
    summary: 'Write a canvas zip.',
    flags: [{ form: '--pr <n>' }, { form: '--head <ref|sha>' }, { form: '--out <file|dir>' }],
    notes: ['With both --pr and --head, the named commit is exported and the number stamps the zip.'],
  },
  {
    name: 'import <zip>',
    summary: 'Load a canvas zip.',
    flags: [{ form: '--pr <n>' }, { form: '--force' }],
  },
  {
    name: 'doctor',
    summary: 'Check git, the host CLI, the data directory, and the skill.',
    flags: [
      { form: '--all-checks', detail: 'also check that acpx runs' },
      { form: '--json', detail: 'the same report as one JSON line' },
    ],
  },
  {
    name: 'upgrade',
    summary: 'Update pr-review, acpx, and skill copies in the project.',
    flags: [{ form: '--yes', detail: 'apply without asking' }, { form: '--only package,acpx,skill' }],
    notes: [
      'Updates pr-review and acpx with npm, and refreshes skill copies in the project. Lists the changes and asks first, unless --yes.',
    ],
  },
]

const SHARED: CommandHelp = {
  name: 'Shared flags',
  summary: 'Where the command runs, and where it stores canvases.',
  flags: [
    { form: '--repo <dir>', detail: 'the current directory when omitted' },
    { form: '--data-dir <dir>', detail: 'every command except install-skill and upgrade' },
  ],
}

const OUTPUT = [
  'A command prints one JSON line on success, and `{ "error": { code, message, hint } }` on failure.',
  'doctor prints a checklist, for a person or an agent. Pass --json for that same report as one JSON line.',
  'Exit codes: 0 ok, 1 error, 2 usage, 4 gh or glab missing or not logged in, 5 invalid model output.',
]

function renderFlags(flags: Flag[], width: number): string[] {
  const longest = flags.reduce(
    (max, flag) => (flag.detail === undefined ? max : Math.max(max, flag.form.length)),
    0
  )
  const column = longest + 2
  const lines: string[] = []
  for (const flag of flags) {
    if (flag.detail === undefined) {
      lines.push(`  ${flag.form}`)
      continue
    }
    const head = `  ${flag.form.padEnd(column)}`
    if (head.length + flag.detail.length <= width) {
      lines.push(head + flag.detail)
      continue
    }
    lines.push(`  ${flag.form}`)
    for (const line of wrapParagraph(flag.detail, Math.max(20, width - 4))) {
      lines.push(`    ${line}`)
    }
  }
  return lines
}

function renderBlock(command: CommandHelp, width: number, output: Writable): string {
  const body = width - 2
  const summary = wrapParagraph(command.summary, body).map(line => `  ${line}`)
  const notes = (command.notes ?? []).flatMap(note => wrapParagraph(note, body).map(line => `  ${line}`))
  return [
    styleText('bold', command.name, { stream: output }),
    ...summary,
    ...renderFlags(command.flags, width),
    ...notes,
  ].join('\n')
}

function renderOutput(width: number, output: Writable): string {
  const lines = OUTPUT.flatMap(paragraph => wrapParagraph(paragraph, width - 2).map(line => `  ${line}`))
  return [styleText('bold', 'Output', { stream: output }), ...lines].join('\n')
}

/**
 * Writes the help page to `output`, wrapped to its width. With a command, as for
 * `pr-review serve --help`, the page holds that command's block and the shared flags.
 */
export function printUsage(output: Writable, version: string, command?: string): void {
  const width = contentWidth(streamColumns(output))
  const guide = { output, withGuide: true } as const
  const one = COMMANDS.find(help => help.name.split(' ')[0] === command)
  intro(`pr-review ${version}`, guide)
  log.message(`pr-review ${one === undefined ? '<command>' : one.name} [flags]`, { ...guide, spacing: 1 })
  for (const block of one === undefined ? [SHARED, ...COMMANDS] : [one, SHARED]) {
    log.message(renderBlock(block, width, output), { ...guide, spacing: 1 })
  }
  log.message(renderOutput(width, output), { ...guide, spacing: 1 })
  outro('', guide)
}
