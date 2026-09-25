// The doctor checklist. The same text is what a person scans and what an agent reads back: each
// row says `ok` or `failed` in words, and a failure keeps its hint. Color and the gutter mark the
// same fact; they are not the only place it is said. The JSON keys stay `gh` and `ghAuth` for
// either forge. The label names the CLI the report says those checks ran.
import type { Writable } from 'node:stream'
import { styleText } from 'node:util'
import { intro, log, outro } from '@clack/prompts'
import { contentWidth, streamColumns, wrapParagraph } from '../cli-text.js'
import type { HostCli } from '../host/client.js'
import { DOCTOR_CHECKS, type DoctorCheck, type DoctorReport } from './doctor.js'

const LABEL = 10
const STATUS = 6

type CheckName = keyof DoctorReport['checks']

/** Every check in print order; `acpx` is in a report only under `--all-checks`. */
const ORDER: readonly CheckName[] = [...DOCTOR_CHECKS, 'acpx']

function labelFor(name: CheckName, cli: HostCli): string {
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

/** Writes the checklist to `output`, wrapped to its width. */
export function printDoctorReport(report: DoctorReport, output: Writable): void {
  const width = contentWidth(streamColumns(output))
  const guide = { output, withGuide: true } as const
  intro(`pr-review doctor ${report.version}`, guide)
  const present = ORDER.flatMap(name => {
    const check = report.checks[name]
    return check === undefined ? [] : [{ name, check }]
  })
  for (const [i, { name, check }] of present.entries()) {
    const write = check.ok ? log.success : log.error
    write(formatCheck(labelFor(name, report.cli), check, width, output), {
      ...guide,
      spacing: i === 0 ? 1 : 0,
    })
  }
  outro(styleText(report.ok ? 'green' : 'red', closing(report), { stream: output }), guide)
}
