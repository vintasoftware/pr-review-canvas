import { marked, Renderer } from 'marked'

// The link parser lives in static/js/links.js so the browser can load it without a bundler;
// the server imports the same code here.

export type { LinkTargets, ParsedLink } from '../../static/js/links.js'
export { extractLinks, linkLabel, linkTargetId, parseLink, resolveLink } from '../../static/js/links.js'

/** Fragment destinations that Markdown renders as links, including reference links. */
export function markdownFragmentLinks(markdown: string): string[] {
  const links: string[] = []
  const renderer = new Renderer()
  renderer.link = ({ href }) => {
    if (href.startsWith('#')) links.push(href)
    return ''
  }
  marked.parse(markdown, { renderer, async: false })
  return links
}
