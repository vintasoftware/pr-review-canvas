// Repository pointers, dropped once per worker.
//
// The adapter drops them for every call it makes, but a test can reach git without the adapter:
// through a tool it shells out to, or through a helper written before this rule existed. The suite
// runs under the pre-commit hook, which in a linked worktree points these at the repository being
// committed to, so anything that misses the adapter would work on this repository instead of its
// own temporary one. Dropping them here leaves nothing to point at.
import { REPO_ENV_VARS } from './src/git/git.js'

for (const name of REPO_ENV_VARS) {
  delete process.env[name]
}

// Test-only shim for the happy-dom environment.
//
// DOMPurify 3.4.14 reads element names through a getter it copies from `Node.prototype` at import
// time, so an element cannot spoof its own `nodeName`. happy-dom defines `nodeName` on
// `Node.prototype` as a base getter that returns '' and overrides it on each subclass, so DOMPurify
// sees every element as nameless and strips it. Browsers put the real getter on `Node.prototype`,
// so only tests need this. The shim makes the base getter call the nearest subclass getter.
if (typeof Node !== 'undefined') {
  const base = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName')
  if (base?.get) {
    const baseGet = base.get
    Object.defineProperty(Node.prototype, 'nodeName', {
      configurable: true,
      get(this: Node) {
        let proto: object | null = Object.getPrototypeOf(this)
        while (proto !== null && proto !== Node.prototype) {
          const own = Object.getOwnPropertyDescriptor(proto, 'nodeName')
          if (own?.get) {
            return own.get.call(this)
          }
          proto = Object.getPrototypeOf(proto)
        }
        return baseGet.call(this)
      },
    })
  }
}
