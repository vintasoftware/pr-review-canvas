// `pr-review generate`: the review app's generate command, from a terminal. The job runs in the
// running server, as one started from the page does, so one generation still runs at a time in a
// clone and the page shows it; this command starts it, reports where it is, and waits for its end.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { writeCanvasZip } from '../canvas/export.js'
import { type CliIo, EXIT, printJson, splitCommonFlags, UsageError } from '../commands.js'
import {
  type GenerateInput,
  type GenerationJob,
  type GenerationResponse,
  type GenerationSharing,
  type GenerationTargetResponse,
  isRunning,
  PHASE_LABELS,
} from '../contract/generation.js'
import { isLocalKey, keyToString, type ReviewKey } from '../contract/review-key.js'
import { isChatAgent } from '../contract/settings.js'
import { AppError, fromEnvelope } from '../server/errors.js'
import type { RunningServer } from './client.js'
import { addToRunningServer, type HubCommandDeps, reviewTarget, shouldOpen } from './commands.js'

/** How often the command asks the server where the job is. */
export const GENERATE_POLL_MS = 2_000

export interface GenerateDeps extends HubCommandDeps {
  /** A call to the project's API under its base path, as `prs/42/generate`. */
  callProject: <T>(server: RunningServer, basePath: string, path: string, init?: RequestInit) => Promise<T>
  /** A file the project's API answers with, by the name the server gives it. */
  download: (
    server: RunningServer,
    basePath: string,
    path: string
  ) => Promise<{ name: string; bytes: Uint8Array }>
  sleep: (ms: number) => Promise<void>
}

/** What a running job is doing, in the words of the page's dialog, with the attempt it is on. */
function phaseLine(job: GenerationJob): string {
  const text = PHASE_LABELS[job.phase]
  if (job.phase !== 'repairing') {
    return text
  }
  const count = job.problems?.length ?? 0
  return `${text} (${count} problem${count === 1 ? '' : 's'}, attempt ${job.round} of ${job.maxRounds})`
}

function label(key: ReviewKey): string {
  return isLocalKey(key) ? `the ${key} review` : `#${key}`
}

/** Waits for the job `started` began to end, with a line on stderr each time its phase changes. */
async function waitForEnd(
  deps: GenerateDeps,
  io: CliIo,
  server: RunningServer,
  basePath: string,
  started: GenerationJob
): Promise<GenerationJob> {
  const route = `prs/${keyToString(started.key)}/generate`
  let shown = ''
  for (let job = started; ;) {
    if (!isRunning(job)) {
      return job
    }
    const step = `${job.phase}:${job.round}`
    if (step !== shown) {
      io.stderr(`pr-review generate: ${phaseLine(job)}`)
      shown = step
    }
    await deps.sleep(GENERATE_POLL_MS)
    const answer = await deps
      .callProject<GenerationResponse>(server, basePath, route)
      .catch((err: unknown) => {
        if (err instanceof AppError) throw err
        throw new AppError(
          'SERVER_NOT_RUNNING',
          'the server stopped answering while the canvas was being generated',
          503,
          'start it with `pr-review serve` and run generate again'
        )
      })
    // The server keeps each review's last job, so none means it restarted and lost this one.
    if (answer.job === null) {
      throw new AppError(
        'GENERATION_FAILED',
        `the server no longer knows the generation of ${label(started.key)}; it may have restarted`,
        503,
        'open the review page to see whether the canvas was published'
      )
    }
    // Another job of this review began since: this one ended, and its result is gone.
    if (answer.job.startedAt !== started.startedAt) {
      throw new AppError(
        'GENERATION_FAILED',
        `the generation of ${label(started.key)} was replaced by another one`,
        409,
        'open the review page to see the one that runs now'
      )
    }
    job = answer.job
  }
}

/** The review a run with no target generates for: the open PR of the checked-out branch. */
async function branchReview(deps: GenerateDeps, server: RunningServer, basePath: string): Promise<ReviewKey> {
  const { prNumber } = await deps.callProject<GenerationTargetResponse>(server, basePath, 'generate/target')
  if (prNumber === null) {
    throw new UsageError(
      'this branch has no open pull request: name a review, as `generate 42`, `generate branch`, or `generate uncommitted`'
    )
  }
  return prNumber
}

export async function runGenerate(deps: GenerateDeps, argv: string[], io: CliIo): Promise<number> {
  const { repo, dataDir, rest } = splitCommonFlags(argv)
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      base: { type: 'string' },
      force: { type: 'boolean' },
      agent: { type: 'string' },
      model: { type: 'string' },
      out: { type: 'string' },
      open: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  const target = reviewTarget('generate', positionals)
  const input: GenerateInput = { force: values.force === true }
  if (values.base !== undefined) {
    if (target === undefined || !isLocalKey(target)) {
      throw new UsageError('--base is for `generate branch` and `generate uncommitted`')
    }
    input.base = values.base
  }
  if (values.agent !== undefined) {
    if (!isChatAgent(values.agent)) {
      throw new UsageError(`--agent is claude or codex, not "${values.agent}"`)
    }
    input.agent = values.agent
  }
  if (values.model !== undefined) input.model = values.model
  // A canvas to send as a file stays off the pull request.
  if (values.out !== undefined) input.share = false

  // The project keeps the flags `open` or `serve` saved with it, unless this run names a data dir.
  const { server, added } = await addToRunningServer(
    deps,
    io,
    repo,
    dataDir === undefined ? undefined : { dataDir }
  )
  const key = target ?? (await branchReview(deps, server, added.basePath))
  const { job: started } = await deps.callProject<GenerationResponse>(
    server,
    added.basePath,
    `prs/${keyToString(key)}/generate`,
    { method: 'POST', body: JSON.stringify(input) }
  )
  if (started === null) {
    throw new AppError('INTERNAL', 'the server started no generation', 502)
  }
  const url = `${server.origin}${added.basePath}review/${keyToString(key)}`
  io.stderr(
    `pr-review generate: generating ${label(key)} with ${started.agent}${started.model === null ? '' : ` (${started.model})`} in ${added.slug}; follow it at ${url}`
  )
  io.stderr('pr-review generate: Ctrl+C stops waiting; the generation goes on in the server')

  const job = await waitForEnd(deps, io, server, added.basePath, started)
  const { headSha, sharing } = published(io, job)
  let zipPath: string | undefined
  if (values.out !== undefined) {
    const zip = await deps.download(
      server,
      added.basePath,
      `prs/${keyToString(key)}/export?headSha=${headSha}`
    )
    // The name is the server's: only its last part is taken, so it cannot point elsewhere.
    zipPath = await writeCanvasZip(path.resolve(deps.cwd, values.out), deps.cwd, {
      name: path.basename(zip.name),
      bytes: zip.bytes,
    })
  }
  if (values.open === true && shouldOpen(deps.env, false)) {
    deps.openBrowser(url)
  }
  if (io.json) {
    printJson(io, {
      status: 'published',
      review: key,
      headSha,
      url,
      agent: job.agent,
      model: job.model,
      attempts: job.round,
      sharing,
      ...(zipPath === undefined ? {} : { zipPath }),
    })
    return EXIT.ok
  }
  io.stdout(`published the canvas of ${label(key)} at ${headSha.slice(0, 7)}: ${url}`)
  if (sharing.status === 'shared') {
    io.stdout(`shared on the pull request: ${sharing.url}`)
  } else if (sharing.status === 'failed') {
    io.stderr(`warning: ${sharing.warning}`)
    io.stdout(`zip to upload: ${sharing.zipPath}`)
  } else if (sharing.status === 'off' && zipPath === undefined) {
    io.stdout('kept local: sharing is off')
  }
  if (zipPath !== undefined) {
    io.stdout(`wrote ${zipPath}; open it with \`pr-review import <zip>\``)
  }
  return EXIT.ok
}

/**
 * What a job that ended published: its head, and what publish did with the canvas. A job that
 * ended any other way throws its error, which the command reports as it reports any failure.
 */
function published(io: CliIo, job: GenerationJob): { headSha: string; sharing: GenerationSharing } {
  if (job.phase === 'cancelled') {
    throw new AppError(
      'GENERATION_FAILED',
      `the generation of ${label(job.key)} was stopped`,
      409,
      'start it again with `pr-review generate`'
    )
  }
  if (job.phase === 'failed' && job.error !== undefined) {
    for (const problem of job.error.code === 'MODEL_INVALID' ? (job.problems ?? []) : []) {
      io.stderr(problem)
    }
    throw fromEnvelope(job.error, 500)
  }
  // The server ends every job with these: a done one with its head and sharing, a failed one with its error.
  if (job.phase !== 'done' || job.headSha === undefined || job.sharing === undefined) {
    throw new AppError(
      'INTERNAL',
      `the server ended the generation of ${label(job.key)} without its result`,
      502
    )
  }
  return { headSha: job.headSha, sharing: job.sharing }
}
