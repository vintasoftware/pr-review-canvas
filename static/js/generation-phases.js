// @ts-check
// Where a generation is, in the words a person reads. Both sides use this file: the review page's
// generate dialog through a module import, and `pr-review generate` through
// src/contract/generation.ts.
/** @typedef {import('./contract-types.js').GenerationJob} GenerationJob */

/** @type {Record<GenerationJob['phase'], string>} */
export const PHASE_LABELS = {
  preparing: 'Preparing the diff',
  checkout: 'Checking out the head',
  generating: 'The agent is writing the canvas',
  publishing: 'Validating and publishing',
  repairing: 'The agent is fixing what publish rejected',
  done: 'Done',
  failed: 'Generation failed',
  cancelled: 'Generation stopped',
}

/**
 * True while the job can still change.
 * @param {Pick<GenerationJob, 'phase'>} job
 */
export function isRunning(job) {
  return job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled'
}
