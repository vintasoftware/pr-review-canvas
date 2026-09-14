// @vitest-environment node
import { hostnameOf, isAllowedHost, isSameOrigin } from './security.js'

describe('security helpers', () => {
  it('extracts hostnames from Host headers', () => {
    expect(hostnameOf('localhost:3010')).toBe('localhost')
    expect(hostnameOf('LOCALHOST')).toBe('localhost')
    expect(hostnameOf('[::1]:3010')).toBe('[::1]')
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1')
    expect(hostnameOf('')).toBe('')
  })

  it('allows only loopback names', () => {
    expect(isAllowedHost('localhost:3010')).toBe(true)
    expect(isAllowedHost('127.0.0.1:3010')).toBe(true)
    expect(isAllowedHost('[::1]:3010')).toBe(true)
    expect(isAllowedHost('evil')).toBe(false)
    expect(isAllowedHost('localhost.evil.com')).toBe(false)
    expect(isAllowedHost(undefined)).toBe(false)
  })

  it('accepts a missing Origin and one that names this server', () => {
    expect(isSameOrigin(undefined, 'localhost:3010')).toBe(true)
    expect(isSameOrigin('http://localhost:3010', 'localhost:3010')).toBe(true)
    expect(isSameOrigin('http://LOCALHOST:3010', 'localhost:3010')).toBe(true)
    expect(isSameOrigin('http://localhost:3011', 'localhost:3010')).toBe(false)
    expect(isSameOrigin('https://evil.example', 'localhost:3010')).toBe(false)
    expect(isSameOrigin('null', 'localhost:3010')).toBe(false)
  })
})
