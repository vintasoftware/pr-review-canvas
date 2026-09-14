// @vitest-environment node
// Whether this gh login may post here, decided from the token scopes and the repo permissions.
import { createFakeGh, ghError, ghJson, TEST_REPO } from '../testing/fakes.js'
import { GH_REPO_RESPONSE } from '../testing/synthetic.js'
import {
  CAPABILITY_TTL_MS,
  createCapabilityProbe,
  decideCapabilities,
  probeCapabilities,
  SCOPE_HINT,
} from './capabilities.js'
import { type GhResponse, GitHubApiError, type GitHubClient } from './gh.js'

function response(headers: Record<string, string>, body: unknown): GhResponse {
  return { status: 200, headers, body }
}

const PRIVATE_PULL = { private: true, permissions: { pull: true, push: true } }

describe('decideCapabilities', () => {
  it('allows posting for a classic token with repo scope and read access', () => {
    expect(decideCapabilities('octocat', response({ 'x-oauth-scopes': 'gist, repo' }, PRIVATE_PULL))).toEqual({
      canComment: true,
      tokenKind: 'classic',
      login: 'octocat',
    })
  })

  it('allows public_repo on a public repository and refuses it on a private one', () => {
    const publicRepo = { private: false, permissions: { pull: true } }
    expect(decideCapabilities('octocat', response({ 'x-oauth-scopes': 'public_repo' }, publicRepo)).canComment).toBe(
      true
    )
    expect(decideCapabilities('octocat', response({ 'x-oauth-scopes': 'public_repo' }, PRIVATE_PULL))).toEqual({
      canComment: false,
      tokenKind: 'classic',
      login: 'octocat',
      reason: 'this token has no repo scope',
      hint: SCOPE_HINT,
    })
  })

  it('names public_repo as the missing scope on a public repository', () => {
    const publicRepo = { private: false, permissions: { pull: true } }
    expect(decideCapabilities('octocat', response({ 'x-oauth-scopes': 'gist' }, publicRepo))).toEqual({
      canComment: false,
      tokenKind: 'classic',
      login: 'octocat',
      reason: 'this token has no public_repo scope',
      hint: SCOPE_HINT,
    })
  })

  it('refuses a classic token with no scopes at all', () => {
    expect(decideCapabilities('octocat', response({ 'x-oauth-scopes': '' }, PRIVATE_PULL))).toEqual({
      canComment: false,
      tokenKind: 'classic',
      login: 'octocat',
      reason: 'this token has no repo scope',
      hint: SCOPE_HINT,
    })
  })

  it('refuses a scoped token that cannot read the repository', () => {
    expect(decideCapabilities('octocat', response({ 'x-oauth-scopes': 'repo' }, { private: true }))).toEqual({
      canComment: false,
      tokenKind: 'classic',
      login: 'octocat',
      reason: 'this login cannot read the repository',
      hint: 'ask for access to the repository',
    })
  })

  it('reports unknown when the answer carries no scopes header', () => {
    expect(decideCapabilities('octocat', response({}, PRIVATE_PULL))).toEqual({
      canComment: 'unknown',
      tokenKind: 'fine-grained',
      login: 'octocat',
      reason: 'this token does not report its scopes, so posting is tried and GitHub decides',
    })
  })

  it('treats a body it cannot read as a private repository with no access', () => {
    expect(decideCapabilities(null, response({ 'x-oauth-scopes': 'repo' }, 'not json')).canComment).toBe(false)
  })
})

describe('probeCapabilities', () => {
  it('reads the login and the repository in one probe', async () => {
    const gh = createFakeGh({
      routes: { user: ghJson({ login: 'octocat' }) },
      rawRoutes: { 'repos/acme/widgets': GH_REPO_RESPONSE },
    })
    expect(await probeCapabilities(gh, TEST_REPO)).toEqual({ canComment: true, tokenKind: 'classic', login: 'octocat' })
  })

  it('still probes the repository when the user call fails', async () => {
    const gh = createFakeGh({
      routes: { user: ghError(new GitHubApiError('user', 'HTTP 401', 1)) },
      rawRoutes: { 'repos/acme/widgets': GH_REPO_RESPONSE },
    })
    expect(await probeCapabilities(gh, TEST_REPO)).toEqual({ canComment: true, tokenKind: 'classic', login: null })
  })

  it('reports the failure the fake was told to raise', async () => {
    const gh = createFakeGh({
      routes: { user: ghJson({ login: 'octocat' }) },
      rawRoutes: { 'repos/acme/widgets': new GitHubApiError('repos', 'HTTP 500', 1) },
    })
    expect((await probeCapabilities(gh, TEST_REPO)).reason).toContain('HTTP 500')
  })

  it('reports a failure that is not an Error by its text', async () => {
    const gh = createFakeGh({ routes: { user: ghJson({ login: 'octocat' }) } })
    // `gh` runs as a child process, which can reject with something that is not an Error.
    const raw: GitHubClient = {
      ...gh,
      apiWithHeaders: () => Promise.reject('gh exited with signal SIGKILL'),
    }
    expect(await probeCapabilities(raw, TEST_REPO)).toEqual({
      canComment: false,
      tokenKind: 'unknown',
      login: 'octocat',
      reason: 'gh exited with signal SIGKILL',
      hint: 'run `gh auth status` and log in again',
    })
  })

  it('refuses posting when the repository call fails', async () => {
    const gh = createFakeGh({ routes: { user: ghJson({ login: 'octocat' }) } })
    expect(await probeCapabilities(gh, TEST_REPO)).toEqual({
      canComment: false,
      tokenKind: 'unknown',
      login: 'octocat',
      reason: 'gh api repos/acme/widgets failed (1): gh: Not Found (HTTP 404)',
      hint: 'run `gh auth status` and log in again',
    })
  })
})

describe('createCapabilityProbe', () => {
  it('probes once, reuses the answer, and probes again after the cache expires or on refresh', async () => {
    const gh = createFakeGh({
      routes: { user: ghJson({ login: 'octocat' }) },
      rawRoutes: { 'repos/acme/widgets': GH_REPO_RESPONSE },
    })
    let at = new Date('2026-09-10T12:00:00.000Z')
    const probe = createCapabilityProbe(gh, TEST_REPO, () => at)
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
