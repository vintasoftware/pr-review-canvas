// @vitest-environment node
// The shared server's process side: binding the port, advertising itself in `server.json` for the
// commands to find, and letting go of both when it stops.
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readServerInfo, type ServerInfo } from '../hub/home.js'
import { createHub, type Hub } from '../hub/hub.js'
import { makeTempDir } from '../testing/fakes.js'
import { type HubServer, startHubServer } from './node-server.js'

let home: string
let hub: Hub
let servers: HubServer[]
let logs: string[]

beforeEach(async () => {
  home = await makeTempDir('pr-review-node-server-')
  hub = await createHub({
    registry: null,
    load: async () => {
      throw new Error('no project is opened in these tests')
    },
    log: () => undefined,
  })
  servers = []
  logs = []
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers) {
    await server.close()
  }
  await rm(home, { recursive: true, force: true })
})

async function start(opts: { port?: number; advertise: boolean }): Promise<HubServer> {
  const server = await startHubServer({
    fetch: () => new Response('ok'),
    port: opts.port ?? 0,
    hub,
    home,
    advertise: opts.advertise,
    info: { version: '1.2.3', token: 'test-token' },
    log: line => logs.push(line),
  })
  servers.push(server)
  return server
}

describe('startHubServer', () => {
  it('advertises the port it bound in server.json, and takes the file back when it stops', async () => {
    const server = await start({ advertise: true })
    expect(server.port).toBeGreaterThan(0)
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('ok')
    expect(await readServerInfo(home)).toEqual({
      pid: process.pid,
      port: server.port,
      version: '1.2.3',
      token: 'test-token',
    })
    await server.close()
    expect(await readServerInfo(home)).toBeNull()
  })

  it('leaves the server.json of the server it runs next to as it is', async () => {
    const theirs: ServerInfo = { pid: 4242, port: 3010, version: '0.7.0', token: 'theirs' }
    const file = path.join(home, 'server.json')
    await writeFile(file, `${JSON.stringify(theirs)}\n`)
    const server = await start({ advertise: false })
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(theirs)}\n`)
    await server.close()
    expect(await readServerInfo(home)).toEqual(theirs)
  })

  it('rejects when another program holds the port, and advertises nothing', async () => {
    const first = await start({ advertise: false })
    await expect(start({ port: first.port, advertise: true })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(await readServerInfo(home)).toBeNull()
  })

  it('closes once, stopping the sweeps and letting go of the signals', async () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
    const stopped = vi.spyOn(hub, 'close')
    const server = await start({ advertise: true })
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1)
    await server.close()
    await server.close()
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(process.listenerCount('SIGINT')).toBe(before.int)
    expect(process.listenerCount('SIGTERM')).toBe(before.term)
  })

  it('stops on SIGTERM: it closes, says so, and exits cleanly', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await start({ advertise: true })
    process.emit('SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(logs).toEqual(['stopped'])
    expect(await readServerInfo(home)).toBeNull()
  })
})
