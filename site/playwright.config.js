import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: true,
  use: {
    baseURL: 'http://127.0.0.1:4173/pr-review-canvas/',
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { viewport: { width: 900, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'corepack pnpm site:build && corepack pnpm site:preview',
    cwd: new URL('..', import.meta.url).pathname,
    url: 'http://127.0.0.1:4173/pr-review-canvas/',
    reuseExistingServer: false,
  },
})
