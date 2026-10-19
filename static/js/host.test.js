// @ts-check
import {
  authorProfileUrl,
  currentHost,
  fileUrl,
  hostLabel,
  noPostingTitle,
  postToLabel,
  setHost,
} from './host.js'

describe('host words and links', () => {
  afterEach(() => {
    setHost(undefined)
  })

  it('speaks GitHub until the bootstrap names another host', () => {
    expect(currentHost().kind).toBe('github')
    expect(hostLabel()).toBe('GitHub')
    expect(postToLabel()).toBe('post to github')
    expect(noPostingTitle()).toBe('this GitHub login cannot post on this repository')
    expect(authorProfileUrl('octocat')).toBe('https://github.com/octocat')
    expect(fileUrl({ owner: 'acme', name: 'widgets' }, 'abc', 'src/a b.ts', 12)).toBe(
      'https://github.com/acme/widgets/blob/abc/src/a%20b.ts#L12'
    )
  })

  it('speaks GitLab, with profile links on the instance the server named', () => {
    setHost({ kind: 'gitlab', label: 'GitLab', webBase: 'https://gitlab.example.com' })
    expect(currentHost().kind).toBe('gitlab')
    expect(postToLabel()).toBe('post to gitlab')
    expect(noPostingTitle()).toBe('this GitLab login cannot post on this repository')
    expect(authorProfileUrl('alice')).toBe('https://gitlab.example.com/alice')
    expect(fileUrl({ owner: 'group/sub', name: 'widgets' }, 'abc', 'src/a.ts')).toBe(
      'https://gitlab.example.com/group/sub/widgets/-/blob/abc/src/a.ts'
    )
  })
})
