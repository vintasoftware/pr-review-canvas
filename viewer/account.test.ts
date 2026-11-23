import { authConfigFrom, configProblem, safeReturnTo } from './account.js'

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
