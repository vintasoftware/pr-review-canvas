import { marked, Renderer, type Token } from 'marked'
import { linkLabel, parseLink } from '../contract/links.js'

/**
 * The length a reader sees. Caps measure this, so a long link target or a code fence does not eat
 * the budget: `[text](#hunk:a/very/long/path.ts#2)` counts as `text`, and backticks, asterisks
 * (`**bold**`, `*italic*`) and fence lines count as nothing.
 */
export function visibleText(markdown: string): string {
  return markdown
    .replace(/^[ \t]*`{3,}[^\n]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
}

export function visibleLength(markdown: string): number {
  return visibleText(markdown).length
}

/** Read a Background explanation once so its length and its canvas links use the same Markdown. */
export function backgroundProse(markdown: string): { text: string; links: string[] } {
  const links: string[] = []
  const renderer = new Renderer()
  const inline = ({ tokens }: { tokens: Token[] }): string => renderer.parser.parseInline(tokens)
  const literal = ({ text }: { text: string }): string => text

  renderer.paragraph = renderer.heading = renderer.strong = renderer.em = renderer.del = inline
  renderer.codespan = renderer.code = renderer.html = literal
  renderer.text = token => ('tokens' in token && token.tokens ? inline({ tokens: token.tokens }) : token.text)
  renderer.space = token => token.raw
  renderer.br = () => '\n'
  renderer.hr = renderer.checkbox = () => ''
  renderer.blockquote = ({ tokens }) => renderer.parser.parse(tokens)
  renderer.list = ({ items }) => items.map(item => renderer.parser.parse(item.tokens)).join('\n')
  renderer.table = ({ header, rows }) => [header, ...rows].map(row => row.map(inline).join('\t')).join('\n')
  renderer.image = ({ tokens }) => renderer.parser.parseInline(tokens, renderer.parser.textRenderer)
  renderer.link = token => {
    const label = inline(token)
    if (!token.href.startsWith('#')) return label
    links.push(token.href)
    const target = parseLink(token.href)
    return target && (label === '' || label === token.href) ? linkLabel(target) : label
  }
  return { text: marked.parse(markdown, { renderer, async: false }).trim(), links }
}
