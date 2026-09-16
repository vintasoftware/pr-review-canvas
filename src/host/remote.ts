import type { Repo } from '../contract/review-artifact.js'
import { GITHUB_HOST, gitlabHost, type Host } from './host.js'

export interface OriginRemote {
  host: Host
  repo: Repo
}

/** Hostname and repository path from the three remote forms git gives out: scp-like ssh, ssh://, https. */
export function splitGitRemote(url: string): { hostname: string; path: string } | null {
  const m =
    /^ssh:\/\/git@([^:/]+)(?::\d+)?\/(.+)$/.exec(url.trim()) ??
    /^git@([^:/]+):(.+)$/.exec(url.trim()) ??
    /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(url.trim())
  if (m?.[1] === undefined || m[2] === undefined) {
    return null
  }
  return { hostname: m[1].toLowerCase(), path: m[2].replace(/\.git$/i, '').replace(/\/$/, '') }
}

/**
 * Classifies origin. github.com is GitHub; gitlab.com, a hostname that contains "gitlab", or any
 * other host when `PR_REVIEW_HOST=gitlab` is set (a self-hosted GitLab whose name does not say
 * so) is GitLab. A GitLab path may nest groups, which become the owner with slashes.
 */
export function parseOriginRemote(url: string, env: NodeJS.ProcessEnv = {}): OriginRemote | null {
  const split = splitGitRemote(url)
  if (split === null) {
    return null
  }
  const parts = split.path.split('/').filter(p => p !== '')
  const name = parts[parts.length - 1]
  if (parts.length < 2 || name === undefined) {
    return null
  }
  const repo: Repo = { owner: parts.slice(0, -1).join('/'), name }
  if (split.hostname === 'github.com') {
    return parts.length === 2 ? { host: GITHUB_HOST, repo } : null
  }
  const forced = env['PR_REVIEW_HOST']?.trim().toLowerCase() === 'gitlab'
  return forced || split.hostname.includes('gitlab') ? { host: gitlabHost(split.hostname), repo } : null
}
