# The chat reads code from one git worktree per review

The AI chat used to run with the reader's own checkout as its working directory, so every file the
pull request did not change came from whatever branch the reader had checked out. The chat now
reads from a **review checkout**: a detached `git worktree` under `.pr-review/`, next to the
repository's canvases at `checkouts/<key>`, created on the first chat turn for that review and
moved with `git checkout --detach <headSha>` before each turn, so it always shows the commit being
chatted about. A pull request's key is its number; the
`branch` review checks out the branch's HEAD commit, leaving uncommitted edits out as that review
does. The `uncommitted` review has no checkout and keeps reading the reader's own checkout, because
the live working tree is the work under review.

`.pr-review/` is shared by every worktree of one clone, and so are chat threads, so the checkout is
shared too. A lockfile next to it stops two `serve` processes from moving it at once; a turn that
finds it held by another process answers `CHAT_BUSY`.

## Considered options

- **One worktree per head commit.** Old heads stay readable side by side, but disk use grows with
  every push and acpx sessions, which are scoped by working directory, would split across heads.
- **One worktree per reader worktree and review.** Needs no cross-process lock, but doubles disk
  use, and a thread opened from another worktree would lose its acpx session.
- **`git archive` into a plain folder.** Stays out of `git worktree list` and is removed with a plain
  delete, but every new head is a full export instead of a checkout of the changed files.
- **An MCP tool that reads blobs by commit.** Needs no disk, but the agent loses its own search
  tools and we would own a read and search server.

One worktree per review keeps one stable path, so the acpx session survives new pushes and the
checkout being removed and created again. The cost is an extra entry in `git worktree list`.

## Consequences

- Threads created before this change lose their acpx session (it was scoped to the reader's
  checkout); their next turn starts a new session and sends the seed again.
- A symbolic link in the commit is written as a plain file that holds its target
  (`core.symlinks=false`), so no path in the checkout leads outside it. A move rewrites only what
  the two commits change, so a checkout made before this rule, whose metadata does not say
  `links: files`, is made again on its next lease.
- The worktree holds tracked files only. The seed points the agent at the reader's checkout for
  installed dependencies, and warns that they follow the reader's lockfile, which may differ from
  the reviewed commit when it changes dependencies.
- The chat panel shows the checkout while it runs. When the worktree cannot be created or moved,
  the turn runs in the reader's checkout as before and the panel warns that answers may describe
  another version of the code.
- Settings: `checkoutEnabled` (false reads the reader's checkout as before), `checkoutIdleDays`
  (default 7; -1 never removes a checkout for idleness), and `checkoutSweepMinutes` (default 60).
  `serve` sweeps at startup and on that interval. `pr-review clean` removes idle checkouts on
  demand, with `--all`, `--older-than <days>`, and `--dry-run`; with `checkoutIdleDays: -1` a bare
  `clean` removes nothing and says so. Neither touches canvases or review state.
