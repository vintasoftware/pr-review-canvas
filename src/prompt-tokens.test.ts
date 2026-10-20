// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT, PROMPTS_DIR } from './paths.js'
import type { PromptOverrides } from './project-config.js'
import { ADDED_TOKENS } from './prompt-tokens.js'
import { isNewer } from './version.js'

/**
 * The tokens each bundled template had at 0.9.0, before `ADDED_TOKENS` began, or when it first
 * shipped, for a template new since: no copy of it predates those. Frozen history.
 */
const AT_0_9_0: Record<keyof PromptOverrides, readonly string[]> = {
  'chat-seed.md': ['CODE_LOCATION', 'LAYERS', 'POINTS', 'PR_META', 'READER', 'TESTS'],
  'generation-format.md': [
    'BODY',
    'CAPS',
    'CONFIGURED_LAYERS',
    'DIFFS',
    'HEAD_SHA',
    'HIGH_RISK',
    'LARGE_PR',
    'LAYERING_GUIDANCE',
    'MANIFEST',
    'MAX_DIAGRAM_LINKS',
    'MAX_DIAGRAMS',
    'MAX_POINTS',
    'MAX_REPAIR_ROUNDS',
    'MERGE_BASE_SHA',
    'META',
    'MODEL_PATH',
    'PATHS',
    'SCHEMA',
    'SMALL_PR',
    'TARGET_WORD',
    'TEST_PATTERNS',
  ],
  'generation-strict-incremental.md': [
    'BASIS',
    'CARRIED',
    'FILE_DELTA',
    'JUDGING',
    'RE_JUDGED',
    'TARGET_WORD',
  ],
  'generation-strict.md': ['JUDGING', 'TARGET_WORD'],
  'generation-surfacing-incremental.md': [
    'BASIS',
    'CARRIED',
    'FILE_DELTA',
    'JUDGING',
    'RE_JUDGED',
    'TARGET_WORD',
  ],
  'generation-surfacing.md': ['JUDGING', 'TARGET_WORD'],
  'judging-strict.md': ['FORMAT', 'QUALITY_STANDARDS', 'RULEBOOK'],
  'judging-surfacing.md': ['FORMAT', 'QUALITY_STANDARDS', 'RULEBOOK'],
  'layering-guidance.md': [],
  'quality-standards.md': [],
  'tour.md': [
    'BASIS',
    'BODY',
    'BUDGET',
    'CAPS',
    'CATEGORIES',
    'DIFFS',
    'GUIDE',
    'HEAD_SHA',
    'MANIFEST',
    'MAX_REPAIR_ROUNDS',
    'MERGE_BASE_SHA',
    'META',
    'MICRO_WORLD',
    'PATHS',
    'SCENE_GUIDE',
    'SCHEMA',
    'TARGET_WORD',
    'TEST_PATTERNS',
    'TRY_IT',
  ],
  'tour-grill.md': ['CODE_LOCATION', 'DECISIONS', 'GUIDE', 'LANDMARKS', 'PR_META'],
  'tour-chat.md': ['CODE_LOCATION', 'DECISIONS', 'GUIDE', 'LANDMARKS', 'PR_META'],
}

const templates = Object.keys(AT_0_9_0) as Array<keyof PromptOverrides>

async function tokensOf(template: keyof PromptOverrides): Promise<Set<string>> {
  const text = await readFile(path.join(PROMPTS_DIR, template), 'utf8')
  return new Set(Array.from(text.matchAll(/\{\{([A-Z_]+)\}\}/g), m => m[1]!))
}

describe('ADDED_TOKENS', () => {
  it.each(templates)('lists every token %s gained since 0.9.0, and none it does not have', async template => {
    const tokens = await tokensOf(template)
    const added = ADDED_TOKENS.filter(t => t.template === template).map(t => t.token)
    expect([...tokens].filter(t => !AT_0_9_0[template].includes(t))).toEqual(added)
  })

  it('stamps each token with a version no newer than a release that ships it', async () => {
    const changelog = await readFile(path.join(PACKAGE_ROOT, 'CHANGELOG.md'), 'utf8')
    const top = /^## (.+)$/m.exec(changelog)?.[1]
    // Before a release, the next version is not known yet; the release commit names it.
    if (top === 'Unreleased') return
    const { version } = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version: string
    }
    for (const entry of ADDED_TOKENS) {
      expect(isNewer(entry.since, version), `${entry.token} is stamped ${entry.since}`).toBe(false)
      expect(isNewer(entry.since, '0.9.0'), `${entry.token} is stamped ${entry.since}`).toBe(true)
    }
  })
})
