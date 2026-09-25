// The doctor checklist. The same text is what a person scans and what an agent reads back: each
// row says `ok` or `failed` in words, and a failure keeps its hint. Color and the gutter mark the
// same fact; they are not the only place it is said. The JSON keys stay `gh` and `ghAuth` for
// either forge. The label says `glab` when the origin check resolved a GitLab remote.
import type { Writable } from 'node:stream'
import { styleText } from 'node:util'
import { intro, log, outro } from '@clack/prompts'
import { contentWidth, wrapParagraph } from '../cli-text.js'
import { DOCTOR_CHECKS, type DoctorCheck, type DoctorCheckName, type DoctorReport } from './doctor.js'

const LABEL = 10
const STATUS = 6

function cliName(report: DoctorReport): 'gh' | 'glab' {
  const origin = report.checks.origin
  return origin.ok && origin.detail.endsWith('(GitLab)') ? 'glab' : 'gh'
}

function labelFor(name: DoctorCheckName | 'acpx', cli: 'gh' | 'glab'): string {
  switch (name) {
    case 'git':
    case 'origin':
    case 'skill':
    case 'acpx':
      return name
    case 'dataDir':
      return 'data dir'
    case 'gh':
      return cli
    case 'ghAuth':
      return `${cli} login`
  }
}

function formatCheck(label: string, check: DoctorCheck, width: number, output: Writable): string {
  const prefix = LABEL + 2 + STATUS + 2
  const gutter = ' '.repeat(prefix)
  const budget = Math.max(16, width - prefix)
  const detail = wrapParagraph(check.detail, budget)
  const status = styleText(check.ok ? 'green' : 'red', (check.ok ? 'ok' : 'failed').padEnd(STATUS), {
    stream: output,
  })
  const first = `${styleText('bold', label.padEnd(LABEL), { stream: output })}  ${status}  ${detail[0] ?? ''}`
  const more = detail.slice(1).map(line => `${gutter}${line}`)
  const hint =
    check.hint === undefined
      ? []
      : wrapParagraph(check.hint, budget).map(
          line => `${gutter}${styleText('dim', line, { stream: output })}`
        )
  return [first, ...more, ...hint].join('\n')
}

function closing(report: DoctorReport): string {
  const failed = Object.values(report.checks).filter(check => !check.ok).length
  if (failed === 0) return 'All checks passed'
  return failed === 1 ? '1 check failed' : `${failed} checks failed`
}

/** Writes the checklist to `output`. `columns` is the terminal width, guide included. */
export function printDoctorReport(report: DoctorReport, output: Writable, columns = 80): void {
  const width = contentWidth(columns)
  const guide = { output, withGuide: true } as const
  const cli = cliName(report)
  intro(`pr-review doctor ${report.version}`, guide)
  let first = true
  for (const name of DOCTOR_CHECKS) {
    const message = formatCheck(labelFor(name, cli), report.checks[name], width, output)
    const write = report.checks[name].ok ? log.success : log.error
    write(message, { ...guide, spacing: first ? 1 : 0 })
    first = false
  }
  if (report.checks.acpx !== undefined) {
    const acpx = report.checks.acpx
    const write = acpx.ok ? log.success : log.error
    write(formatCheck(labelFor('acpx', cli), acpx, width, output), { ...guide, spacing: 0 })
  }
  const tone = Object.values(report.checks).every(check => check.ok) ? 'green' : 'red'
  outro(styleText(tone, closing(report), { stream: output }), guide)
}
