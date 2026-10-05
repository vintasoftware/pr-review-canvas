import { basePathOf, PROJECTS_PREFIX, projectSlug } from './slug.js'

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
