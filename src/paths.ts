// Where this package's own files live. Its own module so that anything needing a path does not
// have to import the server context, which pulls in every adapter.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const PACKAGE_ROOT = path.resolve(here, '..')
export const STATIC_DIR = path.join(PACKAGE_ROOT, 'static')
export const PROMPTS_DIR = path.join(PACKAGE_ROOT, 'prompts')
