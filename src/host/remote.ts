import type { Repo } from '../contract/review-artifact.js'
import { GITHUB_HOST, gitlabHost, type HostInfo } from './host.js'

export interface OriginRemote {
  host: HostInfo
  repo: Repo
}

function stripGitSuffix(path: string): string {
  return path.replace(/\.git$/i, '').replace(/\/$/, '')
}

/** hostname + repo path from ssh (`git@host:group/project.git`) or https remotes. */
export function splitGitRemote(url: string): { hostname: string; path: string } | null {
  const trimmed = url.trim()
  const ssh = /^(?:git@|ssh:\/\/git@)([^:/]+)[:/](.+)$/.exec(trimmed)
  if (ssh?.[1] !== undefined && ssh[2] !== undefined) {
    return { hostname: ssh[1].toLowerCase(), path: stripGitSuffix(ssh[2]) }
  }
  const https = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(trimmed)
  if (https?.[1] !== undefined && https[2] !== undefined) {
    return { hostname: https[1].toLowerCase(), path: stripGitSuffix(https[2]) }
  }
  return null
}

function splitOwnerName(path: string): Repo | null {
  const parts = path.split('/').filter(p => p !== '')
  if (parts.length < 2) {
    return null
  }
  const name = parts[parts.length - 1]
  const owner = parts.slice(0, -1).join('/')
  if (name === undefined || owner === '') {
    return null
  }
  return { owner, name }
}

function looksLikeGitlabHost(hostname: string): boolean {
  return hostname === 'gitlab.com' || hostname.includes('gitlab')
}

/** Parses the two URL forms GitHub gives out: ssh (`git@github.com:o/r.git`) and https. */
export function parseGithubRemote(url: string): Repo | null {
  const m =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  if (!m || m[1] === undefined || m[2] === undefined) {
    return null
  }
  return { owner: m[1], name: m[2] }
}

/**
 * GitLab remotes: gitlab.com, a hostname that contains "gitlab", or any host when `force` is set
 * (self-hosted GitLab whose URL does not say gitlab). Nested groups become `owner` with slashes.
 */
export function parseGitlabRemote(url: string, force = false): { hostname: string; repo: Repo } | null {
  const split = splitGitRemote(url)
  if (split === null) {
    return null
  }
  if (!force && !looksLikeGitlabHost(split.hostname)) {
    return null
  }
  const repo = splitOwnerName(split.path)
  return repo === null ? null : { hostname: split.hostname, repo }
}

export function hostOverrideFromEnv(env: NodeJS.ProcessEnv): HostInfo['kind'] | null {
  const raw = env['PR_REVIEW_HOST']?.trim().toLowerCase()
  if (raw === 'github' || raw === 'gitlab') {
    return raw
  }
  return null
}

/**
 * Classifies origin. `PR_REVIEW_HOST=gitlab` marks a self-hosted GitLab whose hostname does not
 * contain "gitlab". GitHub stays github.com only.
 */
export function parseOriginRemote(url: string, env: NodeJS.ProcessEnv = {}): OriginRemote | null {
  const override = hostOverrideFromEnv(env)
  if (override === 'gitlab') {
    const gl = parseGitlabRemote(url, true)
    return gl === null ? null : { host: gitlabHost(gl.hostname), repo: gl.repo }
  }
  if (override === 'github') {
    const repo = parseGithubRemote(url)
    return repo === null ? null : { host: GITHUB_HOST, repo }
  }
  const gh = parseGithubRemote(url)
  if (gh !== null) {
    return { host: GITHUB_HOST, repo: gh }
  }
  const gl = parseGitlabRemote(url)
  return gl === null ? null : { host: gitlabHost(gl.hostname), repo: gl.repo }
}
