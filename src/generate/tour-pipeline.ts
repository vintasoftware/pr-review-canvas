// The tour generation the tour page starts. The pr-tour skill writes a model and a scene file per
// landmark, looks at its pictures through `tour preview`, and runs try-it recipes in a checkout of
// its own, so unlike the canvas's this agent may write and run commands. The server still runs
// prepare and publish, so it keeps what sharing, the login check, and the job's status depend on;
// the agent runs the skill's steps between them, from the repository root, as from a terminal.
import type { GenerationSkill } from '../contract/generation.js'
import { formatTourError } from '../contract/tour.js'
import type { TourPrepareOptions, TourPrepareResult } from '../tour/prepare.js'
import { TourInvalidError, type TourPublishOptions, type TourPublishResult } from '../tour/publish.js'
import type { GenerationPipeline } from './generation-manager.js'
import type { LoadedSkill } from './skill.js'

export interface TourGenerationSteps {
  prepare(
    input: Parameters<GenerationPipeline['begin']>[0],
    opts: TourPrepareOptions
  ): Promise<TourPrepareResult>
  publish(tourDir: string, opts: TourPublishOptions): Promise<TourPublishResult>
  /** The repository root: the agent's working directory, where the skill runs every command. */
  repoRoot: string
  /**
   * How the agent runs this server's own pr-review, over the project's data dir: the words to
   * put where the skill writes `pr-review`, and the flag to add after each command.
   */
  cli: { command: string; dataDirFlag: string }
}

/** Where the skill came from, in the words the prompt uses. */
function skillSource(skill: GenerationSkill): string {
  return skill.source === 'project'
    ? `this project's copy, ${skill.path}`
    : `the one pr-review ${skill.version} ships`
}

/**
 * What the agent is sent first: the server's rules, the pr-tour skill the project uses, and what
 * prepare printed. The skill is written for a run from a terminal, which prepares and publishes
 * itself; here the server does both, so those steps are named and replaced, and everything else
 * the skill says, including what the project changed in it, holds.
 */
export function tourGenerationPrompt(
  prepared: TourPrepareResult,
  skill: LoadedSkill,
  cli: TourGenerationSteps['cli']
): string {
  const { tourDir } = prepared
  return [
    '# Generate a tour',
    '',
    `The pr-review server runs this generation. Follow the pr-tour skill below (${skillSource(skill.info)}) from its step 2, "Read the task", through its preview step.`,
    '',
    "- The server already ran the skill's prepare step and runs you on the model it picked: skip the skill's model choice and prepare steps, and the `/pr-tour-setup` interview. With no guide, go on without one, as the skill says a tour without a guide does.",
    `- Where the skill runs \`pr-review <step> …\`, run \`${cli.command} <step> … ${cli.dataDirFlag}\` instead, from the repository root: it is this server's own pr-review, over the data dir it serves the tour from. A \`pr-review\` on your PATH may be another version over another data dir.`,
    `- Write only under the tour directory, ${tourDir}, and in the checkout and scratch folder \`tour checkout\` prints. Do not change, commit, or push anything in the repository you run from.`,
    '- Do not run `tour publish`. Once validate passes and you have looked at the preview, answer with the single word `done`. The server publishes the tour and sends you the problems publish names; then fix them in the files, validate again, and answer `done` again.',
    '- Your report to the user is the job status the server shows: write no summary.',
    '',
    'What prepare printed:',
    '',
    '```json',
    JSON.stringify(prepared, null, 2),
    '```',
    '',
    '---',
    '',
    '# The pr-tour skill',
    '',
    skill.body.trim(),
  ].join('\n')
}

/** The message that sends the problems of a rejected publish back to the agent. */
export function tourRepairPrompt(problems: string[], round: number, maxRounds: number): string {
  return [
    `Publish rejected the tour (attempt ${round - 1} of ${maxRounds}). Fix exactly these problems in the model and scene files:`,
    '',
    ...problems.map(p => `- ${p}`),
    '',
    'Do not weaken the content to pass: shorten text, move hunks, fix anchors. Validate again, then answer with the single word `done`.',
  ].join('\n')
}

export function tourPipeline(steps: TourGenerationSteps): GenerationPipeline {
  return {
    kind: 'tour',
    async begin(target, force, skill, tools) {
      // As for the canvas, a head that already has a tour is written again from a blank page.
      const first = await steps.prepare(target, { force, log: () => undefined })
      const prepared =
        first.status === 'exists' ? await steps.prepare(target, { force: true, log: () => undefined }) : first
      tools.prepared(prepared.headSha)
      return {
        headSha: prepared.headSha,
        cwd: steps.repoRoot,
        shortPaths: [prepared.tourDir, steps.repoRoot],
        access: 'write',
        prompt: tourGenerationPrompt(prepared, skill, steps.cli),
        // The agent wrote the files itself; its answer is only that it is done.
        take: async () => [],
        async publish({ agent, model, share }) {
          try {
            const result = await steps.publish(prepared.tourDir, {
              agent,
              model: model ?? undefined,
              harness: 'other',
              allowStale: false,
              share,
            })
            return { sharing: result.sharing }
          } catch (err) {
            if (!(err instanceof TourInvalidError)) {
              throw err
            }
            return { problems: err.report.errors.map(formatTourError) }
          }
        },
        repairPrompt: (problems, _fixed, round, maxRounds) => tourRepairPrompt(problems, round, maxRounds),
      }
    },
  }
}
