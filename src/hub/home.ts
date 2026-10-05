// The shared server's own files, in `~/.pr-review/` (or `PR_REVIEW_HOME`): `server.json`, which
// tells a command where the running server is and how to talk to it, and `projects.json`, the
// checkouts it serves, so their URLs keep working after a restart. Neither holds review data;
// that stays in each clone's `.pr-review/`.
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  type Appearance,
  type AppearanceInput,
  DEFAULT_SKIN,
  DEFAULT_THEME,
  SKINS,
  THEMES,
} from '../contract/settings.js'
import { readJsonOrDefault, writeJsonAtomic, writeTextAtomic } from '../store/atomic-json.js'

export function hubHome(env: NodeJS.ProcessEnv): string {
  const override = env['PR_REVIEW_HOME']
  return override === undefined || override === ''
    ? path.join(os.homedir(), '.pr-review')
    : path.resolve(override)
}

const ServerInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  version: z.string(),
  /** What a command sends to register a project. The file is readable by its owner only. */
  token: z.string().min(1),
})
export type ServerInfo = z.infer<typeof ServerInfoSchema>

function serverFile(home: string): string {
  return path.join(home, 'server.json')
}

/** The running server's details as last written, or null when there is none or it is unreadable. */
export async function readServerInfo(home: string): Promise<ServerInfo | null> {
  return readJsonOrDefault(serverFile(home), ServerInfoSchema, () => null)
}

/** Written owner-only from the start: the token in it registers projects with the server. */
export async function writeServerInfo(home: string, info: ServerInfo): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeTextAtomic(serverFile(home), `${JSON.stringify(info, null, 2)}\n`, 0o600)
}

/** Removes the file if it still names `pid`, so a server that stops never removes a newer one's. */
export async function removeServerInfo(home: string, pid: number): Promise<void> {
  const current = await readServerInfo(home)
  if (current?.pid === pid) {
    await rm(serverFile(home), { force: true })
  }
}

const RegistrySchema = z.object({
  projects: z.array(z.object({ basePath: z.string(), repoRoot: z.string() })),
})
export type RegistryEntry = z.infer<typeof RegistrySchema>['projects'][number]

function registryFile(home: string): string {
  return path.join(home, 'projects.json')
}

/** The saved projects; an unreadable file reads as none, and the next registration rewrites it. */
export async function readRegistry(home: string): Promise<RegistryEntry[]> {
  return (await readJsonOrDefault(registryFile(home), RegistrySchema, () => ({ projects: [] }))).projects
}

export async function writeRegistry(home: string, projects: RegistryEntry[]): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeJsonAtomic(registryFile(home), { projects })
}

const AppearanceSchema = z.object({ skin: z.enum(SKINS), theme: z.enum(THEMES) })

function appearanceFile(home: string): string {
  return path.join(home, 'appearance.json')
}

/**
 * How the project list is painted. Each project keeps its own in its `.pr-review/settings.yml`;
 * this file is for the server's own page, and reads as the defaults when missing or unreadable.
 */
export async function readAppearance(home: string): Promise<Appearance> {
  return readJsonOrDefault(appearanceFile(home), AppearanceSchema, () => ({
    skin: DEFAULT_SKIN,
    theme: DEFAULT_THEME,
  }))
}

/** Saves the fields given over the saved ones, and returns the result. */
export async function writeAppearance(home: string, input: AppearanceInput): Promise<Appearance> {
  const saved = await readAppearance(home)
  const next: Appearance = { skin: input.skin ?? saved.skin, theme: input.theme ?? saved.theme }
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeJsonAtomic(appearanceFile(home), next)
  return next
}

/** True when a process with this id exists. Another user's process counts: it exists too. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
