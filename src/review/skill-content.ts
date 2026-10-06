import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import type { SkillState } from '../contract/generation.js'

/** Normalize checkout line endings so Git's CRLF conversion does not stale a copy. */
export function skillContent(text: string) {
  const normalized = text.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!match) throw new Error('SKILL.md is missing YAML frontmatter')
  const frontmatter = parseDocument(match[1]!)
  if (frontmatter.errors.length) throw new Error('SKILL.md has invalid YAML frontmatter')
  const body = normalized.slice(match[0].length)
  const hash = createHash('sha256').update(body).digest('hex')
  return { frontmatter, body, hash }
}

/** How a project copy compares with the shipped skill; see `SkillState`. */
export function skillState(copy: ReturnType<typeof skillContent>, shippedHash: string): SkillState {
  const stamp = copy.frontmatter.getIn(['metadata', 'body-sha256'])
  if (copy.hash === shippedHash && stamp === shippedHash) return 'current'
  return copy.hash === stamp ? 'outdated' : 'edited'
}

export function stampSkill(text: string): string {
  const { frontmatter, body, hash } = skillContent(text)
  frontmatter.setIn(['metadata', 'body-sha256'], hash)
  return `---\n${frontmatter.toString()}---\n${body}`
}
