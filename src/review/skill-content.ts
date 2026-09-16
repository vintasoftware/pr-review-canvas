import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'

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

export function stampSkill(text: string): string {
  const { frontmatter, body, hash } = skillContent(text)
  frontmatter.setIn(['metadata', 'body-sha256'], hash)
  return `---\n${frontmatter.toString()}---\n${body}`
}
