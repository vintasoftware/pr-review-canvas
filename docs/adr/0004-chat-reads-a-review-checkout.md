# The chat reads code from one git worktree per review

The AI chat used to run with the reader's own checkout as its working directory, so every file the
pull request did not change came from whatever branch the reader had checked out. The chat now
reads from a **review checkout**: a detached `git worktree` under `.pr-review/`, next to the
repository's canvases at `checkouts/<key>.cwd/code`, created on the first chat turn for that review
and moved with `git checkout --detach <headSha>` before each turn, so it always shows the commit
being chatted about. The agent's working directory is `checkouts/<key>.cwd`, the folder that holds
the checkout, and never the checkout itself. A pull request's key is its number; the
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

## The agent runs outside the checkout

At first the checkout was the agent's working directory. acpx and the agents read their own
configuration from the folder they start in (`.acpxrc.json`, `.claude/settings.json`, `.mcp.json`),
and a checkout holds the files of the commit under review, so a pull request could configure the
agent of whoever reviewed it. The agent now starts in a folder the tool owns, which holds the
checkout as `code` and nothing else. Two other ways to do it were tried or weighed:

- **An empty folder beside the checkout.** The agent's shell search of a folder outside its
  working directory needs a permission, and acpx denies every permission but reads, so the agent
  could read a file it knew but not search the code.
- **Removing the configuration files from the checkout.** Each agent has its own, and the list
  would always be one behind. It would also hide those files from a review that changes them.

A symbolic link in the commit is written as a plain file (`core.symlinks=false`), so no path in
the checkout leads outside it.

## Consequences

- A thread from before the agent's folder moved out of the checkout starts a new acpx session on
  its next turn and is sent the seed again, because its session was scoped to the old folder.
- Threads created before this change lose their acpx session (it was scoped to the reader's
  checkout); their next turn starts a new session and sends the seed again.
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
