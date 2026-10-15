// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { localUrl, removeServerFile, SERVER_FILE, servedPort, writeServerFile } from './server-file.js'

async function dataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'pr-review-server-file-'))
}

describe('the served port', () => {
  it('links to the running server, and to the configured port without one', async () => {
    const dir = await dataDir()
    const ctx = { config: { dataDir: dir, port: 3010 } } as Parameters<typeof servedPort>[0]
    expect(await servedPort(ctx)).toBe(3010)
    await writeServerFile(dir, 3044)
    expect(await localUrl(ctx, '/tour/67')).toBe('http://localhost:3044/tour/67')
    await removeServerFile(dir)
    expect(await servedPort(ctx)).toBe(3010)
  })

  it('ignores a record left by a server that is gone, and keeps one another server wrote', async () => {
    const dir = await dataDir()
    const ctx = { config: { dataDir: dir, port: 3010 } } as Parameters<typeof servedPort>[0]
    // No process has this id: the server that wrote it is gone.
    await writeFile(path.join(dir, SERVER_FILE), JSON.stringify({ port: 4000, pid: 2 ** 22 + 7 }))
    expect(await servedPort(ctx)).toBe(3010)
    // Another server's record stays when this one stops.
    await writeFile(path.join(dir, SERVER_FILE), JSON.stringify({ port: 4001, pid: process.pid + 1 }))
    await removeServerFile(dir)
    expect(JSON.parse(await readFile(path.join(dir, SERVER_FILE), 'utf8')).port).toBe(4001)
    // A record that is not one is read as none.
    await writeFile(path.join(dir, SERVER_FILE), 'not json')
    expect(await servedPort(ctx)).toBe(3010)
  })
})
