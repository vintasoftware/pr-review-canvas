// Where `serve` is listening, kept in the data dir while it runs, so a command run beside it
// (publish, tour preview) prints a link to that server and not to the default port.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { AppContext } from './context.js'
import { readJson, writeJsonAtomic } from '../store/atomic-json.js'

export const SERVER_FILE = 'server.json'

const ServerFileSchema = z.object({ port: z.number().int().positive(), pid: z.number().int().positive() })

/** True while a process with this id runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it runs, as another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function writeServerFile(dataDir: string, port: number): Promise<void> {
  await writeJsonAtomic(path.join(dataDir, SERVER_FILE), { port, pid: process.pid })
}

/** Removes the record, unless another server has written its own since. */
export async function removeServerFile(dataDir: string): Promise<void> {
  const file = path.join(dataDir, SERVER_FILE)
  const found = await readJson(file, ServerFileSchema).catch(() => null)
  if (found?.pid === process.pid) {
    await rm(file, { force: true })
  }
}

/** The port of the server running on this data dir, else the configured one. */
export async function servedPort(ctx: Pick<AppContext, 'config'>): Promise<number> {
  const found = await readJson(path.join(ctx.config.dataDir, SERVER_FILE), ServerFileSchema).catch(() => null)
  return found !== null && alive(found.pid) ? found.port : ctx.config.port
}

/** A page of the running server, such as `/tour/42`. */
export async function localUrl(ctx: Pick<AppContext, 'config'>, page: string): Promise<string> {
  return `http://localhost:${await servedPort(ctx)}${page}`
}
