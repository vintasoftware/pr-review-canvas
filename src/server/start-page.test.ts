// @vitest-environment node
import { HostCliError } from '../host/client.js'
import { GITHUB_HOST, gitlabHost } from '../host/host.js'
import {
  createFakeGh,
  createFakeGit,
  ghError,
  ghHandler,
  ghJson,
  makeTestContext,
  type TestContext,
} from '../testing/fakes.js'
import { startPage } from './start-page.js'

const PULLS = 'repos/acme/widgets/pulls'
const MRS = 'projects/acme%2Fwidgets/merge_requests'

let t: TestContext | null = null
afterEach(async () => {
  await t?.cleanup()
  t = null
})

describe('startPage', () => {
  it('opens the review of the GitHub PR whose head is the checked-out branch', async () => {
    const gh = createFakeGh({
      routes: { [PULLS]: ghHandler(params => (params['head'] === 'acme:feature' ? [{ number: 42 }] : [])) },
    })
    t = await makeTestContext({ gh, git: createFakeGit({ branch: 'feature' }) })

    expect(await startPage(t.ctx)).toEqual({ path: '/review/42', prNumber: 42 })
    expect(gh.calls).toEqual([
      { kind: 'api', path: PULLS, params: { state: 'open', head: 'acme:feature', per_page: '1' } },
    ])
  })

  it('opens the review of the GitLab MR whose source is the checked-out branch', async () => {
    const gh = createFakeGh({
      routes: { [MRS]: ghHandler(params => (params['source_branch'] === 'feature' ? [{ iid: 7 }] : [])) },
    })
    t = await makeTestContext({
      gh,
      host: gitlabHost('gitlab.example.com'),
      git: createFakeGit({ branch: 'feature' }),
    })

    expect(await startPage(t.ctx)).toEqual({ path: '/review/7', prNumber: 7 })
    expect(gh.calls[0]?.params).toEqual({ state: 'opened', source_branch: 'feature', per_page: '1' })
  })

  it('opens the home page when no open review has this branch as its head', async () => {
    t = await makeTestContext({
      host: GITHUB_HOST,
      gh: createFakeGh({ routes: { [PULLS]: ghJson([]) } }),
      git: createFakeGit({ branch: 'main' }),
    })

    expect(await startPage(t.ctx)).toEqual({ path: '/', prNumber: null })
  })

  it('opens the home page on a detached HEAD without asking the forge', async () => {
    const gh = createFakeGh()
    t = await makeTestContext({ gh, git: createFakeGit({ branch: null }) })

    expect(await startPage(t.ctx)).toEqual({ path: '/', prNumber: null })
    expect(gh.calls).toEqual([])
  })

  it('opens the home page when the lookup fails', async () => {
    t = await makeTestContext({
      gh: createFakeGh({
        routes: { [PULLS]: ghError(new HostCliError('gh', PULLS, 'gh: not logged in', 1)) },
      }),
      git: createFakeGit({ branch: 'feature' }),
    })

    expect(await startPage(t.ctx)).toEqual({ path: '/', prNumber: null })
  })
})
