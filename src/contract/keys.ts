// One implementation for both sides: the browser loads static/js/keys.js as a module, and
// the server imports the same file through this re-export.
export {
  buildLineId,
  fileAnchorId,
  hunkAnchorId,
  hunkId,
  layerAnchorId,
  parseHunkId,
  parseLineId,
  pointAnchorId,
  reviewedId,
  sanitizeKey,
  uniqueKey,
} from '../../static/js/keys.js'
