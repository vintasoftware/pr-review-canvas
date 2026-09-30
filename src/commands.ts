// The subcommands behind `pr-review`, with everything injected: the AppContext carries git, gh, and
// the stores; `io` carries stdout/stderr. cli.ts parses the command name and builds both.
import { type FileHandle, open } from 'node:fs/promises'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { exportCanvas } from './canvas/export.js'
import { importCanvas } from './canvas/import.js'
import { CANVAS_ZIP_MAX_BYTES } from './canvas/zip.js'
import type { CheckoutInfo } from './chat/checkouts.js'
import type { ErrorCode, ImportResult } from './contract/api.js'
import { CHECKOUT_IDLE_NEVER } from './contract/settings.js'
import type { GenerationContext, PrepareTargetInput } from './contract/generation-context.js'
import type { LocalKey } from './contract/review-key.js'
import { HARNESSES, type ReviewArtifact, ReviewArtifactSchema } from './contract/review-artifact.js'
import { formatValidationError, type ValidationReport } from './contract/validation.js'
import { fetchPrRefs } from './git/pr-refs.js'
import { type DoctorDeps, runDoctorChecks } from './review/doctor.js'
import { printDoctorReport } from './review/doctor-view.js'
import {
  CLAUDE_SKILLS_DIR,
  CODEX_SKILLS_DIR,
  ignoreLocalSettings,
  installBundledSkills,
  SkillDirExistsError,
} from './review/install-skill.js'
import { artifactToModelOutput } from './review/normalize.js'
import { prepare } from './review/prepare.js'
import {
  ModelInvalidError,
  PublishError,
  parseModelText,
  publish,
  readContext,
  validationInput,
} from './review/publish.js'
import { applyFoldFixes, describeFoldFix, type FoldFix } from './review/fix-folds.js'
import { formatTourError } from './contract/tour.js'
import { namedTourDir } from './tour/named-dir.js'
import { TourInvalidError } from './tour/publish.js'
import { applyTitleTrims, type TitleTrim } from './review/trim-caps.js'
import { validateModelOutput } from './review/validate.js'
import type { AppContext } from './server/context.js'
import { AppError, CLI_SETUP_CODES, toAppError } from './server/errors.js'
import { readText, writeTextAtomic } from './store/atomic-json.js'

export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
  /** Print results and errors as one JSON line instead of text. `outputMode` decides it. */
  json: boolean
}

/** The steps of review generation: the skill reads their JSON, so they print nothing else. */
const AGENT_COMMANDS: ReadonlySet<string> = new Set(['prepare', 'validate', 'publish', 'tour'])

/**
 * Takes `--json` out of a command's arguments and decides whether the command prints JSON: with
 * the flag, on a stdout that is not a terminal (a script or an agent is reading), or for a command
 * only an agent runs. doctor prints its checklist on a pipe too, so only the flag switches it.
 */
export function outputMode(
  command: string,
  args: string[],
  stdoutIsTTY: boolean
): { json: boolean; rest: string[] } {
  const rest = args.filter(arg => arg !== '--json')
  const flag = rest.length !== args.length
  const json = command === 'doctor' ? flag : flag || !stdoutIsTTY || AGENT_COMMANDS.has(command)
  return { json, rest }
}

/** Exit codes: 0 ok, 1 error, 2 usage, 4 gh/glab auth or missing, 5 invalid model output. */
export const EXIT = { ok: 0, error: 1, usage: 2, gh: 4, invalid: 5 } as const

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export function printJson(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value))
}

/** The failure as the JSON envelope, or as an `error:` line and its hint on stderr. */
export function printErrorEnvelope(io: CliIo, code: ErrorCode, message: string, hint?: string): void {
  if (!io.json) {
    io.stderr(`error: ${message} (${code})`)
    if (hint !== undefined) io.stderr(`hint: ${hint}`)
    return
  }
  const error: { code: ErrorCode; message: string; hint?: string } = { code, message }
  if (hint !== undefined) {
    error.hint = hint
  }
  printJson(io, { error })
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function isParseArgsError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code.startsWith('ERR_PARSE_ARGS')
  )
}

/** Prints the envelope for any failure and picks the exit code. */
export function reportFailure(io: CliIo, err: unknown): number {
  if (err instanceof UsageError || isParseArgsError(err)) {
    printErrorEnvelope(io, 'BAD_REQUEST', err.message, 'run pr-review --help')
    return EXIT.usage
  }
  if (err instanceof ModelInvalidError) {
    for (const e of err.report.errors) {
      io.stdout(formatValidationError(e))
    }
    printErrorEnvelope(io, 'MODEL_INVALID', err.message, 'fix model.json and run publish again')
    return EXIT.invalid
  }
  if (err instanceof TourInvalidError) {
    for (const e of err.report.errors) io.stdout(formatTourError(e))
    printErrorEnvelope(
      io,
      'MODEL_INVALID',
      err.message,
      'fix tour-model.json and the scene files, then publish again'
    )
    return EXIT.invalid
  }
  if (err instanceof PublishError) {
    printErrorEnvelope(io, err.code, err.message, err.hint)
    return EXIT.error
  }
  if (err instanceof SkillDirExistsError) {
    printErrorEnvelope(io, 'SKILL_DIR_EXISTS', err.message, 'remove it, or pass --force to replace it')
    return EXIT.error
  }
  const appErr = toAppError(err)
  printErrorEnvelope(io, appErr.code, appErr.message, appErr.hint)
  return CLI_SETUP_CODES.has(appErr.code) ? EXIT.gh : EXIT.error
}

/**
 * Splits `--repo` and `--data-dir`, which every repo-bound command shares, from the command's own
 * flags. The rest keeps its order, so the command's parseArgs sees what the user typed.
 */
export function splitCommonFlags(argv: string[]): {
  repo: string | undefined
  dataDir: string | undefined
  rest: string[]
} {
  const { values, tokens } = parseArgs({
    args: argv,
    options: { repo: { type: 'string' }, 'data-dir': { type: 'string' } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  })
  const rest: string[] = []
  for (const t of tokens) {
    if (t.kind === 'option' && (t.name === 'repo' || t.name === 'data-dir')) {
      continue
    }
    if (t.kind === 'option') {
      if (t.value === undefined) {
        rest.push(t.rawName)
      } else if (t.inlineValue) {
        rest.push(`${t.rawName}=${t.value}`)
      } else {
        rest.push(t.rawName, t.value)
      }
    } else if (t.kind === 'positional') {
      rest.push(t.value)
    }
  }
  return {
    repo: typeof values.repo === 'string' ? values.repo : undefined,
    dataDir: typeof values['data-dir'] === 'string' ? values['data-dir'] : undefined,
    rest,
  }
}

function parsePrNumber(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--pr must be a positive integer, got "${raw}"`)
  }
  return n
}

export interface PrepareFlags {
  pr?: string | undefined
  base?: string | undefined
  head?: string | undefined
  branch?: boolean | undefined
  uncommitted?: boolean | undefined
}

const LOCAL_FLAGS = 'pass one of --pr <n>, --branch, --uncommitted, or --base <ref> --head <ref>'

/** The target the flags name. `prepare` resolves a local review's base against the clone. */
export function parsePrepareTarget(values: PrepareFlags): PrepareTargetInput {
  const local: LocalKey | undefined =
    values.branch === true ? 'branch' : values.uncommitted === true ? 'uncommitted' : undefined
  if (values.branch === true && values.uncommitted === true) {
    throw new UsageError('--branch and --uncommitted are two reviews; ask for one of them')
  }
  if (values.pr !== undefined) {
    if (values.base !== undefined || values.head !== undefined || local !== undefined) {
      throw new UsageError(LOCAL_FLAGS)
    }
    return { kind: 'pr', number: parsePrNumber(values.pr) }
  }
  if (local !== undefined) {
    if (values.head !== undefined) {
      throw new UsageError(`--${local} reviews this clone, so it takes no --head`)
    }
    return { kind: 'local', source: local, base: values.base }
  }
  if (values.base !== undefined && values.head !== undefined) {
    return { kind: 'refs', base: values.base, head: values.head }
  }
  throw new UsageError(`prepare needs a target: ${LOCAL_FLAGS}`)
}

export async function runPrepare(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pr: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      branch: { type: 'boolean' },
      uncommitted: { type: 'boolean' },
      force: { type: 'boolean' },
    },
    strict: true,
  })
  const result = await prepare(ctx, parsePrepareTarget(values), {
    force: values.force === true,
    log: phase => io.stderr(phase),
  })
  printJson(io, result)
  return EXIT.ok
}

/** A stored review.json is checked as the model would have written it; anything else is taken as model output. */
async function validateFile(
  ctx: AppContext,
  parsed: ReturnType<typeof parseModelText>,
  context: GenerationContext
): Promise<ValidationReport> {
  if ('error' in parsed) {
    return { ok: false, errors: [parsed.error] }
  }
  const artifact = ReviewArtifactSchema.safeParse(parsed.raw)
  const input = artifact.success ? artifactToModelOutput(artifact.data satisfies ReviewArtifact) : parsed.raw
  // A stored canvas may predate the rules about what a generation must hide; only its correctness is checked.
  const result = validateModelOutput(input, {
    ...(await validationInput(ctx, context, input)),
    storedArtifact: artifact.success,
  })
  return { ok: result.ok, errors: result.errors }
}

const VALIDATE_OPTIONS = {
  canvas: { type: 'string' },
  human: { type: 'boolean' },
  fix: { type: 'boolean' },
} as const

/**
 * `validate <model.json|review.json> --canvas <dir> [--human] [--fix]`: the report as one JSON
 * line, or as lines. `--fix` first trims the titles that are over their cap, clips, shrinks, or
 * drops the folds that break a rule with one right answer, and writes the file back, so the only
 * problems left to answer are the ones that need judgment.
 */
export async function runValidate(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: VALIDATE_OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  const file = positionals[0]
  if (file === undefined || positionals.length > 1) {
    throw new UsageError(
      'validate takes one file: pr-review validate <model.json|review.json> --canvas <dir>'
    )
  }
  if (values.canvas === undefined) {
    throw new UsageError('validate needs --canvas <dir> (the directory prepare printed)')
  }
  const context = await readContext(path.resolve(values.canvas))
  const text = await readText(path.resolve(file))
  if (text === null) {
    throw new PublishError(
      'NOT_FOUND',
      `${file} does not exist`,
      'pass the model.json or review.json to check'
    )
  }
  const fixed =
    values.fix === true
      ? await fixModel(
          path.resolve(file),
          text,
          context,
          (await ctx.derived.ensure(context.headSha, context.mergeBaseSha)).patches
        )
      : { text, trims: [], folds: [] }
  const report = await validateFile(ctx, parseModelText(fixed.text, path.basename(file)), context)
  if (values.human !== true) {
    printJson(io, values.fix === true ? { ...report, fixed: [...fixed.folds, ...fixed.trims] } : report)
    return report.ok ? EXIT.ok : EXIT.invalid
  }
  for (const fold of fixed.folds) {
    io.stdout(`fixed ${fold.where}: ${describeFoldFix(fold)}`)
  }
  for (const trim of fixed.trims) {
    if (trim.outcome === 'fixed') {
      io.stdout(`fixed ${trim.where}: "${trim.from}" -> "${trim.to}"`)
    } else {
      io.stdout(
        `unfixable ${trim.where}: ${trim.length} visible chars, cap ${trim.cap}, ${trim.reason}; rewrite by hand`
      )
    }
  }
  if (report.ok) {
    io.stdout(`ok: ${path.basename(file)} passes against ${context.files.length} files`)
  } else {
    for (const e of report.errors) {
      io.stdout(formatValidationError(e))
    }
  }
  return report.ok ? EXIT.ok : EXIT.invalid
}

/**
 * Trims the over-cap titles of a model file, repairs its mechanically broken folds, and writes it
 * back. Returns the text to validate, unchanged when nothing needed fixing, so a file that is
 * already fine is never rewritten. A stored review.json keeps the folds it was published with.
 */
async function fixModel(
  file: string,
  text: string,
  context: GenerationContext,
  patches: Readonly<Record<string, string>>
): Promise<{ text: string; trims: TitleTrim[]; folds: FoldFix[] }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // An unparseable file has nothing to fix; the validator reports the syntax error.
    return { text, trims: [], folds: [] }
  }
  // Folds first, so every reported path, a trimmed fold title's included, is one into the file
  // as written back.
  const folds = ReviewArtifactSchema.safeParse(parsed).success
    ? []
    : applyFoldFixes(parsed, context.files, patches)
  const trims = applyTitleTrims(parsed, context.caps)
  if (!trims.some(trim => trim.outcome === 'fixed') && folds.length === 0) {
    return { text, trims, folds }
  }
  const next = `${JSON.stringify(parsed, null, 2)}\n`
  await writeTextAtomic(file, next)
  return { text: next, trims, folds }
}

function parseHarness(raw: string | undefined): (typeof HARNESSES)[number] {
  if (raw === undefined) {
    throw new UsageError(`publish needs --harness <${HARNESSES.join('|')}>`)
  }
  const hit = HARNESSES.find(h => h === raw)
  if (hit === undefined) {
    throw new UsageError(`--harness must be one of ${HARNESSES.join(', ')}, got "${raw}"`)
  }
  return hit
}

const PUBLISH_OPTIONS = {
  agent: { type: 'string' },
  model: { type: 'string' },
  harness: { type: 'string' },
  'allow-stale': { type: 'boolean' },
} as const

/**
 * The canvas dir a validate (`--canvas`) or publish (`<canvasDir>`) command line names, read before
 * the context is built so the data dir can follow it. Never throws: the command itself reports a
 * bad command line.
 */
export function namedCanvasDir(command: string, argv: string[]): string | undefined {
  if (command === 'validate') {
    const { canvas } = parseArgs({
      args: argv,
      options: VALIDATE_OPTIONS,
      allowPositionals: true,
      strict: false,
    }).values
    return typeof canvas === 'string' ? canvas : undefined
  }
  if (command === 'publish') {
    return parseArgs({ args: argv, options: PUBLISH_OPTIONS, allowPositionals: true, strict: false })
      .positionals[0]
  }
  if (command === 'tour') {
    return namedTourDir(argv)
  }
  return undefined
}

export async function runPublish(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: PUBLISH_OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  const canvasDir = positionals[0]
  if (canvasDir === undefined || positionals.length > 1) {
    throw new UsageError(
      'publish takes one directory: pr-review publish <canvasDir> --agent <id> --harness <id> [--data-dir <dir>]'
    )
  }
  if (values.agent === undefined || values.agent === '') {
    throw new UsageError('publish needs --agent <id>')
  }
  const result = await publish(ctx, path.resolve(canvasDir), {
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

/**
 * `doctor [--all-checks] [--json]`: every check the tool needs, as a checklist on `output` that a
 * person or an agent can read. With `io.json` it prints one JSON line on `io` instead. Exit 1 when
 * a check fails, so a script can read the code instead of the report.
 */
export async function runDoctor(
  deps: DoctorDeps,
  argv: string[],
  io: CliIo,
  output: Writable
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'all-checks': { type: 'boolean' } },
    strict: true,
  })
  const report = await runDoctorChecks(deps, { allChecks: values['all-checks'] === true })
  if (io.json) {
    printJson(io, report)
  } else {
    printDoctorReport(report, output)
  }
  return report.ok ? EXIT.ok : EXIT.error
}

export interface InstallSkillEnv {
  repoRoot: string
  cwd: string
}

/** `install-skill [--claude-dir <dir>] [--codex-dir <dir>] [--force] [--json]`, both dirs under the repo root by default. */
export async function runInstallSkill(env: InstallSkillEnv, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'claude-dir': { type: 'string' },
      'codex-dir': { type: 'string' },
      force: { type: 'boolean' },
    },
    strict: true,
  })
  const resolve = (flag: string | undefined, fallback: string): string =>
    flag === undefined ? path.join(env.repoRoot, fallback) : path.resolve(env.cwd, flag)
  const result = await installBundledSkills({
    force: values.force === true,
    targets: [
      { kind: 'claude', dir: resolve(values['claude-dir'], CLAUDE_SKILLS_DIR) },
      { kind: 'codex', dir: resolve(values['codex-dir'], CODEX_SKILLS_DIR) },
    ],
  })
  await ignoreLocalSettings(env.repoRoot)
  if (io.json) {
    printJson(io, result)
    return EXIT.ok
  }
  for (const skill of [result, ...result.companions]) {
    io.stdout(`Copied the ${skill.skill} skill to:`)
    for (const target of skill.targets) io.stdout(`  ${target.kind.padEnd(6)}  ${target.path}`)
  }
  return EXIT.ok
}

/** The head a canvas is exported for: a PR's current head, or any ref or sha the user names. */
async function resolveHead(
  ctx: AppContext,
  values: { pr?: string; head?: string }
): Promise<{ headSha: string; prNumber?: number }> {
  const prNumber = values.pr === undefined ? undefined : parsePrNumber(values.pr)
  // With both flags the named commit is the one to export and the number only stamps the zip,
  // which is what the generation skill does right after publishing a canvas for a pull request.
  if (values.head !== undefined) {
    const headSha = await ctx.git.revParse(values.head)
    return prNumber === undefined ? { headSha } : { headSha, prNumber }
  }
  if (prNumber === undefined) {
    throw new UsageError('export needs --pr <n> or --head <ref|sha>')
  }
  const meta = await ctx.config.host.fetchPrMeta(ctx.gh, ctx.config.repo, prNumber)
  const { headSha } = await fetchPrRefs(ctx.git, ctx.config.host, meta)
  return { headSha, prNumber }
}

/** `export (--pr <n> | --head <ref|sha>) [--out <file|dir>] [--json]`: writes the zip and prints its path. */
export async function runExport(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { pr: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  })
  const target = await resolveHead(ctx, values)
  const result = await exportCanvas(ctx, {
    headSha: target.headSha,
    prNumber: target.prNumber,
    out: values.out,
  })
  if (io.json) {
    printJson(io, result)
  } else {
    io.stdout(`Exported the canvas for ${shortSha(result.headSha)} to ${result.path}`)
  }
  if (result.prNumber !== undefined)
    io.stderr(`drag ${result.path} into the ${ctx.config.host.noun} description or a comment`)
  return EXIT.ok
}

/**
 * The zip the user named, under the size cap. The cap is applied while reading, so a file that
 * grows between the check and the read, and a named pipe that reports no size at all, both stop
 * at the cap instead of filling memory.
 */
async function readZipFile(zipPath: string, shown: string): Promise<Uint8Array> {
  let handle: FileHandle
  try {
    handle = await open(zipPath, 'r')
  } catch {
    throw new PublishError('NOT_FOUND', `${shown} does not exist`, 'pass the canvas zip to import')
  }
  const tooLarge = new AppError(
    'CANVAS_TOO_LARGE',
    `${shown} is larger than ${CANVAS_ZIP_MAX_BYTES} bytes`,
    413
  )
  try {
    // One byte past the cap is read, so a file of exactly the cap still fits and anything longer
    // is refused without the rest of it ever being in memory.
    const buffer = Buffer.alloc(CANVAS_ZIP_MAX_BYTES + 1)
    let filled = 0
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null)
      if (bytesRead === 0) {
        break
      }
      filled += bytesRead
    }
    if (filled > CANVAS_ZIP_MAX_BYTES) {
      throw tooLarge
    }
    return new Uint8Array(buffer.subarray(0, filled))
  } finally {
    await handle.close()
  }
}

/** `import <zip> [--pr <n>] [--force] [--json]`: the same path the drop zone and discovery use. */
export async function runImport(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { pr: { type: 'string' }, force: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const file = positionals[0]
  if (file === undefined || positionals.length > 1) {
    throw new UsageError('import takes one zip: pr-review import <zip> [--pr <n>] [--force]')
  }
  const bytes = await readZipFile(path.resolve(file), file)
  const options: Parameters<typeof importCanvas>[1] = { bytes, force: values.force === true }
  if (values.pr !== undefined) {
    const prNumber = parsePrNumber(values.pr)
    const meta = await ctx.config.host.fetchPrMeta(ctx.gh, ctx.config.repo, prNumber)
    options.prNumber = prNumber
    options.currentHead = await fetchPrRefs(ctx.git, ctx.config.host, meta)
  }
  const result = await importCanvas(ctx, options)
  if (io.json) {
    printJson(io, result)
    return EXIT.ok
  }
  for (const warning of result.warnings) io.stderr(`warning: ${warning}`)
  io.stdout(describeImport(result))
  return EXIT.ok
}

/** One line on what an import did, for a person reading the terminal. */
export function describeImport(result: ImportResult): string {
  const canvas = shortSha(result.headSha)
  if (result.status === 'exists') {
    return `A canvas for ${canvas} is already stored and is at least as new; kept it.`
  }
  if (result.status === 'ready') {
    return `Imported the canvas for ${canvas}.`
  }
  const head = shortSha(result.currentHeadSha)
  const behind =
    result.relation === 'ancestor' && result.commitsBehind !== undefined
      ? `, ${plural(result.commitsBehind, 'commit')} ahead of it`
      : result.relation === 'unrelated'
        ? ', which does not contain it'
        : ''
  return `Imported the canvas for ${canvas}, but the head is now ${head}${behind}. The canvas is stale.`
}

/**
 * `clean [--all] [--older-than <days>] [--dry-run] [--json]`: removes idle review checkouts, the ones with
 * no chat turn for `checkoutIdleDays`, or every one with `--all`. A checkout a chat turn holds is
 * left alone. Canvases and review state are never touched.
 */
export async function runClean(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean' },
      'older-than': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  })
  const all = values.all === true
  const olderThan = values['older-than']
  if (all && olderThan !== undefined) {
    throw new UsageError('clean takes --all or --older-than <days>, not both')
  }
  let olderThanDays: number | undefined
  if (olderThan !== undefined) {
    olderThanDays = Number(olderThan)
    if (!Number.isInteger(olderThanDays) || olderThanDays < 0) {
      throw new UsageError('--older-than takes a whole number of days, 0 or more')
    }
  } else if (!all) {
    const { checkoutIdleDays } = await ctx.settings.read()
    if (checkoutIdleDays === CHECKOUT_IDLE_NEVER) {
      io.stderr(
        'pr-review clean: idle cleanup is off (checkoutIdleDays: -1), so nothing was removed. Use --all or --older-than <days>.'
      )
      if (io.json) printJson(io, { removed: [], skipped: [], dryRun: values['dry-run'] === true })
      return EXIT.ok
    }
    olderThanDays = checkoutIdleDays
  }
  const result = await ctx.checkouts.sweep({ all, olderThanDays, dryRun: values['dry-run'] === true })
  const dryRun = values['dry-run'] === true
  if (io.json) {
    const brief = (list: CheckoutInfo[]) =>
      list.map(({ key, sha, lastUsedAt, dir }) => ({ key, sha, lastUsedAt, dir }))
    printJson(io, { removed: brief(result.removed), skipped: brief(result.skipped), dryRun })
    return EXIT.ok
  }
  const checkoutLine = ({ key, sha, lastUsedAt, dir }: CheckoutInfo) =>
    `  ${typeof key === 'number' ? `#${key}` : key} at ${shortSha(sha)}, last used ${lastUsedAt}: ${dir}`
  if (result.removed.length === 0) {
    io.stdout('No review checkouts to remove.')
  } else {
    const n = plural(result.removed.length, 'review checkout')
    io.stdout(dryRun ? `Would remove ${n}:` : `Removed ${n}:`)
    for (const checkout of result.removed) io.stdout(checkoutLine(checkout))
  }
  if (result.skipped.length > 0) {
    io.stdout(`Left ${plural(result.skipped.length, 'review checkout')} a chat turn is using:`)
    for (const checkout of result.skipped) io.stdout(checkoutLine(checkout))
  }
  return EXIT.ok
}
