import { basePathOf, PROJECTS_PREFIX, projectSlug, slugParts } from './slug.js'

const repo = { owner: 'acme', name: 'widgets' }

describe('projectSlug', () => {
  it('is owner/repo for the main checkout', () => {
    expect(projectSlug(repo, '/src/widgets', '/src/widgets/.git')).toBe('acme/widgets')
  })

  it('compares resolved paths, so a trailing slash still names the main checkout', () => {
    expect(projectSlug(repo, '/src/widgets/', '/src/widgets/.git')).toBe('acme/widgets')
  })

  it('adds the folder name for a linked worktree', () => {
    expect(projectSlug(repo, '/wt/feature-x', '/src/widgets/.git')).toBe('acme/widgets~feature-x')
  })

  it('treats every worktree of a bare clone as linked', () => {
    expect(projectSlug(repo, '/x', '/x/repo.git')).toBe('acme/widgets~x')
    expect(projectSlug(repo, '/x/main', '/x/repo.git')).toBe('acme/widgets~main')
  })

  it('sanitizes spaces and odd characters in the folder name', () => {
    expect(projectSlug(repo, '/wt/my feature (2)!', '/src/widgets/.git')).toBe('acme/widgets~my-feature-2-')
    expect(projectSlug(repo, '/wt/v1.2_rc-3', '/src/widgets/.git')).toBe('acme/widgets~v1.2_rc-3')
  })
})

describe('basePathOf', () => {
  it('prefixes the projects path and ends with a slash', () => {
    expect(basePathOf('acme/widgets')).toBe(`${PROJECTS_PREFIX}acme/widgets/`)
  })

  it('keeps GitLab subgroups as path segments', () => {
    expect(basePathOf('group/sub/widgets~wt')).toBe('/r/group/sub/widgets~wt/')
  })

  it('encodes each segment', () => {
    expect(basePathOf('ac me/wid#gets')).toBe('/r/ac%20me/wid%23gets/')
  })
})

describe('slugParts', () => {
  it('splits a worktree slug into its repository and folder, and names no folder for a main checkout', () => {
    expect(slugParts('acme/widgets')).toEqual({ repo: 'acme/widgets', worktree: null })
    expect(slugParts('acme/widgets~feature-x')).toEqual({ repo: 'acme/widgets', worktree: 'feature-x' })
    expect(slugParts('group/sub/widgets~wt')).toEqual({ repo: 'group/sub/widgets', worktree: 'wt' })
  })

  it('reads back what projectSlug builds', () => {
    const slug = projectSlug(repo, '/wt/my feature', '/src/widgets/.git')
    expect(slugParts(slug)).toEqual({ repo: 'acme/widgets', worktree: 'my-feature' })
  })
})
