// Tests and their child processes must not inherit the hook's repository pointers.
import { REPO_ENV_VARS } from './src/git/environment.mjs'

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
