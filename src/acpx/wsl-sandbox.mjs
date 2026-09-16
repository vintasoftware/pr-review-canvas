// Run the shared backend with Linux Node, without importing Windows node_modules.
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const sandboxUrl = new URL('./sandbox.ts', import.meta.url)
// Preserve relative resource URLs when evaluating the stripped module from a data URL.
const source = stripTypeScriptTypes(
  readFileSync(sandboxUrl, 'utf8').replaceAll('import.meta.url', JSON.stringify(sandboxUrl.href))
)
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
