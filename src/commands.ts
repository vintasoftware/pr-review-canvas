// The subcommands behind `pr-review`, with everything injected: the AppContext carries git, gh, and
// the stores; `io` carries stdout/stderr. cli.ts parses the command name and builds both.
import { type FileHandle, open } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { exportCanvas } from './canvas/export.js'
import { importCanvas } from './canvas/import.js'
import { CANVAS_ZIP_MAX_BYTES } from './canvas/zip.js'
import type { ErrorCode } from './contract/api.js'
import type { GenerationContext, PrepareTarget } from './contract/generation-context.js'
import { HARNESSES, type ReviewArtifact, ReviewArtifactSchema } from './contract/review-artifact.js'
import { formatValidationError, type ValidationReport } from './contract/validation.js'
import { fetchPrMeta, fetchPrRefs } from './github/pr.js'
import { type DoctorDeps, runDoctorChecks } from './review/doctor.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, installSkill, SkillDirExistsError } from './review/install-skill.js'
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
import { applyTitleTrims, type TitleTrim } from './review/trim-caps.js'
import { validateModelOutput } from './review/validate.js'
import type { AppContext } from './server/context.js'
import { AppError, toAppError } from './server/errors.js'
import { readText, writeTextAtomic } from './store/atomic-json.js'

export interface CliIo {
  stdout(line: string): void
  stderr(line: string): void
}

/** Exit codes: 0 ok, 1 error, 2 usage, 4 gh auth or missing, 5 invalid model output. */
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

export function printErrorEnvelope(io: CliIo, code: ErrorCode, message: string, hint?: string): void {
  const error: { code: ErrorCode; message: string; hint?: string } = { code, message }
  if (hint !== undefined) {
    error.hint = hint
  }
  printJson(io, { error })
}

function isParseArgsError(err: unknown): err is Error {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')
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
  return appErr.code === 'GH_UNAUTHENTICATED' || appErr.code === 'GH_MISSING' ? EXIT.gh : EXIT.error
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

export function parsePrepareTarget(values: { pr?: string; base?: string; head?: string }): PrepareTarget {
  if (values.pr !== undefined) {
    if (values.base !== undefined || values.head !== undefined) {
      throw new UsageError('pass either --pr <n> or --base <ref> --head <ref>, not both')
    }
    return { kind: 'pr', number: parsePrNumber(values.pr) }
  }
  if (values.base !== undefined && values.head !== undefined) {
    return { kind: 'refs', base: values.base, head: values.head }
  }
  throw new UsageError('prepare needs --pr <n> or --base <ref> --head <ref>')
}

export async function runPrepare(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { pr: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, force: { type: 'boolean' } },
    strict: true,
  })
  const target = parsePrepareTarget(values)
  const result = await prepare(ctx, target, { force: values.force === true, log: phase => io.stderr(phase) })
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
  const result = validateModelOutput(input, await validationInput(ctx, context, input))
  return { ok: result.ok, errors: result.errors }
}

/**
 * `validate <model.json|review.json> --canvas <dir> [--human] [--fix]`: the report as one JSON
 * line, or as lines. `--fix` first trims the titles that are over their cap and writes the file
 * back, so the only problems left to answer are the ones that need judgment.
 */
export async function runValidate(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { canvas: { type: 'string' }, human: { type: 'boolean' }, fix: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const file = positionals[0]
  if (file === undefined || positionals.length > 1) {
    throw new UsageError('validate takes one file: pr-review validate <model.json|review.json> --canvas <dir>')
  }
  if (values.canvas === undefined) {
    throw new UsageError('validate needs --canvas <dir> (the directory prepare printed)')
  }
  const context = await readContext(path.resolve(values.canvas))
  const text = await readText(path.resolve(file))
  if (text === null) {
    throw new PublishError('NOT_FOUND', `${file} does not exist`, 'pass the model.json or review.json to check')
  }
  const fixed = values.fix === true ? await fixTitles(path.resolve(file), text, context) : { text, trims: [] }
  const report = await validateFile(ctx, parseModelText(fixed.text, path.basename(file)), context)
  if (values.human !== true) {
    printJson(io, values.fix === true ? { ...report, fixed: fixed.trims } : report)
    return report.ok ? EXIT.ok : EXIT.invalid
  }
  for (const trim of fixed.trims) {
    if (trim.outcome === 'fixed') {
      io.stdout(`fixed ${trim.where}: "${trim.from}" -> "${trim.to}"`)
    } else {
      io.stdout(`unfixable ${trim.where}: ${trim.length} visible chars, cap ${trim.cap}, ${trim.reason}; rewrite by hand`)
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
 * Trims the over-cap titles of a model file and writes it back. Returns the text to validate,
 * unchanged when nothing needed trimming, so a file that is already fine is never rewritten.
 */
async function fixTitles(
  file: string,
  text: string,
  context: GenerationContext
): Promise<{ text: string; trims: TitleTrim[] }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // An unparseable file has no titles to trim; the validator reports the syntax error.
    return { text, trims: [] }
  }
  const trims = applyTitleTrims(parsed, context.caps)
  if (!trims.some(trim => trim.outcome === 'fixed')) {
    return { text, trims }
  }
  const next = `${JSON.stringify(parsed, null, 2)}\n`
  await writeTextAtomic(file, next)
  return { text: next, trims }
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

export async function runPublish(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      agent: { type: 'string' },
      model: { type: 'string' },
      harness: { type: 'string' },
      'allow-stale': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const canvasDir = positionals[0]
  if (canvasDir === undefined || positionals.length > 1) {
    throw new UsageError('publish takes one directory: pr-review publish <canvasDir> --agent <id> --harness <id>')
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
  printJson(io, result)
  return EXIT.ok
}

/**
 * `doctor`: every check the tool needs, as one JSON line. Exit 1 when one fails, so a script can
 * read the code instead of the JSON.
 */
export async function runDoctor(deps: DoctorDeps, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { 'all-checks': { type: 'boolean' } }, strict: true })
  const report = await runDoctorChecks(deps, { allChecks: values['all-checks'] === true })
  printJson(io, report)
  return report.ok ? EXIT.ok : EXIT.error
}

export interface InstallSkillEnv {
  repoRoot: string
  cwd: string
  platform: NodeJS.Platform
}

/** `install-skill [--claude-dir <dir>] [--codex-dir <dir>] [--force]`, both dirs under the repo root by default. */
export async function runInstallSkill(env: InstallSkillEnv, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'claude-dir': { type: 'string' }, 'codex-dir': { type: 'string' }, force: { type: 'boolean' } },
    strict: true,
  })
  const resolve = (flag: string | undefined, fallback: string): string =>
    flag === undefined ? path.join(env.repoRoot, fallback) : path.resolve(env.cwd, flag)
  const result = await installSkill({
    platform: env.platform,
    force: values.force === true,
    targets: [
      { kind: 'claude', dir: resolve(values['claude-dir'], CLAUDE_SKILLS_DIR) },
      { kind: 'codex', dir: resolve(values['codex-dir'], CODEX_SKILLS_DIR) },
    ],
  })
  printJson(io, result)
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
  const meta = await fetchPrMeta(ctx.gh, ctx.config.repo, prNumber)
  const { headSha } = await fetchPrRefs(ctx.git, meta)
  return { headSha, prNumber }
}

/** `export (--pr <n> | --head <ref|sha>) [--out <file|dir>]`: writes the zip and prints its path. */
export async function runExport(ctx: AppContext, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { pr: { type: 'string' }, head: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  })
  const target = await resolveHead(ctx, values)
  const result = await exportCanvas(ctx, { headSha: target.headSha, prNumber: target.prNumber, out: values.out })
  printJson(io, result)
  io.stderr(`drag ${result.path} into the pull request description or a comment`)
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
  const tooLarge = new AppError('CANVAS_TOO_LARGE', `${shown} is larger than ${CANVAS_ZIP_MAX_BYTES} bytes`, 413)
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

/** `import <zip> [--pr <n>] [--force]`: the same path the drop zone and discovery use. */
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
    const meta = await fetchPrMeta(ctx.gh, ctx.config.repo, prNumber)
    options.prNumber = prNumber
    options.currentHeadSha = (await fetchPrRefs(ctx.git, meta)).headSha
  }
  printJson(io, await importCanvas(ctx, options))
  return EXIT.ok
}
