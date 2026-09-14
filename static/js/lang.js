// @ts-check
// highlight.js language per file extension. The server stores the result in `files[].lang`
// (src/git/lang.ts re-exports this) and the browser uses it to pick the grammar.

/** @type {Record<string, string>} */
export const LANG_BY_EXT = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
}

/**
 * @param {string} path
 * @returns {string | undefined}
 */
export function langForPath(path) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path)
  if (!m || m[1] === undefined) {
    return undefined
  }
  return LANG_BY_EXT[m[1].toLowerCase()]
}
