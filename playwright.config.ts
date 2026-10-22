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
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 1100, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 800, height: 900 } } },
  ],
})
