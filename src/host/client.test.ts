// @vitest-environment node
import { GITHUB_HOST, gitlabHost } from './host.js'
import { createHostClient } from './client.js'

describe('createHostClient', () => {
  it('builds a GitHub client and a GitLab client', () => {
    expect(typeof createHostClient(GITHUB_HOST).api).toBe('function')
    expect(typeof createHostClient(gitlabHost('gitlab.com')).api).toBe('function')
  })
})
