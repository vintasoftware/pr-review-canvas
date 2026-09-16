// @ts-check
// @vitest-environment happy-dom
import {
  authorProfileUrl,
  currentHost,
  forgeLabel,
  noPostingTitle,
  postToLabel,
  setHost,
  signoffHostTitle,
} from './host.js'

describe('host labels', () => {
  afterEach(() => {
    setHost(undefined)
  })

  it('defaults to GitHub and switches to GitLab', () => {
    expect(forgeLabel()).toBe('GitHub')
    expect(postToLabel()).toBe('post to github')
    expect(signoffHostTitle('APPROVE')).toBe('Approve on GitHub')
    setHost({ kind: 'gitlab', label: 'GitLab', cliName: 'glab' })
    expect(currentHost().kind).toBe('gitlab')
    expect(postToLabel()).toBe('post to gitlab')
    expect(noPostingTitle()).toBe('this GitLab login cannot post on this repository')
    expect(signoffHostTitle('REQUEST_CHANGES')).toBe('Request changes on GitLab')
    expect(authorProfileUrl('alice')).toBe('https://gitlab.com/alice')
    setHost({ kind: 'github', label: 'GitHub' })
    expect(authorProfileUrl('octocat')).toBe('https://github.com/octocat')
  })
})
