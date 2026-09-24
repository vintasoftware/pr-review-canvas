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
    // A card's sketch frame points at the server; the view tests check the markup, not the load.
    environmentOptions: { happyDOM: { settings: { disableIframePageLoading: true } } },
    include: ['src/**/*.test.ts', 'static/js/**/*.test.js'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/git/**/*.mjs', 'static/js/**/*.js'],
      exclude: [
        'src/cli.ts',
        'src/server/node-server.ts',
        'src/server/html.ts',
        // The two page boots: each fetches, wires the DOM, and animates; the browser specs cover them.
        'static/js/app.js',
        'static/js/deck.js',
        // The sketch frame's boot runs only inside the sandboxed frame; the deck spec covers it.
        'static/js/sketch-host.js',
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
