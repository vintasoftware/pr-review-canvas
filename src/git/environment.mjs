// Remove hook repository pointers so cwd selects the repository. Keep configuration,
// credentials, and discovery limits: callers may rely on relocated config files, inline
// config, SSH agents, proxies, or filesystem discovery fences.
export const REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

/**
 * `env` without those variables. Everything else is kept, so ssh agents, credential helpers,
 * proxies, and PATH still reach `fetch`.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithoutRepo(env = process.env) {
  const clean = { ...env }
  for (const name of REPO_ENV_VARS) {
    delete clean[name]
  }
  return clean
}
