// How the shared server builds one checkout's context: what `serve` used to do at startup for its
// one repository, now done per project with the flags and environment its command sent.
import { ConfigError, loadRuntimeConfig } from '../config.js'
import { type ReviewArtifact, ReviewArtifactSchema } from '../contract/review-artifact.js'
import { createGit } from '../git/git.js'
import { loadProjectConfig } from '../project-config.js'
import { createAppContext } from '../server/context.js'
import { readJson } from '../store/atomic-json.js'
import { ensureDataDir } from '../store/data-dir.js'
import type { LoadProject } from './hub.js'

export async function loadFixture(file: string): Promise<ReviewArtifact> {
  const artifact = await readJson(file, ReviewArtifactSchema)
  if (artifact === null) {
    throw new ConfigError('BAD_REQUEST', `fixture canvas not found: ${file}`)
  }
  return artifact
}

/** `port` is read when a project is built: the server knows it once it is listening. */
export function projectLoader(port: () => number): LoadProject {
  return async (registration, hooks) => {
    const flags = registration.flags ?? {}
    const git = createGit(registration.repoRoot)
    const config = await loadRuntimeConfig(
      {
        port: port(),
        dataDir: flags.dataDir,
        fixtureCanvas: flags.fixtureCanvas,
        chatAgent: flags.chatAgent,
        chatModel: flags.chatModel,
        noOpen: true,
      },
      registration.env ?? process.env,
      git,
      registration.repoRoot
    )
    const projectConfig = await loadProjectConfig(config.repoRoot)
    await ensureDataDir(config.dataDir)
    const fixtureArtifact =
      config.fixtureCanvasPath === null ? null : await loadFixture(config.fixtureCanvasPath)
    return createAppContext({
      config,
      projectConfig,
      fixtureArtifact,
      git,
      env: registration.env,
      log: hooks.log,
      chatBusyElsewhere: hooks.chatBusyElsewhere,
    })
  }
}
