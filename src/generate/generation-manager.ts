// The generations the review and tour pages start: one job loop (the lane, the agent's turns, the
// status, the stop) over a pipeline per kind. The canvas pipeline runs the same prepare, validate,
// and publish the skill runs, with the agent kept to reading: it runs under the chat's flags, which
// deny every write, and answers with the model JSON, which this file writes, publishes, and hands
// the problems back on. The tour pipeline is in tour-pipeline.ts.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentAccess, AgentRun, AgentRunner } from '../acpx/acpx.js'
import { latestModel } from '../acpx/models.js'
import { CheckoutBusyError, type CheckoutLease, readCodeAt, type ReviewCheckouts } from '../chat/checkouts.js'
import type { CodeSource } from '../chat/seed.js'
import { slug } from '../chat/threads.js'
import type { PrepareTargetInput } from '../contract/generation-context.js'
import type { ErrorEnvelope } from '../contract/api.js'
import {
  type AgentPulse,
  type GenerateInput,
  type GenerationJob,
  type GenerationKind,
  type GenerationSharing,
  type GenerationSkill,
  isRunning,
} from '../contract/generation.js'
import type { Repo } from '../contract/review-artifact.js'
import { isLocalKey, keyLabel, keyToString, type ReviewKey, reviewFolder } from '../contract/review-key.js'
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

  constructor(key: ReviewKey, kind: GenerationKind) {
    super(`a ${kind} is already being generated for ${keyLabel(key)}, and one runs at a time`)
    this.name = 'GenerationBusyError'
    this.key = key
  }
}

/** The canvas pipeline's steps, injected so tests can run the job without git, a forge, or an agent. */
export interface GenerationSteps {
  prepare(input: PrepareTargetInput, opts: PrepareOptions): Promise<PrepareResult>
  publish(canvasDir: string, opts: PublishOptions): Promise<PublishResult>
  /**
   * What `validate --fix` does to the model file: trims over-cap titles and repairs broken folds,
   * writing the file back. Returns each fix in words, for the agent to keep.
   */
  fix(canvasDir: string, modelPath: string, text: string): Promise<string[]>
}

/** What a pipeline asks of the job loop while it begins a job. */
export interface PipelineTools {
  /** Records the head prepare settled on; throws when the job was stopped meanwhile. */
  prepared(headSha: string): void
  /**
   * Where the agent reads code: the chat's rule (`readCodeAt`). The job holds the review checkout
   * to its end, so a chat turn on that review is refused until then.
   */
  codeSource(headSha: string): Promise<CodeSource>
}

/** What publish made of the agent's work: published, or the problems to send the agent back with. */
export type PipelinePublish = { sharing: GenerationSharing } | { problems: string[] }

/** One job's way from the agent's first turn to a published artifact. */
export interface PipelineRun {
  headSha: string
  /** The agent's working directory. */
  cwd: string
  /** Folders a tool title is shown relative to. */
  shortPaths: string[]
  access: AgentAccess
  /** The first turn's prompt. */
  prompt: string
  /** Takes the agent's answer before publish; returns each fix the server made to it, in words. */
  take(answer: string): Promise<string[]>
  publish(opts: { agent: string; model: string | null; share: boolean }): Promise<PipelinePublish>
  /** The turn that sends the problems of a rejected publish back. */
  repairPrompt(problems: string[], fixed: string[], round: number, maxRounds: number): string
}

/** How one kind of artifact is generated: prepared, handed to the agent, and published. */
export interface GenerationPipeline {
  kind: GenerationKind
  begin(
    target: PrepareTargetInput,
    force: boolean,
    skill: LoadedSkill,
    tools: PipelineTools
  ): Promise<PipelineRun>
}

export interface GenerationManagerDeps {
  runner: AgentRunner
  checkouts: ReviewCheckouts
  pipeline: GenerationPipeline
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
   * The generations of this data dir. The worktrees of one clone write the same canvas and tour
   * folders, so their managers, of either kind, share one lane: one job runs at a time across
   * them, and each manager sees and stops the job of its kind in it, whichever started it. A
   * manager of its own has a lane of its own.
   */
  lane?: GenerationLane | undefined
  /** The linked worktree the manager's checkout is, null for the main checkout: it names which local reviews are its own. */
  worktree?: string | null | undefined
}

/**
 * The generations of one data dir: the last job of each kind and review folder, running or ended.
 * At most one of them has not settled, and that one holds the lane.
 */
export interface GenerationLane {
  jobs: Map<string, GenerationSlot>
}

export function createGenerationLane(): GenerationLane {
  return { jobs: new Map() }
}

export interface GenerationManager {
  /**
   * Starts a job for `key`; throws GenerationBusyError when any job is running. One runs at a
   * time: two reviews can share a head (a PR and the branch review of its branch), and the jobs
   * of one head write the same canvas folder. `opts` may name the agent and model and turn sharing
   * off for this job only.
   */
  start(key: ReviewKey, opts: GenerateInput): Promise<GenerationJob>
  /**
   * The last job of `key`'s review, running or ended; null when it ran none. A pull request's job
   * is every worktree's, a local review's is its own checkout's.
   */
  status(key: ReviewKey): GenerationJob | null
  /** True when a running job was asked to stop. */
  cancel(key: ReviewKey): Promise<boolean>
  /** The review whose job is running now, when it is this checkout's (as for `status`). */
  running(): ReviewKey | null
  /** The skill a job started now would follow, with the agent the settings name. */
  nextSkill(): Promise<GenerationSkill>
}

/** A job with its running side, which the status never shows. The lane keeps each review's last one. */
export interface GenerationSlot {
  job: GenerationJob
  /** The review's folder in the data dir (`reviewFolder`), which says whose job it is. */
  folder: string
  /** True once the job has ended and let go of its checkout; until then it holds the lane. */
  settled: boolean
  run: AgentRun | null
  lease: CheckoutLease | null
  stopped: boolean
  /** The tool call id behind each line of `job.activity`, in the same order. */
  activityIds: string[]
  /** Folders a tool title is shown relative to: the agent's working directory and the artifact's. */
  shortPaths: string[]
  /** The skill the first turn sends; `job.skill` is its `info`. */
  skill: LoadedSkill
  /** False when the job was started with sharing off, whatever the settings say. */
  share: boolean
  /** The ref a local review is compared against, when the start named one. */
  base: string | undefined
}

type Slot = GenerationSlot

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

function targetOf(key: ReviewKey, base: string | undefined): PrepareTargetInput {
  return isLocalKey(key) ? { kind: 'local', source: key, base } : { kind: 'pr', number: key }
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

/**
 * The canvas: prepare, a read-only agent answering with the model JSON, which the server writes,
 * fixes what `validate --fix` would, and publishes.
 */
export function canvasPipeline(steps: GenerationSteps): GenerationPipeline {
  return {
    kind: 'canvas',
    async begin(target, force, skill, tools) {
      // `force` is the reader's "start from a blank page". A canvas that already exists for the
      // head can only be written again from one, so prepare says so and is asked again with force.
      const first = await steps.prepare(target, { force, log: () => undefined })
      const prepared =
        first.status === 'exists' ? await steps.prepare(target, { force: true, log: () => undefined }) : first
      tools.prepared(prepared.headSha)
      const code = await tools.codeSource(prepared.headSha)
      const modelPath = path.join(prepared.canvasDir, 'model.json')
      const task = await readFile(prepared.promptPath, 'utf8')
      return {
        headSha: prepared.headSha,
        cwd: code.cwd,
        // The canvas dir first: it may sit inside the working directory.
        shortPaths: [prepared.canvasDir, code.cwd],
        access: 'read',
        prompt: generationPrompt(code, prepared.headSha, modelPath, skill, task),
        async take(answer) {
          // An answer with no object in it is written as it is, so the validator names the problem.
          const text = extractModelJson(answer) ?? answer
          await writeTextAtomic(modelPath, `${text.trimEnd()}\n`)
          return steps.fix(prepared.canvasDir, modelPath, text)
        },
        async publish({ agent, model, share }) {
          try {
            const result = await steps.publish(prepared.canvasDir, {
              agent,
              model: model ?? undefined,
              harness: 'other',
              allowStale: false,
              share,
            })
            return { sharing: result.sharing }
          } catch (err) {
            if (!(err instanceof ModelInvalidError)) {
              throw err
            }
            return { problems: err.report.errors.map(formatValidationError) }
          }
        },
        repairPrompt,
      }
    },
  }
}

export function createGenerationManager(deps: GenerationManagerDeps): GenerationManager {
  const lane = deps.lane ?? createGenerationLane()
  const worktree = deps.worktree ?? null
  const { pipeline } = deps
  const folderOf = (key: ReviewKey): string => reviewFolder(key, worktree)
  /** Each kind keeps its own last job of a review. */
  const laneKey = (key: ReviewKey): string => `${pipeline.kind}:${folderOf(key)}`
  /** The job holding the lane, of either kind: started, and not done letting go of its checkout. */
  const holding = (): Slot | null => [...lane.jobs.values()].find(slot => !slot.settled) ?? null
  /** The last job of this kind of `key`'s review in this checkout. */
  const of = (key: ReviewKey): Slot | null => lane.jobs.get(laneKey(key)) ?? null
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
  const turn = async (slot: Slot, session: string, prompt: string, run: PipelineRun): Promise<string> => {
    throwIfStopped(slot)
    const { job } = slot
    const handle = deps.runner.run({
      agent: job.agent,
      session,
      prompt,
      cwd: run.cwd,
      timeoutSec: GENERATION_TURN_TIMEOUT_SEC,
      model: job.model ?? undefined,
      access: run.access,
    })
    // `run` spawns without waiting, so a stop arriving from here on finds the handle.
    slot.run = handle
    let answer = ''
    let doing: AgentPulse['doing'] = 'starting'
    const runningTools = new Set<string>()
    const beat = (next: AgentPulse['doing']): void => {
      doing = next
      job.pulse = { doing, at: deps.now().toISOString(), written: answer.length }
    }
    beat('starting')
    try {
      for await (const event of handle.events) {
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
    const run = await pipeline.begin(targetOf(key, slot.base), job.force, slot.skill, {
      prepared: headSha => {
        job.headSha = headSha
        throwIfStopped(slot)
      },
      codeSource: async headSha => codeSource(slot, key, headSha, await deps.settings()),
    })
    slot.shortPaths = run.shortPaths
    throwIfStopped(slot)

    const session = `pr-review-${slug(deps.repo.owner)}-${slug(deps.repo.name)}-${keyToString(key)}-${slug(job.agent)}-${pipeline.kind === 'canvas' ? 'gen' : 'tour'}${deps.now().getTime()}`
    await deps.runner.ensureSession({
      agent: job.agent,
      session,
      cwd: run.cwd,
      timeoutSec: GENERATION_TURN_TIMEOUT_SEC,
    })

    let prompt = run.prompt
    for (;;) {
      job.phase = job.round === 1 ? 'generating' : 'repairing'
      const fixed = await run.take(await turn(slot, session, prompt, run))
      throwIfStopped(slot)
      job.phase = 'publishing'
      const result = await run.publish({ agent: job.agent, model: job.model, share: slot.share })
      if ('sharing' in result) {
        end(slot, 'done', { sharing: result.sharing })
        deps.log(`generation ${label(key)}: published ${run.headSha.slice(0, 7)}`)
        return
      }
      job.problems = result.problems
      if (job.round >= maxRounds) {
        end(slot, 'failed', {
          error: {
            code: 'MODEL_INVALID',
            message: `publish rejected the model ${job.round} times`,
            hint: `run the skill from Claude Code or Codex to finish this ${pipeline.kind} by hand`,
          },
        })
        return
      }
      job.round += 1
      prompt = run.repairPrompt(job.problems, fixed, job.round, maxRounds)
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
    slot.settled = true
  }

  return {
    async start(key, opts) {
      const busy = holding()
      if (busy !== null) {
        throw new GenerationBusyError(busy.job.key, busy.job.kind)
      }
      const settings = await deps.settings()
      const agent = opts.agent ?? settings.chatAgent
      const skill = await deps.skill(agent)
      // A model the start names reads as the project's would.
      const named = opts.model ?? deps.generation.models[agent]
      const model =
        named === undefined ? null : latestModel(agent, named, await deps.runner.modelUpgrades(agent))
      // Checked again after the awaits: two clicks that both got past the first check start one job.
      const started = holding()
      if (started !== null) {
        throw new GenerationBusyError(started.job.key, started.job.kind)
      }
      const slot: Slot = {
        job: {
          kind: pipeline.kind,
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
        folder: folderOf(key),
        settled: false,
        run: null,
        lease: null,
        stopped: false,
        activityIds: [],
        shortPaths: [],
        skill,
        share: opts.share !== false,
        base: opts.base,
      }
      lane.jobs.set(laneKey(key), slot)
      deps.log(
        `generation ${label(key)}: started the ${pipeline.kind} with ${agent}${model === null ? '' : ` (${model})`}`
      )
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

    running: () => {
      const slot = holding()
      return slot !== null && slot.folder === folderOf(slot.job.key) ? slot.job.key : null
    },
    async nextSkill() {
      const { chatAgent } = await deps.settings()
      return (await deps.skill(chatAgent)).info
    },
  }
}
