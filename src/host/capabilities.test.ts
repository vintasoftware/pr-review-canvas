// @vitest-environment node
import { createFakeGh, ghJson, TEST_REPO } from '../testing/fakes.js'
import { GH_REPO_RESPONSE } from '../testing/synthetic.js'
import { probeCapabilities } from '../github/capabilities.js'
import { CAPABILITY_TTL_MS, createCapabilityProbe } from './capabilities.js'

describe('createCapabilityProbe', () => {
  it('probes once, reuses the answer, and probes again after the cache expires or on refresh', async () => {
    const gh = createFakeGh({
      routes: { user: ghJson({ login: 'octocat' }) },
      rawRoutes: { 'repos/acme/widgets': GH_REPO_RESPONSE },
    })
    let at = new Date('2026-09-10T12:00:00.000Z')
    const probe = createCapabilityProbe(
      () => probeCapabilities(gh, TEST_REPO),
      () => at
    )
    await probe.get()
    await probe.get()
    expect(gh.calls.filter(c => c.kind === 'raw')).toHaveLength(1)
    await probe.get({ refresh: true })
    expect(gh.calls.filter(c => c.kind === 'raw')).toHaveLength(2)
    at = new Date(at.getTime() + CAPABILITY_TTL_MS + 1)
    await probe.get()
    expect(gh.calls.filter(c => c.kind === 'raw')).toHaveLength(3)
  })
})
