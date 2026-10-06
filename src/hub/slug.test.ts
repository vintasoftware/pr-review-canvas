import { basePathOf, pathSegments, PROJECTS_PREFIX, projectSlug, slugParts, worktreeOf } from './slug.js'

const repo = { owner: 'acme', name: 'widgets' }

describe('worktreeOf', () => {
  it('is null for the main checkout, whose git dir is the common one', () => {
    expect(worktreeOf('/src/widgets/.git', '/src/widgets/.git')).toBeNull()
  })

  it('compares resolved paths, so a trailing slash still names the main checkout', () => {
    expect(worktreeOf('/src/widgets/.git/', '/src/widgets/.git')).toBeNull()
  })

  it("is git's name for a linked worktree, the last part of its git dir", () => {
    expect(worktreeOf('/src/widgets/.git/worktrees/feature-x', '/src/widgets/.git')).toBe('feature-x')
    // Two worktrees in folders of one name: git names the second one apart, and so does the label.
    expect(worktreeOf('/src/widgets/.git/worktrees/feature-x1', '/src/widgets/.git')).toBe('feature-x1')
  })

  it('treats every worktree of a bare clone as linked', () => {
    expect(worktreeOf('/x/repo.git/worktrees/main', '/x/repo.git')).toBe('main')
  })
})

describe('projectSlug', () => {
  it('is owner/repo for the main checkout', () => {
    expect(projectSlug(repo, null)).toBe('acme/widgets')
  })

  it("adds a linked worktree's label", () => {
    expect(projectSlug(repo, 'feature-x')).toBe('acme/widgets~feature-x')
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

describe('pathSegments', () => {
  it('decodes each segment of a path under the prefix, as basePathOf encoded it', () => {
    expect(pathSegments(basePathOf('acme/widgets~café'))).toEqual(['acme', 'widgets~café', ''])
    expect(pathSegments('/r/acme/widgets~caf%C3%A9/review/42')).toEqual([
      'acme',
      'widgets~café',
      'review',
      '42',
    ])
    // A `%` in git's name arrives doubly encoded and decodes once, back to the name.
    expect(pathSegments(basePathOf('acme/widgets~a%2Fb'))).toEqual(['acme', 'widgets~a%2Fb', ''])
    expect(pathSegments('/r/acme/widgets')).toEqual(['acme', 'widgets'])
  })

  it('is null outside the prefix, or for a segment that is not valid percent-encoding', () => {
    expect(pathSegments('/')).toBeNull()
    expect(pathSegments('/static/brand.svg')).toBeNull()
    expect(pathSegments('/r/acme/widgets~%E0%A4%A/')).toBeNull()
  })
})

describe('slugParts', () => {
  it('splits a worktree slug into its repository and folder, and names no folder for a main checkout', () => {
    expect(slugParts('acme/widgets')).toEqual({ repo: 'acme/widgets', worktree: null })
    expect(slugParts('acme/widgets~feature-x')).toEqual({ repo: 'acme/widgets', worktree: 'feature-x' })
    expect(slugParts('group/sub/widgets~wt')).toEqual({ repo: 'group/sub/widgets', worktree: 'wt' })
  })

  it('reads back what projectSlug builds', () => {
    const slug = projectSlug(repo, worktreeOf('/src/widgets/.git/worktrees/my-feature', '/src/widgets/.git'))
    expect(slugParts(slug)).toEqual({ repo: 'acme/widgets', worktree: 'my-feature' })
  })
})
