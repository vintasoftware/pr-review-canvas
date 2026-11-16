// A project's own copy of a prompt template starts with a line naming the bundled template it was
// made from: `<!-- pr-review-canvas 0.11.1 generation-format.md 3f9a0c2e1b7d -->`, the last part
// being the start of that bundled file's sha256. `pr-review upgrade` and `doctor` compare it with
// the installed bundled template, so any change to the template is caught, with or without a new
// token. pr-review prints the line for the user to paste and never writes it; loading a template
// drops it, so no prompt carries it.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { PROMPTS_DIR } from './paths.js'
import type { PromptOverrides } from './project-config.js'
import { isNewer } from './version.js'

type TemplateName = keyof PromptOverrides

const REPO_URL = 'https://github.com/vintasoftware/pr-review-canvas'
const BASE_LINE = /^<!-- pr-review-canvas (\S+) (\S+) (\S+) -->[ \t]*(?:\r?\n|$)/

/**
 * The bundled templates of 0.10.0, the last release before base lines. A copy without a line is
 * taken to be made from these: every copy made before the lines began dates from 0.10.0 or earlier.
 * Frozen history: `git show v0.10.0:prompts/<name> | sha256sum`.
 */
const LEGACY_VERSION = '0.10.0'
const AT_0_10_0: Partial<Record<TemplateName, string>> = {
  'chat-seed.md': 'c024ab6580a1',
  'generation-format.md': 'd4ec7c3bd815',
  'generation-strict-incremental.md': '162829348b7a',
  'generation-strict.md': 'a549aca0299b',
  'generation-surfacing-incremental.md': 'd14ace63156e',
  'generation-surfacing.md': '75870cca13e5',
  'judging-strict.md': '533a5cf93f8e',
  'judging-surfacing.md': 'f566cf480d31',
  'layering-guidance.md': '9701a68e05a2',
  'quality-standards.md': '81c4be2d5635',
}

export const TemplateNoticeSchema = z.object({
  /** The project's own template, as `pr-review.config.yml` names it. */
  file: z.string(),
  message: z.string(),
})
export type TemplateNotice = z.infer<typeof TemplateNoticeSchema>

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** The line a copy of this bundled template starts with. */
export function baseLine(template: TemplateName, version: string, bundled: string): string {
  return `<!-- pr-review-canvas ${version} ${template} ${hashOf(bundled)} -->`
}

/** The template without its base line. */
export function stripBaseLine(text: string): string {
  return text.replace(BASE_LINE, '')
}

/** The bundled template a copy was made from, by its line, or 0.10.0's when it has none. */
function baseOf(own: string, template: TemplateName): { version: string; hash: string } | null {
  const line = BASE_LINE.exec(own)
  if (line === null) {
    const hash = AT_0_10_0[template]
    return hash === undefined ? null : { version: LEGACY_VERSION, hash }
  }
  const [, version = '', named, hash = ''] = line
  return named === template ? { version, hash } : null
}

/**
 * What to tell the project about each of its own templates whose base is not the installed bundled
 * template. One it cannot read fails generation with its own error, so it is left to that.
 */
export async function templateNotices(
  repoRoot: string,
  overrides: PromptOverrides | undefined,
  version: string,
  dir = PROMPTS_DIR
): Promise<TemplateNotice[]> {
  const notices: TemplateNotice[] = []
  for (const [template, file] of Object.entries(overrides ?? {}) as Array<[TemplateName, string]>) {
    const own = await readFile(path.resolve(repoRoot, file), 'utf8').catch(() => null)
    if (own === null) continue
    const bundledPath = path.join(dir, template)
    const bundled = await readFile(bundledPath, 'utf8')
    const base = baseOf(own, template)
    if (base?.hash === hashOf(bundled)) continue
    const line = `make \`${baseLine(template, version, bundled)}\` its first line`
    let message: string
    if (base !== null && isNewer(version, base.version)) {
      message =
        `pr-review's ${template} changed after ${base.version}, the version this copy came from. ` +
        `Merge what you want from ${REPO_URL}/compare/v${base.version}...v${version}, then ${line}`
    } else if (base !== null && isNewer(base.version, version)) {
      message = `this copy came from pr-review ${base.version}, newer than this ${version}; run \`pr-review upgrade\``
    } else {
      message =
        `pr-review cannot tell which version of its ${template} this copy came from. ` +
        `Compare it with ${bundledPath}, then ${line}`
    }
    notices.push({ file, message: `${file}: ${message}` })
  }
  return notices
}
