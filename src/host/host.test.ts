// @vitest-environment node
import { TEST_REPO } from '../testing/fakes.js'
import { GITHUB_HOST, gitlabHost, publicHost } from './host.js'

describe('hosts', () => {
  it('describe GitHub and a GitLab instance in their own words, CLI, and URLs', () => {
    expect(GITHUB_HOST).toMatchObject({
      kind: 'github',
      hostname: 'github.com',
      label: 'GitHub',
      noun: 'pull request',
      nounShort: 'PR',
      cli: { cli: 'gh', env: {} },
    })
    expect(GITHUB_HOST.remoteHeadRef(42)).toBe('pull/42/head')
    expect(GITHUB_HOST.compareUrl(TEST_REPO, 'main', 'feat')).toBe(
      'https://github.com/acme/widgets/compare/main...feat'
    )

    const gitlab = gitlabHost('gitlab.example.com')
    expect(gitlab).toMatchObject({
      kind: 'gitlab',
      hostname: 'gitlab.example.com',
      label: 'GitLab',
      webBase: 'https://gitlab.example.com',
      noun: 'merge request',
      nounShort: 'MR',
      cli: { cli: 'glab', env: { GITLAB_HOST: 'gitlab.example.com' } },
    })
    expect(gitlab.remoteHeadRef(42)).toBe('merge-requests/42/head')
    expect(gitlab.compareUrl(TEST_REPO, 'main', 'feat')).toBe(
      'https://gitlab.example.com/acme/widgets/-/compare/main...feat'
    )
  })

  it('tells the page only what it needs', () => {
    expect(publicHost(gitlabHost('gitlab.com'))).toEqual({
      kind: 'gitlab',
      label: 'GitLab',
      webBase: 'https://gitlab.com',
    })
    expect(JSON.parse(JSON.stringify(publicHost(GITHUB_HOST)))).toEqual({
      kind: 'github',
      label: 'GitHub',
      webBase: 'https://github.com',
    })
  })
})
