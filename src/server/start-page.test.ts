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
/** This project's id; a fork's merge request has another `source_project_id`. */
const PROJECT = 1
const FORK = 2

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
    const log: string[] = []

    expect(await startPage(t.ctx, line => log.push(line))).toBe('/r/acme/widgets/review/42')
    expect(gh.calls).toEqual([
      { kind: 'api', path: PULLS, params: { state: 'open', head: 'acme:feature', per_page: '1' } },
    ])
    expect(log).toEqual(['opening PR #42, the open review of this branch'])
  })

  it("answers paths under the project's base path", async () => {
    const pulls = ghHandler(params => (params['head'] === 'acme:feature' ? [{ number: 42 }] : []))
    t = await makeTestContext({
      repoRoot: '/trees/feature',
      gh: createFakeGh({ routes: { [PULLS]: pulls } }),
      git: createFakeGit({ branch: 'feature' }),
    })
    expect(await startPage(t.ctx, () => {})).toBe('/r/acme/widgets~feature/review/42')
    for (const branch of ['main', null]) {
      await t.cleanup()
      t = await makeTestContext({
        gh: createFakeGh({ routes: { [PULLS]: pulls } }),
        git: createFakeGit({ branch }),
      })
      expect(await startPage(t.ctx, () => {})).toBe('/r/acme/widgets/')
    }
    await t.cleanup()
    t = await makeTestContext({
      gh: createFakeGh({ routes: { [PULLS]: ghError(new Error('offline')) } }),
      git: createFakeGit({ branch: 'feature' }),
    })
    expect(await startPage(t.ctx, () => {})).toBe('/r/acme/widgets/')
  })

  describe('on GitLab', () => {
    // Open merge requests by source branch: a fork's `main` and this project's `feature`, which a
    // fork also uses.
    const mrs = ghHandler(params =>
      [
        { iid: 3, branch: 'main', source_project_id: FORK },
        { iid: 5, branch: 'feature', source_project_id: FORK },
        { iid: 7, branch: 'feature', source_project_id: PROJECT },
      ]
        .filter(mr => mr.branch === params['source_branch'])
        .map(({ iid, source_project_id }) => ({ iid, source_project_id, target_project_id: PROJECT }))
    )
    const gh = createFakeGh({ routes: { [MRS]: mrs } })
    const gitlabContext = (branch: string) =>
      makeTestContext({ gh, host: gitlabHost('gitlab.example.com'), git: createFakeGit({ branch }) })

    it('opens the review of the MR from this project whose source is the checked-out branch', async () => {
      t = await gitlabContext('feature')
      const log: string[] = []

      expect(await startPage(t.ctx, line => log.push(line))).toBe('/r/acme/widgets/review/7')
      expect(gh.calls.at(-1)?.params).toEqual({ state: 'opened', source_branch: 'feature', per_page: '100' })
      expect(log).toEqual(['opening MR #7, the open review of this branch'])
    })

    it('opens the home page when only a fork has an open MR from a branch of that name', async () => {
      t = await gitlabContext('main')

      expect(await startPage(t.ctx, () => {})).toBe('/r/acme/widgets/')
    })
  })

  it('opens the home page when no open review has this branch as its head', async () => {
    t = await makeTestContext({
      host: GITHUB_HOST,
      gh: createFakeGh({ routes: { [PULLS]: ghJson([]) } }),
      git: createFakeGit({ branch: 'main' }),
    })
    const log: string[] = []

    expect(await startPage(t.ctx, line => log.push(line))).toBe('/r/acme/widgets/')
    expect(log).toEqual([])
  })

  it('opens the home page on a detached HEAD without asking the forge', async () => {
    const gh = createFakeGh()
    t = await makeTestContext({ gh, git: createFakeGit({ branch: null }) })

    expect(await startPage(t.ctx, () => {})).toBe('/r/acme/widgets/')
    expect(gh.calls).toEqual([])
  })

  it('opens the home page and says why when the lookup fails', async () => {
    t = await makeTestContext({
      gh: createFakeGh({
        routes: { [PULLS]: ghError(new HostCliError('gh', PULLS, 'gh: not logged in', 1)) },
      }),
      git: createFakeGit({ branch: 'feature' }),
    })
    const log: string[] = []

    expect(await startPage(t.ctx, line => log.push(line))).toBe('/r/acme/widgets/')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatch(
      /^could not find the open PR of feature \(.*not logged in.*\); opening the home page$/
    )
  })
})
