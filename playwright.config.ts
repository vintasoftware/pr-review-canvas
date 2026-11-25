import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  fullyParallel: true,
  // Half the cores, as for the unit tests: each worker runs its own Chromium. `--workers` overrides.
  workers: '50%',
  forbidOnly: true,
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', testIgnore: 'viewer/**', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', testIgnore: 'viewer/**', use: { viewport: { width: 1100, height: 800 } } },
    { name: 'mobile', testIgnore: 'viewer/**', use: { viewport: { width: 800, height: 900 } } },
    // The static viewer's production build, made once per run (browser/viewer/build.setup.ts).
    { name: 'viewer-build', testMatch: 'viewer/build.setup.ts' },
    {
      name: 'viewer',
      testMatch: 'viewer/**/*.spec.ts',
      dependencies: ['viewer-build'],
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
})
