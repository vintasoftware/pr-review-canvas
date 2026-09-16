import { createGitHubClient, type GitHubClient } from '../github/gh.js'
import { createGitLabClient } from '../gitlab/glab.js'
import type { HostInfo } from './host.js'

export function createHostClient(host: HostInfo): GitHubClient {
  return host.kind === 'gitlab' ? createGitLabClient(host.hostname) : createGitHubClient()
}
