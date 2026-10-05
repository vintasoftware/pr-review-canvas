// The shared server: one process serves every checkout the user opens, each under its own base
// path (see slug.ts) with an AppContext of its own, so a project's pages, chat, and generation
// behave as they did when each had a server. Contexts are built when a command registers the
// checkout, or on the first request after a restart, from the saved project list.
//
// The worktrees of one clone share its `.pr-review/` data dir: canvases, threads, and the review
// checkouts. Their contexts are siblings, and a chat turn or a generation in one keeps the others
// from starting one that would write the same files.
import { stat } from 'node:fs/promises'
import type { Hono } from 'hono'
import { type CheckoutSweeper, startCheckoutSweep } from '../chat/checkout-sweep.js'
import { keyLabel, type ReviewKey } from '../contract/review-key.js'
import type { GenerationManager } from '../generate/generation-manager.js'
import { createApp } from '../server/app.js'
import { AppError } from '../server/errors.js'
import { oneAtATime } from '../server/one-at-a-time.js'
import type { AppContext } from '../server/context.js'
import type { AppEnv } from '../server/env.js'
import { createContextGeneration } from '../server/routes/generate-routes.js'
import { type RegistryEntry, readRegistry, writeRegistry } from './home.js'
import { projectName } from './slug.js'

export { projectName }

/** The per-project flags of `serve` and `open`, applied when the server builds the project. */
export interface ProjectFlags {
  dataDir?: string | undefined
  fixtureCanvas?: string | undefined
  chatAgent?: string | undefined
  chatModel?: string | undefined
}

export interface ProjectRegistration {
  /** The checkout's top-level folder. */
  repoRoot: string
  /**
   * The environment of the shell that opened the project, kept in memory only. A project built
   * from the saved list after a restart runs under the server's own until it is opened again.
   */
  env?: NodeJS.ProcessEnv | undefined
  flags?: ProjectFlags | undefined
}

/** What the server hands a context it builds: the sibling check, and a log that names the project. */
export interface ProjectHooks {
  chatBusyElsewhere: (key: ReviewKey) => boolean
  log: (line: string) => void
}

/** Builds the context of one checkout. Tests pass their own. */
export type LoadProject = (registration: ProjectRegistration, hooks: ProjectHooks) => Promise<AppContext>

export interface Project {
  /** `owner/repo` or `owner/repo~worktree`, for log lines and the project list. */
  name: string
  ctx: AppContext
  app: Hono<AppEnv>
  generation: GenerationManager
}

export type Resolved =
  | { kind: 'project'; project: Project; rest: string }
  /** The base path without its trailing slash: relative links on the page need the slash. */
  | { kind: 'redirect'; location: string }

export interface Hub {
  /**
   * Builds the checkout's project and serves it from now on. A project already served at that
   * path is replaced, which also reloads its config, unless it has a chat turn or a generation
   * running: then it stays as it is, and `kept` says so.
   */
  register(registration: ProjectRegistration): Promise<{ project: Project; kept: boolean }>
  /** The project a request path falls under, built now if this is its first request. */
  resolve(pathname: string): Promise<Resolved | null>
  /** Every saved project, built or not, after dropping those whose folder is gone. */
  projects(): Promise<RegistryEntry[]>
  /**
   * Stops serving a saved project and takes it off the list. Its canvases and review state stay
   * in its data dir, and `pr-review open` adds it again. False when no project has that path;
   * refused while the project runs a chat turn or a generation.
   */
  remove(basePath: string): Promise<boolean>
  /** The chat turns and generations running now, one line each, to warn before stopping. */
  running(): string[]
  close(): void
}

export interface HubOptions {
  home: string
  load: LoadProject
  log: (line: string) => void
}

interface Slot {
  entry: RegistryEntry
  built: Promise<Project> | null
}

function isBusy(project: Project): boolean {
  return project.generation.running() !== null || project.ctx.chat.running().length > 0
}

/** True when the folder no longer exists: a deleted worktree, a clone moved elsewhere. */
async function folderGone(dir: string): Promise<boolean> {
  try {
    await stat(dir)
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

export async function createHub(opts: HubOptions): Promise<Hub> {
  const slots = new Map<string, Slot>()
  for (const entry of await readRegistry(opts.home)) {
    slots.set(entry.basePath, { entry, built: null })
  }
  /** Only built projects can be running anything; a saved one that was never opened is idle. */
  const built = new Set<Project>()
  const sweepers = new Map<string, CheckoutSweeper>()

  const siblings = (self: Project): Project[] =>
    [...built].filter(p => p !== self && p.ctx.config.dataDir === self.ctx.config.dataDir)

  const build = async (registration: ProjectRegistration): Promise<Project> => {
    let self: Project | null = null
    const ctx = await opts.load(registration, {
      chatBusyElsewhere: key => self !== null && siblings(self).some(p => p.ctx.chat.running().includes(key)),
      log: line => opts.log(self === null ? line : `[${self.name}] ${line}`),
    })
    const generation = createContextGeneration(ctx, () =>
      self === null
        ? null
        : (siblings(self)
            .map(p => p.generation.running())
            .find(key => key !== null) ?? null)
    )
    const project: Project = {
      name: projectName(ctx.config.basePath),
      ctx,
      app: createApp(ctx, generation),
      generation,
    }
    self = project
    return project
  }

  /** Starts serving a built project: the sibling checks see it, and its clone gets a sweeper. */
  const adopt = (project: Project, replaced: Project | null): void => {
    if (replaced !== null) {
      built.delete(replaced)
    }
    built.add(project)
    const { ctx } = project
    const { dataDir } = ctx.config
    ctx.log(`${ctx.config.repoRoot} · data dir ${dataDir}`)
    if (ctx.fixtureArtifact !== null) {
      ctx.log(`fixture canvas ${ctx.config.fixtureCanvasPath ?? ''} (dev only): every PR reports ready`)
    }
    for (const w of ctx.projectConfig.warnings) {
      ctx.log(`warning: ${w}`)
    }
    // Worktrees of one clone share the review checkouts, so one sweep covers them all.
    if (!sweepers.has(dataDir)) {
      sweepers.set(
        dataDir,
        startCheckoutSweep({
          checkouts: project.ctx.checkouts,
          readSettings: () => project.ctx.settings.read(),
          log: project.ctx.log,
        })
      )
    }
  }

  const registerNow = async (
    registration: ProjectRegistration
  ): Promise<{ project: Project; kept: boolean }> => {
    const project = await build(registration)
    const { basePath, repoRoot } = project.ctx.config
    const slot = slots.get(basePath)
    const current = slot?.built === null || slot === undefined ? null : await slot.built.catch(() => null)
    if (current !== null && isBusy(current)) {
      // Two worktree folders of one name share a path. While the other one works, this one
      // cannot take the path, and opening it would show the other checkout.
      if (current.ctx.config.repoRoot !== repoRoot) {
        throw new AppError(
          'BAD_REQUEST',
          `${basePath} serves ${current.ctx.config.repoRoot}, which has a chat turn or a generation running`,
          409,
          'try again when it ends, or rename one of the two worktree folders'
        )
      }
      return { project: current, kept: true }
    }
    if (slot !== undefined && slot.entry.repoRoot !== repoRoot) {
      opts.log(`${project.name} now serves ${repoRoot}, in place of ${slot.entry.repoRoot}`)
    }
    slots.set(basePath, { entry: { basePath, repoRoot }, built: Promise.resolve(project) })
    adopt(project, current)
    await save()
    return { project, kept: false }
  }

  const save = (): Promise<void> =>
    writeRegistry(
      opts.home,
      [...slots.values()].map(slot => slot.entry)
    )

  /** Takes a project off the list and out of the sibling checks; the caller saves the list. */
  const drop = async (slot: Slot): Promise<void> => {
    const project = slot.built === null ? null : await slot.built.catch(() => null)
    if (project !== null && isBusy(project)) {
      throw new AppError(
        'BAD_REQUEST',
        `${project.name} has a chat turn or a generation running`,
        409,
        'remove it once that ends'
      )
    }
    slots.delete(slot.entry.basePath)
    if (project === null) {
      return
    }
    built.delete(project)
    const { dataDir } = project.ctx.config
    if (![...built].some(p => p.ctx.config.dataDir === dataDir)) {
      sweepers.get(dataDir)?.stop()
      sweepers.delete(dataDir)
    }
  }

  /** Drops the idle projects whose folder is gone. A project still working keeps its place. */
  const prune = async (): Promise<void> => {
    let dropped = false
    for (const slot of [...slots.values()]) {
      if (!(await folderGone(slot.entry.repoRoot))) {
        continue
      }
      const removed = await drop(slot).then(
        () => true,
        () => false
      )
      if (removed) {
        opts.log(`removed ${projectName(slot.entry.basePath)}: ${slot.entry.repoRoot} no longer exists`)
        dropped = true
      }
    }
    if (dropped) {
      await save()
    }
  }

  // One change to the list at a time: two registrations at once for one path would both replace
  // the same project, and the one that lost would stay counted as a sibling.
  const inTurn = oneAtATime<'projects'>()
  await prune()

  return {
    register: registration => inTurn('projects', () => registerNow(registration)),

    async resolve(pathname) {
      let match: Slot | null = null
      for (const slot of slots.values()) {
        const base = slot.entry.basePath
        if (pathname === base.slice(0, -1)) {
          return { kind: 'redirect', location: base }
        }
        // The longest base wins: a GitLab group can hold a project and a subgroup of one name.
        if (pathname.startsWith(base) && (match === null || base.length > match.entry.basePath.length)) {
          match = slot
        }
      }
      if (match === null) {
        return null
      }
      const slot = match
      // A saved project whose folder is gone leaves the list on its first request.
      if (slot.built === null && (await folderGone(slot.entry.repoRoot))) {
        await inTurn('projects', prune)
        return null
      }
      if (slot.built === null) {
        slot.built = build({ repoRoot: slot.entry.repoRoot }).then(project => {
          adopt(project, null)
          return project
        })
        // A checkout that moved or went away fails here; the next request tries again.
        slot.built.catch(() => {
          slot.built = null
        })
      }
      const project = await slot.built
      return { kind: 'project', project, rest: `/${pathname.slice(slot.entry.basePath.length)}` }
    },

    async projects() {
      await inTurn('projects', prune)
      return [...slots.values()].map(slot => slot.entry)
    },

    remove: basePath =>
      inTurn('projects', async () => {
        const slot = slots.get(basePath)
        if (slot === undefined) {
          return false
        }
        await drop(slot)
        await save()
        opts.log(`removed ${projectName(basePath)}`)
        return true
      }),

    running() {
      const lines: string[] = []
      for (const project of built) {
        const generating = project.generation.running()
        if (generating !== null) {
          lines.push(`${project.name}: generating a canvas for ${keyLabel(generating)}`)
        }
        for (const key of project.ctx.chat.running()) {
          lines.push(`${project.name}: a chat turn on ${keyLabel(key)}`)
        }
      }
      return lines
    },

    close() {
      for (const sweeper of sweepers.values()) {
        sweeper.stop()
      }
      sweepers.clear()
    },
  }
}
