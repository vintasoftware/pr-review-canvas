import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))
const brand = fileURLToPath(new URL('../static/brand.svg', import.meta.url))

/** The header links `/static/brand.svg`, which the local server serves; the viewer ships it too. */
function brandIcon() {
  return {
    name: 'viewer-brand-icon',
    configureServer(server) {
      server.middlewares.use('/static/brand.svg', (_req, res) => {
        res.setHeader('content-type', 'image/svg+xml')
        res.end(readFileSync(brand))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'static/brand.svg', source: readFileSync(brand) })
    },
  }
}

export default defineConfig({
  root: here,
  base: '/',
  plugins: [brandIcon()],
  resolve: {
    alias: {
      // The local server's import map names this file `hljs`.
      hljs: '@highlightjs/cdn-assets/es/highlight.min.js',
      'node:child_process': fileURLToPath(new URL('./node-stub.ts', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist-viewer',
    emptyOutDir: true,
  },
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
})
