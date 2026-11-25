import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const appRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // The browser gets these names from the import map in the page shell (see src/server/html.ts).
      hljs: path.resolve(appRoot, 'node_modules/@highlightjs/cdn-assets/es/highlight.min.js'),
    },
  },
  test: {
    name: 'pr-review',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'static/js/**/*.test.js', 'viewer/**/*.test.ts', 'worker/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Half the cores, so a run (the pre-commit hook runs one on every commit) leaves the machine
    // usable. `--maxWorkers` on the command line overrides it.
    maxWorkers: '50%',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/git/**/*.mjs', 'static/js/**/*.js', 'viewer/**/*.ts', 'worker/**/*.ts'],
      exclude: [
        'src/cli.ts',
        // The viewer's entry and build shims, run by the Playwright specs in browser/viewer/.
        'viewer/main.ts',
        'viewer/node-stub.ts',
        'viewer/zod-config.ts',
        'viewer/**/*.d.ts',
        'viewer/**/*.test.ts',
        'worker/**/*.test.ts',
        'src/server/html.ts',
        'static/js/app.js',
        'static/vendor/**',
        'src/**/*.test.ts',
        'static/js/**/*.test.js',
        'static/js/**/*.d.ts',
        'src/**/*.d.ts',
      ],
      reporter: ['text', 'json', 'json-summary'],
      thresholds: {
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
    },
  },
})
