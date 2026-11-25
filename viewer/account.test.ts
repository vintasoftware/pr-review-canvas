// @vitest-environment happy-dom
import type { Auth } from './auth.js'
import { authConfigFrom, configProblem, renderAccount, safeReturnTo } from './account.js'

it('turns sign-in on only when the build names both the app and the Worker', () => {
  expect(authConfigFrom({})).toBeNull()
  expect(authConfigFrom({ VITE_GITHUB_CLIENT_ID: 'Iv1.x' })).toBeNull()
  expect(
    authConfigFrom({ VITE_GITHUB_CLIENT_ID: 'Iv1.x', VITE_AUTH_WORKER_URL: ' https://auth.test ' })
  ).toEqual({
    clientId: 'Iv1.x',
    workerUrl: 'https://auth.test',
  })
  expect(
    authConfigFrom({
      VITE_GITHUB_CLIENT_ID: 'Iv1.x',
      VITE_AUTH_WORKER_URL: 'https://auth.test',
      VITE_GITHUB_APP_SLUG: 'pr-review-canvas',
    })
  ).toMatchObject({ installUrl: 'https://github.com/apps/pr-review-canvas/installations/new' })
})

it.each([
  ['/?pr=acme/widgets/42#layer-1', '/?pr=acme/widgets/42#layer-1'],
  ['//evil.test/', '/'],
  ['/\\evil.test', '/'],
  ['https://evil.test/', '/'],
  ['', '/'],
])('returns to %s as %s after sign-in', (raw, expected) => {
  expect(safeReturnTo(raw)).toBe(expected)
})

it("catches the app's numeric App ID given as its Client ID", () => {
  const config = { clientId: '5887572', workerUrl: 'https://auth.test' }
  expect(configProblem(config)).toMatch(/looks like the app's App ID; set it to the Client ID/)
  expect(configProblem({ ...config, clientId: 'Iv23liExample' })).toBeNull()
})

/** An Auth whose session the test sets, and that tells its listeners when it changes. */
function fakeAuth(signedIn: boolean) {
  const listeners: Array<() => void> = []
  let session = signedIn
  const auth = {
    signedIn: () => session,
    signInUrl: vi.fn(() => Promise.resolve('https://github.com/login/oauth/authorize?x=1')),
    signOut: vi.fn(() => {
      session = false
    }),
    onChange: (listener: () => void) => listeners.push(listener),
  } as unknown as Auth
  return { auth, change: (next: boolean) => ((session = next), listeners.forEach(l => l())) }
}

it('offers sign-in to an anonymous reader, and starts it on this page', async () => {
  const assign = vi.spyOn(location, 'assign').mockImplementation(() => {})
  const host = document.createElement('div')
  const { auth } = fakeAuth(false)
  renderAccount(host, {
    auth,
    redirectUri: 'https://viewer.test/',
    login: () => Promise.resolve(null),
    notice: 'GitHub sign-in was cancelled',
  })
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('GitHub sign-in was cancelled')
  expect(host.textContent).toContain('Reading anonymously: public pull requests only.')
  host.querySelector('button')!.click()
  expect(host.querySelector('button')!.disabled).toBe(true)
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?x=1'))
  assign.mockRestore()
})

it('names the signed-in reader, says a line on request, and redraws when the session changes', async () => {
  const reload = vi.spyOn(location, 'reload').mockImplementation(() => {})
  const host = document.createElement('div')
  const { auth, change } = fakeAuth(true)
  const say = renderAccount(host, {
    auth,
    redirectUri: 'https://viewer.test/',
    login: () => Promise.resolve('octocat'),
    notice: null,
  })
  await vi.waitFor(() => expect(host.textContent).toContain('Signed in to GitHub as @octocat.'))
  say('GitHub no longer accepts your sign-in')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('GitHub no longer accepts your sign-in')
  host.querySelector('button')!.click()
  expect(auth.signOut).toHaveBeenCalled()
  expect(reload).toHaveBeenCalled()
  change(false)
  expect(host.textContent).toContain('Reading anonymously')
  reload.mockRestore()
})
