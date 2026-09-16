// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadSeedTemplate } from './chat/seed.js'
import { loadPromptSources } from './review/prompt.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'project-prompts-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('overrides all generation sources individually, with bundled fallback for omitted entries', async () => {
  await writeFile(path.join(root, 'custom.md'), 'custom')
  const bundled = await loadPromptSources()
  for (const [name, select] of [
    ['generation-format.md', (s: typeof bundled) => s.format],
    ['generation-strict.md', (s: typeof bundled) => s.generation.strict],
    ['generation-surfacing.md', (s: typeof bundled) => s.generation.surfacing],
    ['layering-guidance.md', (s: typeof bundled) => s.layeringGuidance],
    ['quality-standards.md', (s: typeof bundled) => s.qualityStandards],
  ] as const) {
    const result = await loadPromptSources(undefined, { repoRoot: root, overrides: { [name]: 'custom.md' } })
    expect(select(result)).toBe('custom')
    if (name !== 'generation-format.md') expect(result.format).toBe(bundled.format)
  }
})

it('loads chat overrides relative to the repository or from an absolute path', async () => {
  await writeFile(path.join(root, 'chat.md'), 'Project chat {{PR_META}}')
  for (const file of ['chat.md', path.join(root, 'chat.md')]) {
    expect(await loadSeedTemplate(undefined, { repoRoot: root, overrides: { 'chat-seed.md': file } })).toBe(
      'Project chat {{PR_META}}'
    )
  }
})

it('fails with the configured path when an override is missing or unreadable', async () => {
  for (const file of ['missing.md', '.']) {
    await expect(
      loadSeedTemplate(undefined, { repoRoot: root, overrides: { 'chat-seed.md': file } })
    ).rejects.toThrow(`Cannot read prompt chat-seed.md from ${path.resolve(root, file)}`)
  }
})
