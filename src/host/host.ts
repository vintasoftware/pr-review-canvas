import type { Repo } from '../contract/review-artifact.js'

export const HOST_KINDS = ['github', 'gitlab'] as const
export type HostKind = (typeof HOST_KINDS)[number]

export interface HostInfo {
  kind: HostKind
  hostname: string
  label: string
  cliName: string
  webBase: string
}

export const GITHUB_HOST: HostInfo = {
  kind: 'github',
  hostname: 'github.com',
  label: 'GitHub',
  cliName: 'gh',
  webBase: 'https://github.com',
}

export function gitlabHost(hostname: string): HostInfo {
  return {
    kind: 'gitlab',
    hostname,
    label: 'GitLab',
    cliName: 'glab',
    webBase: `https://${hostname}`,
  }
}

export function reviewNoun(host: HostInfo): string {
  return host.kind === 'gitlab' ? 'merge request' : 'pull request'
}

export function reviewNounShort(host: HostInfo): string {
  return host.kind === 'gitlab' ? 'MR' : 'PR'
}

export function compareUrl(host: HostInfo, repo: Repo, base: string, head: string): string {
  const basePath = `${host.webBase}/${repo.owner}/${repo.name}`
  return host.kind === 'gitlab'
    ? `${basePath}/-/compare/${base}...${head}`
    : `${basePath}/compare/${base}...${head}`
}

export function authorProfileUrl(host: HostInfo, author: string): string {
  return `${host.webBase}/${author}`
}

export function publicHost(host: HostInfo): { kind: HostKind; label: string; cliName: string } {
  return { kind: host.kind, label: host.label, cliName: host.cliName }
}
