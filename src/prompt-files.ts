import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PROMPTS_DIR } from './paths.js'
import type { PromptOverrides } from './project-config.js'

export interface ProjectPrompts {
  repoRoot: string
  overrides?: PromptOverrides | undefined
}

/** Explicit overrides must be readable; only omitted entries use bundled templates. */
export async function loadPromptFile(
  name: keyof PromptOverrides,
  dir = PROMPTS_DIR,
  project?: ProjectPrompts
): Promise<string> {
  const override = project?.overrides?.[name]
  const file =
    project !== undefined && override !== undefined
      ? path.resolve(project.repoRoot, override)
      : path.join(dir, name)
  try {
    return await readFile(file, 'utf8')
  } catch (cause) {
    throw new Error(`Cannot read prompt ${name} from ${file}`, { cause })
  }
}
