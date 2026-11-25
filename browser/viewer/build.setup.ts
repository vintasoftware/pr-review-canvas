// Builds the static viewer once per run, as CI builds it, for the specs in this folder to serve
// under the headers Cloudflare Pages sends. The build names a test GitHub App and auth Worker; the
// specs answer both, and GitHub itself, from inside the browser.
import { fileURLToPath } from 'node:url'
import { test as setup } from '@playwright/test'
import { build } from 'vite'
import { VIEWER_BUILD_DIR, VIEWER_TEST_ENV } from './fixtures.js'

setup('build the viewer', async () => {
  setup.setTimeout(120_000)
  // Values already in the environment win over viewer/.env.local, so a developer's own app and
  // Worker never reach this build.
  Object.assign(process.env, VIEWER_TEST_ENV)
  await build({
    configFile: fileURLToPath(new URL('../../viewer/vite.config.js', import.meta.url)),
    logLevel: 'warn',
    build: { outDir: VIEWER_BUILD_DIR, emptyOutDir: true },
  })
})
