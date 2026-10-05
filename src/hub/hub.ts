// The shared server: one process serves every checkout the user opens, each under its own base
// path (see slug.ts) with an AppContext of its own, so a project's pages, chat, and generation
// behave as they did when each had a server. A project is built when a command registers the
// checkout, or, after a restart, on its first request, from the saved list and through the same
// registration.
//
// The worktrees of one clone share its `.pr-review/` data dir: canvases, threads, and the review
// checkouts. Their contexts share one part per clone (see CloneShared), so a chat turn or a
// generation in one keeps the others from starting one over the same files, and one sweep keeps
// the clone's review checkouts.
import { stat } from 'node:fs/promises'
import type { Hono } from 'hono'
import { type CheckoutSweeper, startCheckoutSweep } from '../chat/checkout-sweep.js'
import type { RuntimeConfig } from '../config.js'
import type { ProjectFlags } from '../load-context.js'
import { createApp } from '../server/app.js'
import { type AppContext, type CloneShared, createCloneShared } from '../server/context.js'
import type { AppEnv } from '../server/env.js'
import { AppError } from '../server/errors.js'
import { oneAtATime } from '../server/one-at-a-time.js'
import { repoDir } from '../store/data-dir.js'
import { createSettingsStore } from '../store/settings-store.js'
import { type RegistryEntry, readRegistry, writeRegistry } from './home.js'
import { basePathOf } from './slug.js'

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

/** What the server hands a context it builds: a log that names the project, and its clone's part. */
export interface ProjectHooks {
  log: (line: string) => void
  cloneOf: (config: RuntimeConfig) => CloneShared
}

/** Builds the context of one checkout. Tests pass their own. */
export type LoadProject = (registration: ProjectRegistration, hooks: ProjectHooks) => Promise<AppContext>

export interface Project {
  ctx: AppContext
  app: Hono<AppEnv>
}

export type Resolved =
  | { kind: 'project'; project: Project; rest: string }
  /**
   * The base path without its trailing slash, which relative links on the page need, or a saved
   * project that answers under another path now that it was built again.
   */
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
   * in its data dir, and `pr-review open` adds it again. False when no project has that slug;
   * refused while the project runs a chat turn or a generation.
   */
  remove(slug: string): Promise<boolean>
  close(): void
}

export interface HubOptions {
  home: string
  load: LoadProject
  log: (line: string) => void
  now?: () => Date
}

interface Slot {
  entry: RegistryEntry
  /** Null for a saved project no request has asked for since the server started. */
  project: Project | null
}

interface Clone {
  shared: CloneShared
  sweeper: CheckoutSweeper
}

function isBusy(project: Project): boolean {
  return project.ctx.generation.running() !== null || project.ctx.chat.running().length > 0
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
  const now = opts.now ?? (() => new Date())
  const slots = new Map<string, Slot>()
  for (const entry of await readRegistry(opts.home)) {
    slots.set(entry.slug, { entry, project: null })
  }
  /** One part per clone, keyed by its repository's folder in the data dir. */
  const clones = new Map<string, Clone>()

  const cloneOf = (config: RuntimeConfig): CloneShared => {
    const key = repoDir(config.dataDir, config.repo)
    const existing = clones.get(key)
    if (existing !== undefined) {
      return existing.shared
    }
    const shared = createCloneShared(config, now)
    const settings = createSettingsStore(config.dataDir)
    const name = `${config.repo.owner}/${config.repo.name}`
    clones.set(key, {
      shared,
      sweeper: startCheckoutSweep({
        checkouts: shared.checkouts,
        readSettings: () => settings.read(),
        log: line => opts.log(`[${name}] ${line}`),
      }),
    })
    return shared
  }

  /** Stops the sweep of every clone no served project belongs to any more. */
  const releaseClones = (): void => {
    const used = new Set<CloneShared>()
    for (const slot of slots.values()) {
      if (slot.project !== null) used.add(slot.project.ctx.clone)
    }
    for (const [key, clone] of clones) {
      if (!used.has(clone.shared)) {
        clone.sweeper.stop()
        clones.delete(key)
      }
    }
  }

  const build = async (registration: ProjectRegistration): Promise<Project> => {
    let named: string | null = null
    const ctx = await opts.load(registration, {
      log: line => opts.log(named === null ? line : `[${named}] ${line}`),
      cloneOf,
    })
    named = ctx.config.slug
    return { ctx, app: createApp(ctx) }
  }

  const save = (): Promise<void> =>
    writeRegistry(
      opts.home,
      [...slots.values()].map(slot => slot.entry)
    )

  const registerNow = async (
    registration: ProjectRegistration
  ): Promise<{ project: Project; kept: boolean }> => {
    const project = await build(registration)
    const { slug, repoRoot } = project.ctx.config
    const slot = slots.get(slug)
    const current = slot?.project ?? null
    if (current !== null && isBusy(current)) {
      releaseClones()
      // Two worktree folders of one name share a path. While the other one works, this one
      // cannot take the path, and opening it would show the other checkout.
      if (current.ctx.config.repoRoot !== repoRoot) {
        throw new AppError(
          'BAD_REQUEST',
          `${slug} serves ${current.ctx.config.repoRoot}, which has a chat turn or a generation running`,
          409,
          'try again when it ends, or rename one of the two worktree folders'
        )
      }
      return { project: current, kept: true }
    }
    if (slot !== undefined && slot.entry.repoRoot !== repoRoot) {
      opts.log(`${slug} now serves ${repoRoot}, in place of ${slot.entry.repoRoot}`)
    }
    slots.set(slug, { entry: { slug, repoRoot, flags: registration.flags ?? {} }, project })
    releaseClones()
    const { ctx } = project
    ctx.log(`${repoRoot} · data dir ${ctx.config.dataDir}`)
    if (ctx.fixtureArtifact !== null) {
      ctx.log(`fixture canvas ${ctx.config.fixtureCanvasPath ?? ''} (dev only): every PR reports ready`)
    }
    for (const w of ctx.projectConfig.warnings) {
      ctx.log(`warning: ${w}`)
    }
    await save()
    return { project, kept: false }
  }

  /** Takes a project off the list; the caller saves the list. */
  const drop = (slot: Slot): void => {
    if (slot.project !== null && isBusy(slot.project)) {
      throw new AppError(
        'BAD_REQUEST',
        `${slot.entry.slug} has a chat turn or a generation running`,
        409,
        'remove it once that ends'
      )
    }
    slots.delete(slot.entry.slug)
    releaseClones()
  }

  /** Drops the idle projects whose folder is gone. A project still working keeps its place. */
  const prune = async (): Promise<void> => {
    let dropped = false
    for (const slot of [...slots.values()]) {
      if (!(await folderGone(slot.entry.repoRoot)) || (slot.project !== null && isBusy(slot.project))) {
        continue
      }
      drop(slot)
      opts.log(`removed ${slot.entry.slug}: ${slot.entry.repoRoot} no longer exists`)
      dropped = true
    }
    if (dropped) {
      await save()
    }
  }

  /**
   * Builds a saved project on its first request, through the same registration a command makes,
   * with the flags it was saved with. The checkout may answer under another path now, when its
   * origin or folder changed since; its old path then leaves the list.
   */
  const restore = async (slug: string, rest: string): Promise<Resolved | null> => {
    const slot = slots.get(slug)
    if (slot === undefined) {
      return null
    }
    if (slot.project !== null) {
      return { kind: 'project', project: slot.project, rest }
    }
    if (await folderGone(slot.entry.repoRoot)) {
      await prune()
      return null
    }
    const { project } = await registerNow({ repoRoot: slot.entry.repoRoot, flags: slot.entry.flags })
    if (project.ctx.config.slug === slug) {
      return { kind: 'project', project, rest }
    }
    slots.delete(slug)
    await save()
    return { kind: 'redirect', location: `${project.ctx.config.basePath}${rest.slice(1)}` }
  }

  // One change to the list at a time: two registrations at once for one path would both replace
  // the same project, and a restore racing a registration would serve a project from no slot.
  const inTurn = oneAtATime<'projects'>()
  await prune()

  return {
    register: registration => inTurn('projects', () => registerNow(registration)),

    async resolve(pathname) {
      let match: Slot | null = null
      for (const slot of slots.values()) {
        const base = basePathOf(slot.entry.slug)
        if (pathname === base.slice(0, -1)) {
          return { kind: 'redirect', location: base }
        }
        // The longest base wins: a GitLab group can hold a project and a subgroup of one name.
        if (
          pathname.startsWith(base) &&
          (match === null || base.length > basePathOf(match.entry.slug).length)
        ) {
          match = slot
        }
      }
      if (match === null) {
        return null
      }
      const { slug } = match.entry
      const rest = `/${pathname.slice(basePathOf(slug).length)}`
      return match.project !== null
        ? { kind: 'project', project: match.project, rest }
        : inTurn('projects', () => restore(slug, rest))
    },

    async projects() {
      await inTurn('projects', prune)
      return [...slots.values()].map(slot => slot.entry)
    },

    remove: slug =>
      inTurn('projects', async () => {
        const slot = slots.get(slug)
        if (slot === undefined) {
          return false
        }
        drop(slot)
        await save()
        opts.log(`removed ${slug}`)
        return true
      }),

    close() {
      for (const clone of clones.values()) {
        clone.sweeper.stop()
      }
      clones.clear()
    },
  }
}
