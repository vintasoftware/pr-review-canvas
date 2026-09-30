// The tour dir a command line names, read before the context is built so the data dir can follow
// it. On its own so `commands.ts` can read it without importing the tour commands, which import
// `commands.ts` themselves.
import { parseArgs } from 'node:util'

export const TOUR_VALIDATE_OPTIONS = { tour: { type: 'string' }, human: { type: 'boolean' } } as const
export const TOUR_PUBLISH_OPTIONS = {
  agent: { type: 'string' },
  model: { type: 'string' },
  harness: { type: 'string' },
  'allow-stale': { type: 'boolean' },
} as const
export const TOUR_PREVIEW_OPTIONS = { landmark: { type: 'string' } } as const

/** `tour validate --tour <dir>`, `tour preview <dir>`, or `tour publish <dir>`; undefined otherwise. Never throws. */
export function namedTourDir(argv: string[]): string | undefined {
  const [step, ...rest] = argv
  if (step === 'validate') {
    const { tour } = parseArgs({
      args: rest,
      options: TOUR_VALIDATE_OPTIONS,
      allowPositionals: true,
      strict: false,
    }).values
    return typeof tour === 'string' ? tour : undefined
  }
  if (step === 'publish' || step === 'preview') {
    return parseArgs({
      args: rest,
      options: step === 'publish' ? TOUR_PUBLISH_OPTIONS : TOUR_PREVIEW_OPTIONS,
      allowPositionals: true,
      strict: false,
    }).positionals[0]
  }
  return undefined
}

/** The steps that work inside the data dir prepare made, so they create none. */
export function tourStepCreatesDataDir(argv: string[]): boolean {
  return argv[0] === 'prepare'
}
