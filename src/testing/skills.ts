// The bundled skills as `install-skill` writes them, for tests that fake a repository's copies:
// every SKILL.md stamped, every file beside one as it ships.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { listBundledSkills, skillSourceDir } from '../review/install-skill.js'
import { stampSkill } from '../review/skill-content.js'

/** `<skill>/<file>` → the text an installed copy holds. */
export async function bundledSkillFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const name of await listBundledSkills()) {
    const dir = skillSourceDir(name)
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const rel = path.relative(dir, path.join(entry.parentPath, entry.name))
      const text = await readFile(path.join(dir, rel), 'utf8')
      files.set(`${name}/${rel}`, rel === 'SKILL.md' ? stampSkill(text) : text)
    }
  }
  return files
}

/**
 * A `readSkill` that answers for every bundled skill under `skillsDirs`, as if `install-skill`
 * had written them there, and null elsewhere.
 */
export async function installedSkillReader(
  skillsDirs: readonly string[]
): Promise<(file: string) => Promise<string | null>> {
  const files = await bundledSkillFiles()
  return async file => {
    for (const dir of skillsDirs) {
      if (!file.startsWith(`${dir}${path.sep}`)) continue
      const text = files.get(path.relative(dir, file))
      return text ?? null
    }
    return null
  }
}
