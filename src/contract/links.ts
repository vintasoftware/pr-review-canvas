// The link parser lives in static/js/links.js so the browser can load it without a bundler;
// the server imports the same code here.

export type { LinkTargets, ParsedLink } from '../../static/js/links.js'
export { extractLinks, linkLabel, linkTargetId, parseLink, resolveLink } from '../../static/js/links.js'
