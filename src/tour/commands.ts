// `pr-review tour <prepare|validate|preview|publish|plan|gallery|hunk|checkout>`: the tour's own steps, mirroring
// the canvas commands. Everything is injected: the AppContext carries git, the host, and the stores.
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { HARNESSES } from '../contract/review-artifact.js'
import { budgetLimits, formatTourError } from '../contract/tour.js'
import { type CliIo, EXIT, PREPARE_OPTIONS, parsePrepareTarget, printJson, UsageError } from '../commands.js'
import { keyToString, type ReviewKey } from '../contract/review-key.js'
import { PublishError } from '../review/publish.js'
import { createPrLoader } from '../server/bundle.js'
import type { AppContext } from '../server/context.js'
import { tourReviewer } from './bundle.js'
import { lookupTour } from './lookup.js'
import { planOf } from './plan.js'
import { readReaderState } from './reader.js'
import { startQuietServer } from '../server/node-server.js'
import {
  TOUR_PREVIEW_OPTIONS as PREVIEW_OPTIONS,
  TOUR_PUBLISH_OPTIONS as PUBLISH_OPTIONS,
  TOUR_VALIDATE_OPTIONS as VALIDATE_OPTIONS,
} from './named-dir.js'
import { renderGallery } from './gallery.js'
import { HunkNotFound, tourChunk } from './hunk.js'
import { CheckoutBusyError } from '../chat/checkouts.js'
import { AppError } from '../server/errors.js'
import { prepareTour } from './prepare.js'
import { headlessScreenshot, previewTour } from './preview.js'
import { publishTour, readTourContext, readTourModel, tourValidationInput } from './publish.js'
import { validateTourModel } from './validate.js'

export const TOUR_STEPS = [
  'prepare',
  'validate',
  'preview',
  'publish',
  'plan',
  'gallery',
  'hunk',
  'checkout',
] as const
export type TourStep = (typeof TOUR_STEPS)[number]

/** The step named, or a usage error naming them all. */
export function parseTourStep(argv: string[]): { step: TourStep; rest: string[] } {
  const [step, ...rest] = argv
  const hit = TOUR_STEPS.find(s => s === step)
  if (hit === undefined) {
    throw new UsageError(`tour takes a step: pr-review tour <${TOUR_STEPS.join('|')}> …`)
  }
  return { step: hit, rest }
}

function parseHarness(raw: string | undefined): (typeof HARNESSES)[number] {
  const hit = HARNESSES.find(h => h === raw)
  if (hit === undefined) throw new UsageError(`tour publish needs --harness <${HARNESSES.join('|')}>`)
  return hit
}

export async function runTour(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { step, rest } = parseTourStep(argv)
  switch (step) {
    case 'prepare':
      return runTourPrepare(ctx, rest, io)
    case 'validate':
      return runTourValidate(ctx, rest, io)
    case 'preview':
      return runTourPreview(ctx, rest, io)
    case 'plan':
      return runTourPlan(ctx, rest, io)
    case 'gallery':
      return runTourGallery(ctx, rest, io)
    case 'hunk':
      return runTourHunk(rest, io)
    case 'checkout':
      return runTourCheckout(ctx, rest, io)
    default:
      return runTourPublish(ctx, rest, io)
  }
}

/**
 * `tour plan (--pr <n> | --branch | --uncommitted)`: the plan a finished tour settled on, for the
 * apply skill: the prompt as written at finish, and where it is.
 */
async function runTourPlan(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { pr: { type: 'string' }, branch: { type: 'boolean' }, uncommitted: { type: 'boolean' } },
    strict: true,
  })
  const target = parsePrepareTarget(values)
  const key: ReviewKey =
    target.kind === 'pr' ? target.number : target.kind === 'local' ? target.source : 'branch'
  const found = await lookupTour(ctx, createPrLoader(ctx), key)
  if (found.status === 'missing') {
    throw new PublishError('NOT_FOUND', `no tour of ${keyToString(key)}`, 'generate one with /pr-tour')
  }
  const reviewer = await tourReviewer(ctx, key, found.pr)
  const reader = await readReaderState(ctx, found.headSha, found.artifact, reviewer.author)
  const tourDir = ctx.tours.tourDir(found.headSha)
  const finished = reader.finished
  if (finished === undefined) {
    printJson(io, {
      status: 'unfinished',
      headSha: found.headSha,
      tourDir,
      tourUrl: `http://localhost:${ctx.config.port}${ctx.config.basePath}tour/${keyToString(key)}`,
    })
    return EXIT.ok
  }
  const plan = planOf(found.artifact, reader)
  printJson(io, {
    status: 'finished',
    headSha: found.headSha,
    tourDir,
    promptPath: finished.promptPath,
    prompt: finished.prompt,
    finishedAt: finished.at,
    changes: plan.changes.length,
    kept: plan.kept.length,
    stale: found.status === 'stale',
  })
  return EXIT.ok
}

async function runTourPrepare(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: argv, options: PREPARE_OPTIONS, strict: true })
  const result = await prepareTour(ctx, parsePrepareTarget(values), {
    force: values.force === true,
    log: phase => io.stderr(phase),
  })
  printJson(io, result)
  return EXIT.ok
}

/** `tour validate <tour-model.json> --tour <dir> [--human]`: the report as one JSON line, or as lines. */
async function runTourValidate(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: VALIDATE_OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  const file = positionals[0]
  if (file === undefined || positionals.length > 1) {
    throw new UsageError(
      'tour validate takes one file: pr-review tour validate <tour-model.json> --tour <dir>'
    )
  }
  if (values.tour === undefined)
    throw new UsageError('tour validate needs --tour <dir> (the tourDir prepare printed)')
  const context = await readTourContext(path.resolve(values.tour))
  const model = await readTourModel(context, path.resolve(file))
  const report =
    'error' in model
      ? { ok: false, errors: [{ code: 'SCHEMA' as const, where: '(root)', message: model.error.message }] }
      : validateTourModel(model.raw, tourValidationInput(context))
  if (values.human !== true) {
    printJson(io, { ok: report.ok, errors: report.errors })
    return report.ok ? EXIT.ok : EXIT.invalid
  }
  if ('output' in report && report.output !== null) {
    const { landmarks, decisions, quiz } = report.output
    const b = context.budget
    // The state landmark is never counted against the budget, so it is named apart.
    const counted = landmarks.filter(l => l.state !== true)
    const whys = counted.filter(l => l.stage === 'why').length
    const limits = budgetLimits(b, counted.length, whys)
    io.stdout(
      `ok: ${path.basename(file)} passes: ${whys} why landmarks (budget ${b.why}, ceiling ${b.whyMax})${counted.length < landmarks.length ? ' and the state landmark' : ''}, ${decisions.length} decisions (budget ${limits.decisions}), ${quiz.length} questions (budget ${limits.quiz})`
    )
  } else {
    for (const e of report.errors) io.stdout(formatTourError(e))
  }
  return report.ok ? EXIT.ok : EXIT.invalid
}

/** `tour preview <dir> [--landmark <id>]`: screenshots of the tour as written, before it is published. */
async function runTourPreview(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: PREVIEW_OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  const tourDir = positionals[0]
  if (tourDir === undefined || positionals.length > 1) {
    throw new UsageError(
      'tour preview takes one directory: pr-review tour preview <tourDir> [--landmark <id>]'
    )
  }
  const result = await previewTour(
    ctx,
    path.resolve(tourDir),
    {
      env: process.env,
      platform: process.platform,
      startServer: startQuietServer,
      screenshot: headlessScreenshot,
    },
    { landmark: values.landmark }
  )
  printJson(io, result)
  return EXIT.ok
}

/**
 * `tour gallery [<slug>…] [--out <dir>]`: the scene gallery's entries, or the named ones drawn as
 * pictures for the generator to look at before it draws its own, into `<data dir>/gallery` unless
 * `--out` names another folder.
 */
async function runTourGallery(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { out: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const result = await renderGallery(
    positionals,
    { env: process.env, platform: process.platform, screenshot: headlessScreenshot },
    { outDir: values.out === undefined ? path.join(ctx.config.dataDir, 'gallery') : path.resolve(values.out) }
  )
  printJson(io, result)
  return result.status === 'unknown' ? EXIT.invalid : EXIT.ok
}

/**
 * `tour checkout <tourDir> <head|base> [--remove]`: a git worktree at the tour's head or merge base,
 * where the generator runs a try-it recipe or a script the change touches, never in the reader's
 * checkout. The head is the review's own checkout, the one AI Chat reads; the base has one of its
 * own. A ref comparison has no review, so it has no checkout. Prints `{ side, dir, sha, port,
 * scratch }`: a port nothing listens on, and an empty folder in the tour dir for the run's state, so
 * a server started there touches neither the reader's ports nor their data dir, which every
 * worktree of the clone shares. `base --remove` takes the base checkout away once the generator is
 * done with it; the head stays, for AI Chat.
 */
async function runTourCheckout(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { remove: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const [tourDir, side] = positionals
  if (tourDir === undefined || (side !== 'head' && side !== 'base') || positionals.length > 2) {
    throw new UsageError(
      'tour checkout takes a tour directory and a side: pr-review tour checkout <tourDir> <head|base> [--remove]'
    )
  }
  if (values.remove === true && side === 'head') {
    throw new UsageError(
      'the head checkout stays: AI Chat reads it, and the idle sweep removes it once unused; remove the base only'
    )
  }
  const context = await readTourContext(path.resolve(tourDir))
  const target = context.target
  if (target.kind === 'refs') {
    throw new UsageError(
      'tour checkout needs a review (a pull request, the branch, or uncommitted work); a ref comparison has no checkout'
    )
  }
  const key = target.kind === 'pr' ? target.number : target.source
  const busy = (err: unknown): unknown =>
    err instanceof CheckoutBusyError
      ? new AppError('CHECKOUT_BUSY', err.message, 409, 'wait for what holds it to finish, then run it again')
      : err
  if (values.remove === true) {
    const removed = await ctx.baseCheckouts.remove(key).catch((err: unknown) => {
      throw busy(err)
    })
    await rm(path.join(context.tourDir, 'scratch', 'base'), { recursive: true, force: true })
    printJson(io, { side, removed })
    return EXIT.ok
  }
  const sha = side === 'head' ? context.headSha : context.mergeBaseSha
  let lease
  try {
    lease = await (side === 'head' ? ctx.checkouts : ctx.baseCheckouts).lease(key, 'tour')
  } catch (err) {
    throw busy(err)
  }
  try {
    await lease.moveTo(sha)
  } finally {
    await lease.release()
  }
  const scratch = path.join(context.tourDir, 'scratch', side)
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  printJson(io, { side, dir: lease.dir, sha, port: await freePort(), scratch })
  return EXIT.ok
}

/**
 * `tour hunk <tourDir> <hunk id> [--from <line> --to <line>]`: a code chunk for the model, the
 * whole hunk or the lines of a new-side range, as one JSON object to paste.
 */
async function runTourHunk(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { from: { type: 'string' }, to: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const [tourDir, id] = positionals
  if (tourDir === undefined || id === undefined || positionals.length > 2) {
    throw new UsageError('tour hunk takes a tour directory and a hunk id: pr-review tour hunk <tourDir> <id>')
  }
  const line = (raw: string | undefined, name: string) => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`tour hunk --${name} takes a line number`)
    return n
  }
  const from = line(values.from, 'from')
  const to = line(values.to, 'to')
  if ((from === undefined) !== (to === undefined)) {
    throw new UsageError('tour hunk takes --from and --to together, or neither for the whole hunk')
  }
  const context = await readTourContext(path.resolve(tourDir))
  try {
    printJson(
      io,
      await tourChunk(context, id, from === undefined || to === undefined ? undefined : { from, to })
    )
  } catch (err) {
    if (err instanceof HunkNotFound) throw new UsageError(err.message)
    throw err
  }
  return EXIT.ok
}

async function runTourPublish(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: PUBLISH_OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  const tourDir = positionals[0]
  if (tourDir === undefined || positionals.length > 1) {
    throw new UsageError(
      'tour publish takes one directory: pr-review tour publish <tourDir> --agent <id> --harness <id>'
    )
  }
  if (values.agent === undefined || values.agent === '')
    throw new UsageError('tour publish needs --agent <id>')
  const result = await publishTour(ctx, path.resolve(tourDir), {
    agent: values.agent,
    model: values.model,
    harness: parseHarness(values.harness),
    allowStale: values['allow-stale'] === true,
  })
  if (result.sharing.status === 'failed')
    io.stderr(`${result.sharing.warning} ZIP: ${result.sharing.zipPath}`)
  printJson(io, result)
  return EXIT.ok
}

/** A port nothing listens on now, picked by the system. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}
