import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: fileURLToPath(new URL('../site/vite.config.js', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, open: false },
})
let browser
try {
  await server.listen()
  browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 2,
  })
  const origin = server.resolvedUrls.local[0]
  await page.goto(`${origin}social-preview.html`)
  await page.locator('[data-layer="timers"][aria-pressed="true"]').waitFor()
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(image => image.decode()))
  })
  const output = fileURLToPath(new URL('../site/public/social-preview.png', import.meta.url))
  await page.screenshot({ path: output })
  console.log(`Rendered 2400 × 1260 social preview: ${output}`)
} finally {
  await browser?.close()
  await server.close()
}
