/**
 * The length a reader sees. Caps measure this, so a long link target or a code fence does not eat
 * the budget: `[text](#hunk:a/very/long/path.ts#2)` counts as `text`, backticks and fence lines
 * count as nothing.
 */
export function visibleText(markdown: string): string {
  return markdown
    .replace(/^[ \t]*`{3,}[^\n]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
}

export function visibleLength(markdown: string): number {
  return visibleText(markdown).length
}
