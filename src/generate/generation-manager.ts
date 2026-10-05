// The canvas generation the review page starts: the same prepare, validate, and publish the skill
// runs, with the agent kept to reading. The agent never writes a file or runs a command; it answers
// with the model JSON, and this file writes it, publishes it, and hands the problems back.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRun, AgentRunner } from '../acpx/acpx.js'
import { latestModel } from '../acpx/models.js'
import { CheckoutBusyError, type CheckoutLease, type ReviewCheckouts } from '../chat/checkouts.js'
import { slug } from '../chat/threads.js'
import type { PrepareTargetInput } from '../contract/generation-context.js'
import type { ErrorEnvelope } from '../contract/api.js'
import { type GenerationJob, isRunning } from '../contract/generation.js'
import type { Repo } from '../contract/review-artifact.js'
import { isLocalKey, keyToString, type ReviewKey } from '../contract/review-key.js'
import type { Settings } from '../contract/settings.js'
import { formatValidationError } from '../contract/validation.js'
import type { GenerationModels } from '../project-config.js'
import type { PrepareOptions, PrepareResult } from '../review/prepare.js'
import {
  ModelInvalidError,
  PublishError,
  type PublishOptions,
  type PublishResult,
} from '../review/publish.js'
import { toAppError } from '../server/errors.js'
import { writeTextAtomic } from '../store/atomic-json.js'

/** One agent turn may take this long; a large canvas takes the agent many minutes to write. */
export const GENERATION_TURN_TIMEOUT_SEC = 30 * 60
/** How many tool calls the status keeps. */
export const ACTIVITY_KEPT = 8

export class GenerationBusyError extends Error {
  constructor() {
    super('a canvas is already being generated for this review')
    this.name = 'GenerationBusyError'
  }
}

/** The pipeline steps, injected so tests can run the job without git, a forge, or an agent. */
export interface GenerationSteps {
  prepare(input: PrepareTargetInput, opts: PrepareOptions): Promise<PrepareResult>
  publish(canvasDir: string, opts: PublishOptions): Promise<PublishResult>
  /**
   * What `validate --fix` does to the model file: trims over-cap titles and repairs broken folds,
   * writing the file back. Returns each fix in words, for the agent to keep.
   */
  fix(canvasDir: string, modelPath: string, text: string): Promise<string[]>
}

export interface GenerationManagerDeps {
  runner: AgentRunner
  checkouts: ReviewCheckouts
  steps: GenerationSteps
  /** The chat settings with the `serve` flags applied: the agent, and whether checkouts are on. */
  settings: () => Promise<Settings>
  /** The project's `generation.models` and `maxRepairRounds`. */
  generation: { models: GenerationModels; maxRepairRounds: number }
  repo: Repo
  repoRoot: string
  log: (line: string) => void
  now: () => Date
}

export interface GenerationManager {
  /** Starts a job for `key`; throws GenerationBusyError when one is running for it. */
  start(key: ReviewKey, opts: { force: boolean }): Promise<GenerationJob>
  /** The job of `key` the server ran last, or null. */
  status(key: ReviewKey): GenerationJob | null
  /** True when a running job was asked to stop. */
  cancel(key: ReviewKey): Promise<boolean>
}

/** What the agent reads code from, and how the prompt describes it. */
interface CodeSource {
  cwd: string
  note: string
}

/** The running side of a job, which the status never shows. */
interface Slot {
  job: GenerationJob
  run: AgentRun | null
  lease: CheckoutLease | null
  stopped: boolean
  /** The tool call id behind each line of `job.activity`, in the same order. */
  activityIds: string[]
  /** Folders a tool title is shown relative to: the agent's working directory and the canvas's. */
  shortPaths: string[]
}

/** The title acpx gives a tool update that names neither a title nor a kind. */
const UNTITLED_TOOL = 'tool'

/**
 * Records a tool call on the job's activity. A call reports itself more than once as it runs,
 * first with a generic title ("Read File") and then with its own ("Read src/a.ts"), so each call
 * keeps one line, with the latest title that says something.
 */
function noteTool(slot: Slot, id: string, raw: string): void {
  if (raw === '' || raw === UNTITLED_TOOL) {
    return
  }
  const title = slot.shortPaths.reduce((text, dir) => text.replaceAll(`${dir}/`, ''), raw)
  const { job } = slot
  const at = slot.activityIds.indexOf(id)
  if (at !== -1) {
    job.activity = job.activity.map((line, i) => (i === at ? title : line))
    return
  }
  job.activity = [...job.activity, title].slice(-ACTIVITY_KEPT)
  slot.activityIds = [...slot.activityIds, id].slice(-ACTIVITY_KEPT)
}

class Cancelled extends Error {}

/** A turn the agent ended with an error, or stopped before its answer was whole. */
class AgentTurnError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentTurnError'
    this.code = code
  }
}

/** What to do about the agent failures a reader can fix. */
const AGENT_HINTS: Readonly<Record<string, string>> = {
  AGENT_AUTH_REQUIRED: 'log the agent in from a terminal, then try again',
  AGENT_MISSING: 'install acpx and the agent CLI, then try again',
  AGENT_TIMEOUT: `the agent ran past ${GENERATION_TURN_TIMEOUT_SEC / 60} minutes; try again, or run the skill from a terminal`,
}

function targetOf(key: ReviewKey): PrepareTargetInput {
  return isLocalKey(key) ? { kind: 'local', source: key } : { kind: 'pr', number: key }
}

/**
 * What the agent is told before the prepared prompt. The prompt is written for the skill, which
 * writes the file and runs publish itself; here the server does both, and the agent runs under the
 * chat's flags, which deny every write, so the parts that say otherwise are named and replaced.
 */
export function generationPreface(code: CodeSource, modelPath: string): string {
  return [
    '# Generate a review canvas',
    '',
    'The pr-review server runs this generation. Read and search only: write no file and run no command that changes anything. A request to write is denied.',
    '',
    `- ${code.note}`,
    '- Where the task below says to read a file with `git show`, read it from your working directory instead, or from the `<head>` and `<base>` folders it names.',
    `- Where it says to write \`<model>\` (${modelPath}) or to run validate or publish, do neither. Answer with the model JSON itself, and nothing else: no prose before or after it and no code fence.`,
    '- The server writes your answer to `<model>`, validates and publishes it, and sends you the problems publish names. Then answer with the whole corrected model JSON, again with nothing else.',
    '',
    '---',
    '',
  ].join('\n')
}

/** The message that sends the problems of a rejected publish back to the agent. */
export function repairPrompt(problems: string[], fixed: string[], round: number, maxRounds: number): string {
  const lines = [
    `Publish rejected the model (attempt ${round - 1} of ${maxRounds}). Fix exactly these problems:`,
    '',
    ...problems.map(p => `- ${p}`),
  ]
  if (fixed.length > 0) {
    lines.push('', 'The server already made these fixes to the file; keep them in your answer:', '')
    lines.push(...fixed.map(f => `- ${f}`))
  }
  lines.push(
    '',
    'Do not weaken the content to pass: shorten text, move hunks, fix links. Answer with the whole corrected model JSON and nothing else.'
  )
  return lines.join('\n')
}

/**
 * The JSON object in an answer. Agents asked for bare JSON still sometimes fence it or say a word
 * first, so the text from the first `{` to the last `}` is what is kept.
 */
export function extractModelJson(answer: string): string | null {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  return start === -1 || end < start ? null : answer.slice(start, end + 1)
}

/** What a failed job shows: the error in the envelope's words, with what to do about it. */
export function jobError(err: unknown): ErrorEnvelope['error'] {
  if (err instanceof AgentTurnError) {
    const hint = AGENT_HINTS[err.code]
    return hint === undefined
      ? { code: 'GENERATION_FAILED', message: err.message }
      : { code: 'GENERATION_FAILED', message: err.message, hint }
  }
  if (err instanceof PublishError) {
    return { code: err.code, message: err.message, hint: err.hint }
  }
  if (err instanceof CheckoutBusyError) {
    return {
      code: 'GENERATION_BUSY',
      message: err.message,
      hint: 'another pr-review serve of this clone holds the review checkout; try again once it is done',
    }
  }
  return toAppError(err).toEnvelope().error
}

export function createGenerationManager(deps: GenerationManagerDeps): GenerationManager {
  const slots = new Map<ReviewKey, Slot>()
  const maxRounds = deps.generation.maxRepairRounds + 1

  const label = (key: ReviewKey): string => (isLocalKey(key) ? key : `#${key}`)

  const end = (slot: Slot, phase: GenerationJob['phase'], extra: Partial<GenerationJob> = {}): void => {
    Object.assign(slot.job, extra, { phase, endedAt: deps.now().toISOString() })
  }

  const throwIfStopped = (slot: Slot): void => {
    if (slot.stopped) {
      throw new Cancelled()
    }
  }

  /**
   * Where the agent reads code. The uncommitted review reads the reader's checkout, which is the
   * work under review; any other review reads its review checkout at the prepared head, the one
   * the chat uses, so the chat of that review waits while the generation holds it.
   */
  const codeSource = async (
    slot: Slot,
    key: ReviewKey,
    headSha: string,
    settings: Settings
  ): Promise<CodeSource> => {
    if (key === 'uncommitted') {
      return {
        cwd: deps.repoRoot,
        note: 'Your working directory is the work under review: read any file there as it is now.',
      }
    }
    const approximate = {
      cwd: deps.repoRoot,
      note: `Your working directory is the reader's checkout, which may be on another commit than ${headSha}. Read changed files from \`<head>\` and \`<base>\`; an untouched file there may differ from the head.`,
    }
    if (!settings.checkoutEnabled) {
      return approximate
    }
    slot.job.phase = 'checkout'
    const lease = await deps.checkouts.lease(key)
    slot.lease = lease
    try {
      await lease.moveTo(headSha)
    } catch (err) {
      deps.log(
        `generation ${label(key)}: the review checkout did not move (${err instanceof Error ? err.message : String(err)}); reading the reader's checkout`
      )
      return approximate
    }
    return {
      cwd: lease.dir,
      note: `Your working directory is a checkout of ${headSha}, the head: read any file there, changed or untouched, as it is at the head.`,
    }
  }

  /** One agent turn, to its end. Returns what the agent answered. */
  const turn = async (slot: Slot, session: string, prompt: string, cwd: string): Promise<string> => {
    throwIfStopped(slot)
    const { job } = slot
    const run = deps.runner.run({
      agent: job.agent,
      session,
      prompt,
      cwd,
      timeoutSec: GENERATION_TURN_TIMEOUT_SEC,
      model: job.model ?? undefined,
    })
    // `run` spawns without waiting, so a stop arriving from here on finds the handle.
    slot.run = run
    let answer = ''
    try {
      for await (const event of run.events) {
        if (event.type === 'chunk') {
          answer += event.text
        } else if (event.type === 'tool') {
          // The answer is what the agent says after its last tool call; what it said on the way
          // there ("Reading the manifest first") is no part of the model.
          answer = ''
          noteTool(slot, event.id, event.title)
        } else if (event.type === 'done') {
          if (event.stopReason === 'cancelled') {
            throw new Cancelled()
          }
          if (event.stopReason !== 'end_turn') {
            throw new AgentTurnError('AGENT_INCOMPLETE', `the agent stopped early (${event.stopReason})`)
          }
        } else if (event.type === 'error') {
          throw new AgentTurnError(event.code, event.message)
        }
      }
    } finally {
      slot.run = null
    }
    throwIfStopped(slot)
    return answer
  }

  const runJob = async (slot: Slot, key: ReviewKey): Promise<void> => {
    const { job } = slot
    const prepared = await deps.steps.prepare(targetOf(key), { force: job.force, log: () => undefined })
    job.headSha = prepared.headSha
    if (prepared.status === 'exists') {
      end(slot, 'done', { outcome: 'exists' })
      return
    }
    throwIfStopped(slot)
    const settings = await deps.settings()
    const code = await codeSource(slot, key, prepared.headSha, settings)
    // The canvas dir first: it may sit inside the working directory.
    slot.shortPaths = [prepared.canvasDir, code.cwd]
    throwIfStopped(slot)

    const modelPath = path.join(prepared.canvasDir, 'model.json')
    const task = await readFile(prepared.promptPath, 'utf8')
    const session = `pr-review-${slug(deps.repo.owner)}-${slug(deps.repo.name)}-${keyToString(key)}-${slug(job.agent)}-gen${deps.now().getTime()}`
    await deps.runner.ensureSession({
      agent: job.agent,
      session,
      cwd: code.cwd,
      timeoutSec: GENERATION_TURN_TIMEOUT_SEC,
    })

    let prompt = `${generationPreface(code, modelPath)}${task}`
    for (;;) {
      job.phase = job.round === 1 ? 'generating' : 'repairing'
      const answer = await turn(slot, session, prompt, code.cwd)
      // An answer with no object in it is written as it is, so the validator names the problem.
      const text = extractModelJson(answer) ?? answer
      await writeTextAtomic(modelPath, `${text.trimEnd()}\n`)
      const fixed = await deps.steps.fix(prepared.canvasDir, modelPath, text)
      throwIfStopped(slot)
      job.phase = 'publishing'
      try {
        const result = await deps.steps.publish(prepared.canvasDir, {
          agent: job.agent,
          model: job.model ?? undefined,
          harness: 'other',
          allowStale: false,
        })
        end(slot, 'done', { outcome: 'published', sharing: result.sharing })
        deps.log(`generation ${label(key)}: published ${prepared.headSha.slice(0, 7)}`)
        return
      } catch (err) {
        if (!(err instanceof ModelInvalidError)) {
          throw err
        }
        job.problems = err.report.errors.map(formatValidationError)
        if (job.round >= maxRounds) {
          end(slot, 'failed', {
            error: {
              code: 'MODEL_INVALID',
              message: `publish rejected the model ${job.round} times`,
              hint: 'run the skill from Claude Code or Codex to finish this canvas by hand',
            },
          })
          return
        }
        job.round += 1
        prompt = repairPrompt(job.problems, fixed, job.round, maxRounds)
      }
    }
  }

  const finish = async (slot: Slot, key: ReviewKey, err: unknown): Promise<void> => {
    delete slot.job.stopping
    if (err instanceof Cancelled || (slot.stopped && isRunning(slot.job))) {
      end(slot, 'cancelled')
      deps.log(`generation ${label(key)}: stopped`)
    } else if (err !== undefined) {
      const error = jobError(err)
      end(slot, 'failed', { error })
      deps.log(`generation ${label(key)}: failed (${error.code})`)
    }
    await slot.lease?.release().catch(() => undefined)
    slot.lease = null
  }

  return {
    async start(key, opts) {
      const current = slots.get(key)
      if (current !== undefined && isRunning(current.job)) {
        throw new GenerationBusyError()
      }
      const settings = await deps.settings()
      const agent = settings.chatAgent
      const named = deps.generation.models[agent]
      const model =
        named === undefined ? null : latestModel(agent, named, await deps.runner.modelUpgrades(agent))
      // Checked again after the awaits: two clicks that both got past the first check start one job.
      const again = slots.get(key)
      if (again !== undefined && isRunning(again.job)) {
        throw new GenerationBusyError()
      }
      const slot: Slot = {
        job: {
          key,
          force: opts.force,
          agent,
          model,
          phase: 'preparing',
          round: 1,
          maxRounds,
          startedAt: deps.now().toISOString(),
          activity: [],
        },
        run: null,
        lease: null,
        stopped: false,
        activityIds: [],
        shortPaths: [],
      }
      slots.set(key, slot)
      deps.log(`generation ${label(key)}: started with ${agent}${model === null ? '' : ` (${model})`}`)
      void runJob(slot, key).then(
        () => finish(slot, key, undefined),
        err => finish(slot, key, err)
      )
      return { ...slot.job }
    },

    status(key) {
      const slot = slots.get(key)
      return slot === undefined ? null : { ...slot.job, activity: [...slot.job.activity] }
    },

    async cancel(key) {
      const slot = slots.get(key)
      if (slot === undefined || !isRunning(slot.job)) {
        return false
      }
      // A job between agent turns is stopped by the flag; one inside a turn by its handle too.
      slot.stopped = true
      slot.job.stopping = true
      await slot.run?.cancel()
      return true
    },
  }
}
