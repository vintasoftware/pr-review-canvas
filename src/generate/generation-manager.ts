// The canvas generation the review page starts: the same prepare, validate, and publish the skill
// runs, with the agent kept to reading: it runs under the chat's flags, which deny every write, and
// answers with the model JSON, which this file writes, publishes, and hands the problems back on.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRun, AgentRunner } from '../acpx/acpx.js'
import { latestModel } from '../acpx/models.js'
import { CheckoutBusyError, type CheckoutLease, readCodeAt, type ReviewCheckouts } from '../chat/checkouts.js'
import type { CodeSource } from '../chat/seed.js'
import { slug } from '../chat/threads.js'
import type { PrepareTargetInput } from '../contract/generation-context.js'
import type { ErrorEnvelope } from '../contract/api.js'
import {
  type AgentPulse,
  type GenerationJob,
  type GenerationSkill,
  isRunning,
} from '../contract/generation.js'
import type { Repo } from '../contract/review-artifact.js'
import { isLocalKey, keyLabel, keyToString, type ReviewKey } from '../contract/review-key.js'
import type { ChatAgent, Settings } from '../contract/settings.js'
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
import type { LoadedSkill } from './skill.js'
import { writeTextAtomic } from '../store/atomic-json.js'

/** One agent turn may take this long; a large canvas takes the agent many minutes to write. */
export const GENERATION_TURN_TIMEOUT_SEC = 30 * 60
/** How many tool calls the status keeps. */
export const ACTIVITY_KEPT = 8

export class GenerationBusyError extends Error {
  /** The review whose generation is running. */
  readonly key: ReviewKey

  constructor(key: ReviewKey) {
    super(`a canvas is already being generated for ${keyLabel(key)}, and one runs at a time`)
    this.name = 'GenerationBusyError'
    this.key = key
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
  /** The skill the agent follows: the project's copy for that agent, or the shipped one. */
  skill: (agent: ChatAgent) => Promise<LoadedSkill>
  /** The project's `generation.models` and `maxRepairRounds`. */
  generation: { models: GenerationModels; maxRepairRounds: number }
  repo: Repo
  repoRoot: string
  /** The branch the reader's checkout is on, named when the review checkout falls back to it. */
  currentBranch: () => Promise<string | null>
  log: (line: string) => void
  now: () => Date
  /**
   * The review being generated in this data dir. The worktrees of one clone write the same canvas
   * folders, so their managers share one lane and one job runs at a time across them; a manager
   * of its own has a lane of its own.
   */
  lane?: GenerationLane | undefined
}

/** The one generation a data dir runs at a time. */
export interface GenerationLane {
  key: ReviewKey | null
}

export interface GenerationManager {
  /**
   * Starts a job for `key`; throws GenerationBusyError when any job is running. One runs at a
   * time: two reviews can share a head (a PR and the branch review of its branch), and the jobs
   * of one head write the same canvas folder.
   */
  start(key: ReviewKey, opts: { force: boolean }): Promise<GenerationJob>
  /** The job the server ran last, when it was for `key`; null otherwise. */
  status(key: ReviewKey): GenerationJob | null
  /** True when a running job was asked to stop. */
  cancel(key: ReviewKey): Promise<boolean>
  /** The review whose job is running now, if any. */
  running(): ReviewKey | null
  /** The skill a job started now would follow, with the agent the settings name. */
  nextSkill(): Promise<GenerationSkill>
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
  /** The skill the first turn sends; `job.skill` is its `info`. */
  skill: LoadedSkill
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

/** What the agent is told about its working directory, for each place `readCodeAt` can pick. */
export function codeNote(code: CodeSource, headSha: string): string {
  switch (code.kind) {
    case 'checkout':
      return `Your working directory is a checkout of ${code.sha}, the head: read any file there, changed or untouched, as it is at the head.`
    case 'working-tree':
      return 'Your working directory is the work under review: read any file there as it is now.'
    case 'reader-checkout':
    case 'fallback':
      return `Your working directory is the reader's checkout, which may be on another commit than ${headSha}. Read changed files from \`<head>\` and \`<base>\`; an untouched file there may differ from the head.`
  }
}

/** Where the skill came from, in the words the prompt uses. */
function skillSource(skill: GenerationSkill): string {
  return skill.source === 'project'
    ? `this project's copy, ${skill.path}`
    : `the one pr-review ${skill.version} ships`
}

/**
 * What the agent is sent first: the server's rules, the pr-review-canvas skill the project uses,
 * and the task prepare wrote. The skill is written for a run from a terminal, which runs prepare,
 * writes the file, and runs publish itself. Here the server does those, and the agent runs under
 * the chat's flags, which deny every write, so the steps that say otherwise are named and
 * replaced; everything else the skill says, including what the project changed in it, holds.
 */
export function generationPrompt(
  code: CodeSource,
  headSha: string,
  modelPath: string,
  skill: LoadedSkill,
  task: string
): string {
  return [
    '# Generate a review canvas',
    '',
    `The pr-review server runs this generation. Follow the pr-review-canvas skill below (${skillSource(skill.info)}) and the task prepare wrote after it. Read and search only: write no file and run no command that changes anything. A request to write is denied.`,
    '',
    `- ${codeNote(code, headSha)}`,
    "- The server already ran the skill's prepare step and runs you on the model it picked: skip the skill's model choice and prepare steps, and its report to the user.",
    '- Where the skill or the task says to read a file with `git show`, read it from your working directory instead, or from the `<head>` and `<base>` folders the task names.',
    `- Where they say to write \`<model>\` (${modelPath}) or to run validate, publish, or any other pr-review command, do neither. Answer with the model JSON itself, and nothing else: no prose before or after it and no code fence.`,
    '- The server writes your answer to `<model>`, validates and publishes it, and sends you the problems publish names. Then answer with the whole corrected model JSON, again with nothing else.',
    '',
    '---',
    '',
    '# The pr-review-canvas skill',
    '',
    skill.body.trim(),
    '',
    '---',
    '',
    '# The task prepare wrote',
    '',
    task,
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
    // The message names who holds the checkout; either way, the run can start once it is free.
    return { code: 'GENERATION_BUSY', message: err.message, hint: 'try again once it is done' }
  }
  return toAppError(err).toEnvelope().error
}

export function createGenerationManager(deps: GenerationManagerDeps): GenerationManager {
  /** The job the server ran last, running or ended. */
  let last: Slot | null = null
  const running = (): Slot | null => (last !== null && isRunning(last.job) ? last : null)
  const lane = deps.lane ?? { key: null }
  const of = (key: ReviewKey): Slot | null => (last !== null && last.job.key === key ? last : null)
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
   * Where the agent reads code: the chat's rule (`readCodeAt`). The job holds the review
   * checkout to its end, so a chat turn on that review is refused until then.
   */
  const codeSource = async (
    slot: Slot,
    key: ReviewKey,
    headSha: string,
    settings: Settings
  ): Promise<CodeSource> => {
    const steps = readCodeAt({
      key,
      headSha,
      checkoutEnabled: settings.checkoutEnabled,
      holder: 'generation',
      checkouts: deps.checkouts,
      repoRoot: deps.repoRoot,
      currentBranch: deps.currentBranch,
      onLease: lease => {
        slot.lease = lease
      },
    })
    for (;;) {
      const next = await steps.next()
      if (next.done === true) {
        return next.value
      }
      if (next.value.status === 'preparing') {
        slot.job.phase = 'checkout'
      } else {
        deps.log(
          `generation ${label(key)}: the review checkout did not move (${next.value.message}); reading the reader's checkout`
        )
      }
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
    let doing: AgentPulse['doing'] = 'starting'
    const runningTools = new Set<string>()
    const beat = (next: AgentPulse['doing']): void => {
      doing = next
      job.pulse = { doing, at: deps.now().toISOString(), written: answer.length }
    }
    beat('starting')
    try {
      for await (const event of run.events) {
        if (event.type === 'chunk') {
          answer += event.text
          beat('writing')
        } else if (event.type === 'thought') {
          beat('thinking')
        } else if (event.type === 'tool') {
          // The answer is what the agent says after its last tool call; what it said on the way
          // there ("Reading the manifest first") is no part of the model.
          answer = ''
          noteTool(slot, event.id, event.title)
          // Calls can run side by side, and each reports its own end; once none runs, the model
          // works out its next step.
          if (event.status === 'completed' || event.status === 'failed') {
            runningTools.delete(event.id)
          } else {
            runningTools.add(event.id)
          }
          beat(runningTools.size > 0 ? 'tool' : 'thinking')
        } else if (event.type === 'usage' || event.type === 'plan') {
          // Still a sign of work, which keeps doing what it did.
          beat(doing)
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
      delete job.pulse
    }
    throwIfStopped(slot)
    return answer
  }

  const runJob = async (slot: Slot, key: ReviewKey): Promise<void> => {
    const { job } = slot
    // `force` is the reader's "start from a blank page". A canvas that already exists for the
    // head can only be written again from one, so prepare says so and is asked again with force.
    const target = targetOf(key)
    const first = await deps.steps.prepare(target, { force: job.force, log: () => undefined })
    const prepared =
      first.status === 'exists'
        ? await deps.steps.prepare(target, { force: true, log: () => undefined })
        : first
    job.headSha = prepared.headSha
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

    let prompt = generationPrompt(code, prepared.headSha, modelPath, slot.skill, task)
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
        end(slot, 'done', { sharing: result.sharing })
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
    lane.key = null
  }

  return {
    async start(key, opts) {
      if (lane.key !== null) {
        throw new GenerationBusyError(lane.key)
      }
      const settings = await deps.settings()
      const agent = settings.chatAgent
      const skill = await deps.skill(agent)
      const named = deps.generation.models[agent]
      const model =
        named === undefined ? null : latestModel(agent, named, await deps.runner.modelUpgrades(agent))
      // Checked again after the awaits: two clicks that both got past the first check start one job.
      if (lane.key !== null) {
        throw new GenerationBusyError(lane.key)
      }
      const slot: Slot = {
        job: {
          key,
          force: opts.force,
          agent,
          model,
          skill: skill.info,
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
        skill,
      }
      last = slot
      lane.key = key
      deps.log(`generation ${label(key)}: started with ${agent}${model === null ? '' : ` (${model})`}`)
      void runJob(slot, key).then(
        () => finish(slot, key, undefined),
        err => finish(slot, key, err)
      )
      return { ...slot.job }
    },

    status(key) {
      const slot = of(key)
      return slot === null ? null : { ...slot.job, activity: [...slot.job.activity] }
    },

    async cancel(key) {
      const slot = of(key)
      if (slot === null || !isRunning(slot.job)) {
        return false
      }
      // A job between agent turns is stopped by the flag; one inside a turn by its handle too.
      slot.stopped = true
      slot.job.stopping = true
      await slot.run?.cancel()
      return true
    },

    running: () => running()?.job.key ?? null,
    async nextSkill() {
      const { chatAgent } = await deps.settings()
      return (await deps.skill(chatAgent)).info
    },
  }
}
