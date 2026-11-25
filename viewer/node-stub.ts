// src/host/client.ts runs gh and glab with execFile. The viewer reaches GitHub with fetch and never
// calls it, so the browser build gets this stand-in.
export function execFile(): never {
  throw new Error('the viewer runs no commands')
}
