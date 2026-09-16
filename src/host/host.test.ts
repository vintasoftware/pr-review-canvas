// @vitest-environment node
import { TEST_REPO } from '../testing/fakes.js'
import {
  authorProfileUrl,
  compareUrl,
  GITHUB_HOST,
  gitlabHost,
  publicHost,
  reviewNoun,
  reviewNounShort,
} from './host.js'

describe('host labels and URLs', () => {
  it('names GitHub and GitLab reviews', () => {
    expect(reviewNoun(GITHUB_HOST)).toBe('pull request')
    expect(reviewNounShort(GITHUB_HOST)).toBe('PR')
    expect(reviewNoun(gitlabHost('gitlab.com'))).toBe('merge request')
    expect(reviewNounShort(gitlabHost('gitlab.com'))).toBe('MR')
  })

  it('builds compare and profile URLs', () => {
    expect(compareUrl(GITHUB_HOST, TEST_REPO, 'main', 'feat')).toBe(
      'https://github.com/acme/widgets/compare/main...feat'
    )
    expect(compareUrl(gitlabHost('gitlab.com'), TEST_REPO, 'main', 'feat')).toBe(
      'https://gitlab.com/acme/widgets/-/compare/main...feat'
    )
    expect(authorProfileUrl(GITHUB_HOST, 'octocat')).toBe('https://github.com/octocat')
    expect(authorProfileUrl(gitlabHost('gitlab.example.com'), 'alice')).toBe(
      'https://gitlab.example.com/alice'
    )
  })

  it('exposes the public host fields the page needs', () => {
    expect(publicHost(gitlabHost('gitlab.com'))).toEqual({
      kind: 'gitlab',
      label: 'GitLab',
      cliName: 'glab',
    })
  })
})
