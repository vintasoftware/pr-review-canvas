// @vitest-environment node
import { createFakeGh, ghError, ghJson, TEST_REPO } from '../testing/fakes.js'
import { HostCliError } from '../host/client.js'
import { decideGitlabCapabilities, probeGitlabCapabilities } from './capabilities.js'

describe('decideGitlabCapabilities', () => {
  it('allows Reporter and above, refuses Guest, and stays unknown without permissions', () => {
    expect(
      decideGitlabCapabilities('alice', { permissions: { project_access: { access_level: 30 } } })
    ).toEqual({ canComment: true, tokenKind: 'glab', login: 'alice' })
    expect(
      decideGitlabCapabilities('alice', { permissions: { project_access: { access_level: 10 } } })
    ).toMatchObject({ canComment: false, login: 'alice' })
    expect(decideGitlabCapabilities('alice', {})).toMatchObject({ canComment: 'unknown', login: 'alice' })
    expect(decideGitlabCapabilities('alice', 'nope')).toMatchObject({ canComment: 'unknown', login: 'alice' })
  })
})

describe('probeGitlabCapabilities', () => {
  it('reads username and project permissions', async () => {
    const gh = createFakeGh({
      routes: {
        user: ghJson({ username: 'alice' }),
        'projects/acme%2Fwidgets': ghJson({ permissions: { group_access: { access_level: 40 } } }),
      },
    })
    expect(await probeGitlabCapabilities(gh, TEST_REPO)).toEqual({
      canComment: true,
      tokenKind: 'glab',
      login: 'alice',
    })
  })

  it('continues when /user cannot be read', async () => {
    const gh = createFakeGh({
      routes: {
        'projects/acme%2Fwidgets': ghJson({ permissions: { project_access: { access_level: 30 } } }),
      },
    })
    expect(await probeGitlabCapabilities(gh, TEST_REPO)).toMatchObject({ canComment: true, login: null })
  })

  it('reports a failed project probe', async () => {
    const gh = createFakeGh({
      routes: {
        user: ghJson({ username: 'alice' }),
        'projects/acme%2Fwidgets': ghError(new HostCliError('gh', 'x', 'HTTP 403', 1)),
      },
    })
    expect(await probeGitlabCapabilities(gh, TEST_REPO)).toMatchObject({
      canComment: false,
      login: 'alice',
      hint: 'run `glab auth status` and log in again',
    })
  })
})
