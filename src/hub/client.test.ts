// @vitest-environment node
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { rm } from 'node:fs/promises'
import { AppError } from '../server/errors.js'
import { makeTempDir } from '../testing/fakes.js'
import { findServer, originOf, registerProject, runningPort } from './client.js'
import { type ServerInfo, writeServerInfo } from './home.js'

interface Seen {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  body: string
}

type Answer = (req: IncomingMessage, res: ServerResponse) => void

let home: string
let server: Server | undefined
let seen: Seen[]

async function listen(answer: Answer): Promise<number> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      })
      answer(req, res)
    })
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function json(status: number, value: unknown): Answer {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
}

function text(status: number, body: string): Answer {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end(body)
  }
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise(resolve => child.once('exit', resolve))
  return child.pid as number
}

function infoFor(port: number, pid = process.pid): ServerInfo {
  return { pid, port, version: '1.0.0', token: 'tok' }
}

beforeEach(async () => {
  home = await makeTempDir()
  seen = []
})
afterEach(async () => {
  const s = server
  server = undefined
  if (s !== undefined) await new Promise(resolve => s.close(resolve))
  await rm(home, { recursive: true, force: true })
})

it('originOf names localhost and the port', () => {
  expect(originOf(4321)).toBe('http://localhost:4321')
})

describe('findServer', () => {
  it('is null without server.json', async () => {
    expect(await findServer(home)).toBeNull()
  })

  it('is null when the process is gone, without calling the server', async () => {
    const port = await listen(json(200, { version: '2.0.0', pid: process.pid, port: 1 }))
    await writeServerInfo(home, infoFor(port, await exitedPid()))
    expect(await findServer(home)).toBeNull()
    expect(seen).toEqual([])
  })

  it('returns the server, with the version it answers and its origin', async () => {
    const port = await listen(json(200, { version: '2.0.0', pid: process.pid, port: 1 }))
    await writeServerInfo(home, infoFor(port))
    expect(await findServer(home)).toEqual({
      ...infoFor(port),
      version: '2.0.0',
      origin: `http://localhost:${port}`,
    })
    expect(seen).toEqual([
      expect.objectContaining({ method: 'GET', url: '/api/hub', authorization: 'Bearer tok' }),
    ])
  })

  it('is null when the server answers with another pid', async () => {
    const port = await listen(json(200, { version: '2.0.0', pid: process.pid + 1, port: 1 }))
    await writeServerInfo(home, infoFor(port))
    expect(await findServer(home)).toBeNull()
  })

  it.each([
    ['an error', json(401, { error: { code: 'UNAUTHORIZED', message: 'no' } })],
    ['garbage', text(200, 'not json')],
    ['an error without a body', text(502, 'bad gateway')],
  ])('is null when the server answers %s', async (_name, answer) => {
    const port = await listen(answer)
    await writeServerInfo(home, infoFor(port))
    expect(await findServer(home)).toBeNull()
  })

  it('is null when nothing listens on the port', async () => {
    const port = await listen(text(200, ''))
    await new Promise(resolve => server?.close(resolve))
    server = undefined
    await writeServerInfo(home, infoFor(port))
    expect(await findServer(home)).toBeNull()
  })
})

describe('runningPort', () => {
  it('is undefined without server.json', async () => {
    expect(await runningPort(home)).toBeUndefined()
  })

  it('is the port when the process runs, without a request', async () => {
    await writeServerInfo(home, infoFor(4567))
    expect(await runningPort(home)).toBe(4567)
  })

  it('is undefined when the process is gone', async () => {
    await writeServerInfo(home, infoFor(4567, await exitedPid()))
    expect(await runningPort(home)).toBeUndefined()
  })
})

describe('registerProject', () => {
  const input = { repoRoot: '/src/widgets', env: { HOME: '/home/me' }, flags: { chatAgent: 'claude' } }

  it('posts the input with the token and returns the answer', async () => {
    const answer = { name: 'acme/widgets', basePath: '/r/acme/widgets/', kept: false }
    const port = await listen(json(200, answer))
    expect(await registerProject(infoFor(port), input)).toEqual(answer)
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/api/hub/projects',
        authorization: 'Bearer tok',
        contentType: 'application/json',
        body: JSON.stringify(input),
      },
    ])
  })

  it('throws the error envelope as an AppError', async () => {
    const port = await listen(
      json(400, { error: { code: 'NOT_A_REPO', message: 'not a repo', hint: 'pass a clone' } })
    )
    const err = await registerProject(infoFor(port), input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({
      code: 'NOT_A_REPO',
      message: 'not a repo',
      hint: 'pass a clone',
      status: 400,
    })
  })

  it('throws INTERNAL when a success carries no JSON', async () => {
    const port = await listen(text(200, 'ok'))
    const err = await registerProject(infoFor(port), input).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'INTERNAL', message: 'the server answered 200 with no JSON' })
  })

  it('throws INTERNAL with the status when the error is not JSON', async () => {
    const port = await listen(text(503, 'down'))
    const err = await registerProject(infoFor(port), input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'INTERNAL', message: 'the server answered 503', hint: undefined })
  })
})
