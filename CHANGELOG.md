# Changelog

## 0.10.0

Changes since 0.9.0.

### Reading

- **Show layers** has a third choice, **on a board**: the review as a tree you pan, zoom, and
  rearrange. The pull request is the root, its layers hang under it with their descriptions, and
  an open layer's attention points under it. You review a layer through its points: its title bar
  counts the ones you dismissed or acted on, and once you act on one the board opens the next. An opened point shows the code it is about, and a link
  to a file opens it in a side panel. The board has no rail, and AI Chat floats over it. See
  [On a board](docs/reference.md#on-a-board).
- A layer's **Tests** table starts closed, in every view. Its title counts the tests: how many are
  covered, missing, or not needed. Click it to open the table.

### Self-review

- A resolution now lasts. Every later canvas of the pull request starts from the resolutions of its
  newest canvas, after a push that changes the code under a point, a rebase, or `--force` too. The
  generator keeps a resolved concern under its title, so it stays resolved, and reopens it under a
  new title only when the author's reason no longer holds. Before, a push that touched a resolved
  point's lines, or any `--force`, brought the point back open.
- Resolved points start hidden for every reader. The overview line counts them as **resolved by the
  author** and its **show the N resolved** command brings them back, collapsed in place. A layer
  whose points are all resolved drops its points heading while they are hidden, and the heading
  says **none open** while one of them is still on the page.
- A reviewer's page reads the author's resolutions back from the canvas comment when it opens and
  every two minutes after while its tab is in view, hides the newly resolved points, and says so.
  Before, a reviewer who had already loaded the canvas saw them only after **refresh**.
- A draft the reviewer added to the review stays when the author resolves its point. The message
  says the review keeps it, the draft says the author resolved its point, and the overview line
  counts the resolved points that still hold one.

### Prompt templates

- `pr-review upgrade` checks the project's own prompt templates once pr-review moves: each token
  the new release added to a bundled template that a custom copy lacks is named, with the heading
  to add it under, also when the upgrade is declined or cannot be asked without a terminal, and in
  `--json` as `prompts`. `pr-review doctor` has the same check as its `prompts` line, for any
  release up to the running one.

### Attention points

- Each level has its own shape: a diamond for **decide**, a checked box for **check**, and an info
  circle for **fyi**. The shapes replace the colored squares on cards, diff rows, the overview
  counts, and the legend, so the level reads without color.
- **Point colors** in the settings dialog picks the palette: **classic** (red, amber, gray, the
  default) or **action** (purple, blue, gray), for readers who took the red and amber for a
  severity scale. It is saved as `pointColors` in `settings.yml`.
- A **decide** point has an impact: **critical**, **high**, or **low**, for what a wrong call would
  cost. Its card shows it next to the title in the decide icon's color, filled for critical,
  outlined for high, and dashed for low, apart from the kind and audience tags. Decide points list
  the worst impact first. A canvas generated before this version shows its decide points without
  one; generate again to get them.
- A generation that leaves a decide point without an impact, or gives one to another point, is
  sent back to the agent to fix (`POINT_IMPACT`).
- A `decision` point's tag reads **design choice**, on its card, in a copied or posted comment, and
  in what AI Chat is told. It marks a choice the change makes at any level, so an fyi one no longer
  reads as something to decide. Canvases still store `decision`, so resolutions and threads hold.
- A generation that writes a **question** point at fyi level is sent back to the agent to fix
  (`POINT_LEVEL`): a question asks the reader to decide or check. Stored canvases still open.

### Settled decisions

- A question the author already answered is recorded in the commit that carries the answer, as a
  `Settled-decision: <path>:<line> <question>? <decision and reason>` line, and publish adds it to
  the canvas as a resolved attention point titled by the question, with the answer as its reason,
  so the canvas does not ask it again. The question is optional. The point costs the generator
  none of its own.
- `prepare` reads the decisions of the author's own commits, and on a pull request only when its
  author prepares the canvas. A decision is carried to its line while the line reads the same at the
  head, and kept as context the generator does not reopen once it does not, or once a deleted line
  it is about comes back. The line counts anywhere in the message, so a blank line before
  `Co-Authored-By` loses nothing.
- A reason the author wrote on the canvas stands over the commit's until a later commit changes
  the answer; a later decision on the same line and question replaces an earlier one. Two
  questions about one line, in one commit or two, are two resolved points, each with its answer.
- **reopen** on a decision's point lasts: every later canvas keeps it open until a later commit
  answers its question on that line again. While it is open, the point says the author reopened
  it, with the commit's answer as context.
- A decision's point gives its commit's answer in its text, so **copy** and **ask** carry it.
- A line that asks its question and gives no answer, such as `src/app.ts:9 Is this the answer?`,
  resolves nothing: the generator is told the question is open.
- An indented `Settled-decision` line counts. A decision on a line deleted in a commit that also
  renames its file is found under the old name.
- The review loop skill writes a decision line for each question its gate asks, and its Claude and
  Codex copies are the same again.

### AI Chat threads

- **Ask** opens the thread of the place it was asked from: an attention point, a selection of lines,
  a file, or a layer. The first ask about a place starts a thread titled after it, and asking about
  the place again comes back to that thread. Each thread is its own agent session, so a
  conversation about one point no longer mixes with another's.
- The chat pane shows one thread at a time, its place named on top with a tag for its kind. The
  context line above the message box stays, with **go to code** to lead back to the place and
  **clear** to take what the box holds to the latest thread about the whole PR. The place's name
  opens the list of every thread, by kind of place, with the questions in each and a filter, in
  place of the pane's old thread select. **new thread**, beside it and at the bottom of the list,
  starts one about the whole PR.
- An ask that leaves the thread the reader was reading for a new one offers **back to** that thread
  until its first question. A thread whose first question is still starting is listed by its place
  until the server has made it.
- Each thread keeps its own unsent text: a half-written question stays with the thread it was
  written in when an ask opens another one. **clear** still takes it along to the whole PR, below
  any text that thread already had.
- The thread list matches the filter against each thread's name and its kind of place, says when
  nothing matches, opens at the open thread, and gives each entry its whole name as a tooltip.
  Picking a thread puts the focus in the message box, and tabbing out of the list closes it.
- The ask command of a place with a thread carries a dot. The dot fills, and the thread's name on
  top of the pane counts the threads, as in **2 new**, when an answer arrived there while the reader
  was not reading it: in another thread, with the pane minimized, or on another tab. The **AI Chat**
  tab and its launcher count those answers, up to 9. The marks are kept with the review, so a reload
  keeps them.
- While an answer comes in, ask, the list of threads, and **new thread** still open any thread, and
  the answer keeps arriving in its own. A question asked elsewhere meanwhile is sent once it ends.
- The open thread comes back when the page is reloaded.
- `chatThreadPerPlace: false` in `settings.yml`, or **A thread per place** cleared in the settings
  dialog, sends every ask to the open thread as before.
- Threads saved by earlier versions still appear in the list of threads, under whole PR, since they
  have no place.

### Commands

- The GitHub skin draws more commands as icons, each with its word as tooltip and accessible name:
  the AI Chat pane's minimize, **new thread**, **go to code**, and **clear**; a point's and a chat
  card's **post to github**, a chat card's **edit** and **copy**; the copy of a diagram or a
  command box; and the link to the pull request on the forge, which opens in a new tab.
- A layer's ask is an icon too, and its menu offers questions about the whole layer: a walkthrough,
  what it could break, whether it follows the codebase, and whether its tests are enough. A file's
  ask opens the file's thread at once, with no menu, and so does the context chip of a file.
- The context chip above the message box keeps to one line, with the whole name as its tooltip.

### Reading

- A file's hunks share one width: scrolled sideways past the end of a short hunk under a long one,
  its added, removed, and hunk rows keep their colors. Before, they stopped at the card's width.
- Only code lines make a diff scroll sideways. Attention points, annotations, comment threads,
  comment boxes, and folded-code titles wrap at the visible width and stay in view while a long
  line scrolls. Before, a line long enough to scroll stretched them to its width.
- Diagrams draw smaller. A flowchart's decisions are hexagons tinted with the page's accent instead
  of diamonds that grow with their question, its steps have rounded corners, and nodes sit closer.
  A sequence diagram draws its participants once, on top. **copy** still gives the source as
  written.
- Every row of an `erDiagram` entity is readable in the dark theme; every other row was light, with
  text in the dark theme's light color.
- The terminal skin's text reads at WCAG AA contrast: a filled copy drops its fill while it says
  **copied** or **failed**, pending pills and the review count take dark text on their yellow, and
  changed words, red text, muted text, and some syntax colors are adjusted, in light and dark.
- **Hide code** shows on an outdated canvas too, once **view stale canvas** opens it, and counts
  what it hides from that canvas's own diff.
- The line under **Hide code** says **nothing else hidden** when the level hides nothing beyond
  imports, whitespace, and moved blocks, which the diff folds at every level. It used to say
  **nothing hidden yet** next to a diff that had folded them.
- On a GitLab project the overview's description reads **PR description (from GitLab)**.
- A toast shows left of the docked side pane instead of over its message box.
- A draft's **back to** link names the thread by its title once the server gives it one, not as
  **New thread**.
- The header names the agent and model that generated the canvas on screen, an outdated one
  opened with **view stale canvas** too, without the harness, which a canvas generated from the
  review app always gave as `other`. Hover **generated … ago** for the full date and time.

### Upgrade from 0.9.0

1. Run `pr-review upgrade` in each project. It refreshes the project's copy of the skill, which now
   tells the agent to write no point for a settled decision, and names the tokens the project's own
   prompt templates lack.
2. Restart the running `pr-review serve`, so the review page and `pr-review generate` run the new
   version.
3. A project with its own prompt templates merges in the bundled changes:
   - Its own `generation-format.md` adds the `{{RESOLVED}}` token, where the bundled template has it
     under **Attention points**; `pr-review upgrade` and `doctor` say so. Without it the generator
     is not told which points the author resolved: a point that comes back with the same title stays
     resolved unchecked, and one reworded comes back open.
   - Its own `generation-format.md` adds the `{{SETTLED_DECISIONS}}` token, where the
     bundled template has it under **Settled decisions**; `pr-review upgrade` and `doctor` say so.
     Without it the generator is not told the author's settled decisions and may ask their questions
     again; publish still adds the ones in the diff as resolved points.
   - Its own `generation-format.md`, `quality-standards.md`, `judging-strict.md`, or
     `judging-surfacing.md` merges in the bundled copies' definitions of impact. `pr-review upgrade`
     and `doctor` do not name this one, since it adds no token. Without them, every generated decide
     point comes back with `POINT_IMPACT`, and the agent picks an impact without the definitions.
4. Teammates on 0.9.0 can still open new canvases; they do not see the impact, and see a settled
   decision as a point the author resolved. A pull request author who resolves or reopens a point
   on 0.9.0 saves the canvas without the marks that tell settled decisions apart, so the next
   canvas built on it can ask a decision's question again.

## 0.9.0

Changes since 0.8.0.

### Generating from the terminal

- `pr-review generate [<n>|branch|uncommitted]` generates a canvas from a terminal, with no skill
  installed. The job runs in the running server, as one started from the review app does, so one
  generation still runs at a time in a clone and the review page shows it. The command prints each
  phase and waits for the end; **Ctrl+C** stops the wait, not the job. Without a review, it
  generates for the open PR or MR of the current branch.
- `--force` starts from a blank page, `--base <ref>` compares the branch or uncommitted review
  against another ref, and `--agent` and `--model` choose the agent and model for that run.
- `--out <file|dir>` posts nothing on the PR or MR for that run and writes the canvas zip, to send
  to a reviewer, who loads it with `pr-review import`. Resolving a point on the review page later
  shares the canvas, unless sharing is off.
- `--open` opens the review when the canvas is published, and `--json` prints one JSON line. A
  failed job exits as any other failure: `5` when publish rejected the model on every repair
  attempt.
- `generate` keeps the flags the project was opened with, such as `--chat-agent`, and takes the
  shell's environment, as `open` does.

### Reading

- The rail shows the lines each layer adds and removes next to its file count. A file split across
  layers counts only the chunks of each layer.
- Hover the totals of the rail and the header for the split between code and tests, as in
  `code +3 −2 · tests +2 −1`.

### Attention points

- Each attention point has one status: open, in your review, posted, resolved, or dismissed. A
  point that is not open stays in its layer and on its diff line, collapsed to its title, a status
  pill, and one line. **show** expands it with its outcome and the command that undoes it, and a
  point in your review shows its drafts with **edit** and **delete**.
- The overview's dismissed and resolved lists give way to one status line, with a switch that hides
  the points acted on. Counts, the rail, and `]`/`[` cover open points only; `o` expands a
  collapsed point.

### Your review

- The side pane has a **Your review** tab next to AI Chat. It lists every pending draft by file,
  with where it came from, a link to its line, **edit**, **delete**, **finish your review**, and
  **discard**. The pending bar's **see the list** opens it. Drafts written on earlier commits are
  listed there too. With AI Chat off, the pane holds the review alone, minimized until opened.
- A draft being edited in the tab keeps its text, focus, and selection while other drafts are
  added, saved, or deleted.
- **finish your review** and the header's sign-off commands wait while a draft edit on screen
  differs from the saved draft: they say to save or cancel it first, and put the focus on it.
- On a phone, or wherever the pane floats over the canvas, a line link in the pane minimizes the
  pane so the line is not left under it. Posting a review minimizes it too, so the receipt and its
  link to the forge are on top.

### AI Chat

- The context chip sits above the message box, and each question in the transcript names the
  context it was asked with, after a reload too.
- A proposed comment can name the attention point it acts on: its card says "about the point …",
  with **unlink** until the comment is sent. Queuing, posting, or editing it acts on that point,
  as the point's own **add to review** does.
- When the reader wrote the pull request, AI Chat can propose resolving a point with a reason.
  **resolve** saves the reason, posting nothing. **edit** opens the point's reason box with it,
  where it can change and also be posted on the line. The box opens for a point of a collapsed
  layer or a hidden acted-on point too, and a pane floating over the canvas steps aside for it.

### Fixes

- Reloading the page shows the canvas as outdated after a push made since the last load, and after
  the pull request moved to another base branch. A canvas of the head itself is outdated when it
  was generated against another merge base and the diff changed: it is shown with the diff it was
  generated from, and the bar names both merge bases. A new base that leaves the diff identical
  keeps the canvas, as a push with an identical diff does, unless `canvas.keepForIdenticalDiff`
  is off.
- After a move to another base, review marks and pending drafts follow the diff they were made
  on: marks made on the old diff do not count for a canvas generated again on the new base, drafts
  written on it are listed as written on an earlier diff and are refused on submit unless the diff
  is unchanged, and a page drawn before the move cannot post or mark until it is reloaded.
  `pr-review import` and a generation that finished after the move say so too.
- The generation dialog says when the agent is correcting the issues validation found, so they no
  longer read as errors to act on, and hides them once the canvas is published. They stay shown
  when the generation fails or is stopped.

### Upgrade from 0.8.0

1. Run `pr-review upgrade` in a project. The skill did not change, so it only installs the new
   version, and each project's skill copy stays as it is.
2. Restart the running `pr-review serve`. `pr-review generate` needs the new server, and the
   server moves each earlier diff into its merge base's folder the first time it is read.
3. The canvas format did not change, so teammates on 0.8.0 can still open the canvases.

## 0.8.0

Changes since 0.7.0.

### One server for every project

- One `pr-review serve` now serves every project. Start it once, in any folder, and run
  `pr-review open` in a project to add it and open its review: the open PR or MR of the current
  branch, or the project's home page. `pr-review open 123`, `open branch`, and `open uncommitted`
  open that review.
- Each project answers under `/r/<owner>/<repo>/`, and a linked worktree under
  `/r/<owner>/<repo>~<worktree>/`, with git's name for the worktree, because its branch and
  uncommitted work differ. The pages and features under that path are unchanged.
- `http://localhost:3010/` lists the projects. **remove** takes one off the list; its canvases and
  review state stay, and `pr-review open` adds it again. A project whose folder is gone leaves the
  list by itself.
- The logo leads to the project list. Next to it, the project's name leads to its home page.
- The project list and each project's home page have the **skin** and **theme** commands of the
  review page.
- `pr-review serve` inside a project still adds and opens it. When a server already runs, it adds
  the project to that server and exits, unless `--port` names another port.
- The server runs git, `gh`, `glab`, and the agent of each project with the environment of the
  shell that ran `open` for it, kept in memory only. `--data-dir`, `--chat-agent`, and
  `--chat-model` also work on `open`, per project, and are saved with it.
- After a restart, a project opened from a bookmark runs with the server's environment, with the
  data dir and `PR_REVIEW_HOST` it was opened with, which are saved with it. The server logs this,
  and a **server env** badge next to the project's name opens a dialog: what may fail when the
  project's shell sets its own token or `PATH`, and the command to give it the shell's again.
- Each worktree of a clone has its own `branch` and `uncommitted` reviews: review progress,
  chat threads, review checkout, and the earlier canvases they fall back on. A linked worktree's
  go by `branch~<worktree>` in the clone's `.pr-review/`; local reviews a linked worktree prepared
  before now are the main checkout's, so prepare them again there. A pull request's review stays shared by every worktree,
  which run one generation at a time and one chat turn per pull request.
- `publish` prints a `reviewUrl` under the project's path and on the running server's port.
- The server keeps `server.json` (readable by its owner only), `projects.json`, and the project
  list's look in `~/.pr-review`, or in `PR_REVIEW_HOME`. Only a command that can read
  `server.json` can add a project.

### Reading

- Every code block in rendered text has a `copy` command: chat answers, proposed and pending
  comments, attention points, layer notes, the summary, and GitHub comments and descriptions. It
  copies the block as written. With a mouse, it shows when the pointer is over the block.
- Every `copy` command says how it went. For two seconds the button shows `copied` (a check in the
  GitHub skin) or `failed` (a cross), and a toast says "copied to clipboard" or, in red, "could not
  copy". A failure's reason shows beside the button. A copy inside a modal dialog toasts in that
  dialog.

### Generating from the review app

- A generation from the review app follows the project's own `pr-review-canvas` skill: the copy
  in the agent's skills folder (`.claude/skills` or `.agents/skills`), else the other harness's,
  else the skill pr-review ships. The start screen and the run's status say which, and whether the
  project's copy was edited or was installed by a different pr-review version.
- The generation dialog says what the agent is doing right now: waiting to start, thinking,
  writing the answer (with how many characters so far), or running a tool, and how long ago it
  last showed it was working. A run that writes the canvas for minutes without a tool call no
  longer looks stuck; after three minutes with nothing from the agent, the dialog says it may be.

### Fixes

- A merged pull request whose base branch was deleted since, as a stacked PR's is once the PR
  below it merges, failed to load with a git error. Its review now loads from its merge commit.

### Upgrade from 0.7.0

1. Stop every running `pr-review serve`. Then run `pr-review upgrade` in each project: the skill
   now points at the project's path on the server. The canvas format did not change, so
   teammates on 0.7.0 can still open the canvases.
2. Start one `pr-review serve` and run `pr-review open` in each project to add it. Drop the
   `--port` that gave each project its own server; `--port` now starts a separate server.
3. Review pages moved under `/r/<owner>/<repo>/`. Old bookmarks such as
   `http://localhost:3010/review/123` no longer open; reopen the review with `pr-review open 123`.
4. Local `branch` and `uncommitted` reviews prepared in a linked worktree before this version
   belong to the main checkout now. Prepare them again in the worktree.

## 0.7.0

Changes since 0.6.2.

### Review server

- `pr-review serve` opens the review of the open PR or MR whose head is the checked-out branch,
  so a server started in a PR's worktree lands on that PR. Other branches open the home page.
- The logo in the header links to the home page, where you enter another PR or MR number.

### Generating from the review app

- With `acpx` installed, the review app generates canvases itself. **generate canvas** on an empty
  screen or on the home page starts the first generation, **generate for current head** updates an
  outdated canvas, and **regenerate** writes the current one again from a blank page. The local
  branch and uncommitted reviews work the same way.
- The header's generate command is named for what it does: **generate** with no canvas,
  **update** on an outdated one, **regenerate** on a current one. Without an agent it stays
  **regenerate** and shows the skill command.
- The generation dialog shows the phase, the elapsed time, the latest tool calls of the agent, and
  the problems publish named, and **stop** cancels the run. While it runs, the header command
  shows **generating** with the elapsed time and reopens the dialog, also after a reload. One
  generation runs at a time.
- When the canvas would be shared on the PR or MR, a start is refused unless `gh` or `glab` is
  logged in with an account that can comment, so no agent time goes into a canvas that cannot
  be shared. The dialog shows the reason and the command to run.
- The server runs `prepare` and `publish` itself. The agent runs with the flags of AI Chat, which
  deny every write, and answers with the model JSON, which the server writes, fixes, and publishes.

### Project

- Releases are also published to GitHub Packages, next to npm.

### Upgrade from 0.6.2

1. Run `pr-review upgrade` in each project, then restart `pr-review serve`. The skill and the
   canvas format did not change, so teammates on 0.6.2 can still open the canvases.
2. To generate from the review app, install `acpx` and pick the agent under `chatAgent` in
   **settings**, as for [AI Chat](README.md#optional-ai-chat-install). Generation uses the model
   that `generation.models` names for that agent.

## 0.6.2

Changes since 0.6.1.

### AI Chat

- **Ask** on an attention point is a button with a robot icon, as it is on a layer or file. The
  **AI Chat** bubble wears the same icon.

### Self-review

- The author can **resolve** any attention point, a reviewer point too, such as a false positive.
  Before, a reviewer point had no **resolve**, and the author could only answer it in a comment.
- **Dismiss** is available in self-review as a personal hide. It does not resolve the point:
  reviewers still see it, and the self-review note still counts it. Restore a dismissed point to
  resolve it.

### Incremental canvases

- An attention point the generator wrote, whose body links to a file the new commits changed or
  dropped, is decided again instead of being carried word for word with any resolution it had.
- The update prompt tells the generator to check each carried point against the changed chunks,
  and to drop or retitle one a chunk contradicts, so its old resolution does not follow.

## 0.6.1

Changes since 0.6.0.

### CLI output

- `install-skill`, `export`, `import`, `clean`, and `upgrade` print text at a terminal, and an
  unknown command or any other failure prints `error:` and `hint:` lines on stderr. `--json`, or a
  stdout that is a pipe, keeps the JSON line. `prepare`, `validate`, and `publish` always print
  JSON.

### Skins

- New `olive` skin: GitHub's layout in the project site's palette. Set `skin: olive` in
  `.pr-review/settings.yml` or cycle with the skin command (terminal, github, olive).
- The `github` skin has clearer section and file separation.

### Project

- The project site shows the canvas in the olive skin and mentions self-review, generation models,
  and GitLab.
- CSS is linted with stylelint, plus a check for unused CSS.

## 0.6.0

Changes since 0.5.0.

### Self-review

- Every attention point names its audience: **author** (shown as **yours** to the author) or
  **reviewer**. Points in canvases from earlier versions are all the reviewer's.
- The PR author can **resolve** an author point with a reason, and **reopen** it later. A resolved
  point leaves every reviewer's list and its reason is shown under the overview. The author can
  also post the reason as a comment on the point's line. Only the PR author can resolve.
- The canvas comment counts the points left for the reviewer and the ones the author resolved.
- Resolutions survive regenerating the same commit and follow carried points into incremental
  canvases. **Refresh** imports a canvas the author revised at the same commit.
- The skill ends by handing the author the self-review.

### Sharing

- `sharing.canvasComment: false` in `pr-review.config.yml` keeps canvases local: `publish` posts
  no PR/MR comment.
- `sharing.mentionCanvas: false` removes the `from the pr-review canvas` credit from posted
  comments and leaves the sign-off body empty.
- Each person can override either switch in `.pr-review/settings.yml`.

### Canvas generation

- `generation.models` in `pr-review.config.yml` sets the model each agent generates with
  (`claude: opus`). Claude now generates with Opus by default. The skill no longer pins Sonnet.
- `validate --fix` repairs fold errors that have only one correct fix: it clips folds to their
  chunk, drops repeated folds, and shrinks folds that cover an attention point.
- Incremental canvases keep an attention point in a changed file when its own lines are unchanged
  or only moved.
- `validate` and `publish` use the data dir that holds the canvas, so a canvas prepared with
  `--data-dir` no longer lands in the main checkout. `publish` fails with `CANVAS_ELSEWHERE` when
  the canvas is outside its data dir.

### AI Chat

- AI Chat reads code from a review checkout: a git worktree at the reviewed commit, so files the
  PR did not change come from the PR, not your current branch. Uncommitted reviews still read your
  working tree.
- `checkoutEnabled`, `checkoutIdleDays`, and `checkoutSweepMinutes` in `.pr-review/settings.yml`
  control review checkouts. `serve` removes idle ones.
- A proposed comment offers **add to review** next to **post to github**.
- The settings keys `agent` and `model` are renamed to `chatAgent` and `chatModel`. Old files
  still work and are renamed on the next save.
- Threads started before this version start a new agent session on their next turn.

### CLI

- `pr-review clean [--all | --older-than <days>] [--dry-run]` removes idle review checkouts.
- `pr-review --help` wraps to the terminal, and `pr-review <command> --help` shows that command.
- `pr-review doctor` prints a checklist. `--json` prints it as one JSON line.
- `serve --chat-agent` and `--chat-model` replace `--agent` and `--model`, which still work with
  a deprecation notice.
- `serve` opens the canvas in the browser. Pass `--no-open` to skip it.

### Review interface

- **Show layers: one at a time** in **settings** shows the overview or a single layer. The rail,
  `j`, and `k` move between layers. The default, `all`, keeps one page.
- The settings dialog has **Reading**, **AI Chat**, **Checkouts**, and **Project** tabs.
- Click a file's name to collapse or open its card. Folds show a chevron and how many lines they
  hide.
- **Canvas is outdated**, **Canvas still applies**, and **Review progress carried over** can be
  dismissed. Only the outdated warning stays pinned to the top.
- The page asks before a refresh discards an unfinished comment or chat message.

### Fixes

- `j`/`k` and `n`/`p` land on the top of the next layer or file, and start from what is on
  screen. `]`/`[` follow page order and reach points in the Other layer. `R`, `o`, and `c` act on
  the focused point. Shortcuts work with AltGr keyboard layouts.
- File, line, and hunk links land on their target, including code in later or collapsed layers.
- Opening a canvas no longer fails with `cannot lock ref` when fetches overlap. pr-review no
  longer updates your remote-tracking branches.
- Concurrent CLI and server writes no longer overwrite each other's canvas index entries.
- Submitted AI Chat proposals keep their **view comment** link after reload and after later
  commits move the commented lines.
- Chat answers no longer run words together after a tool call.

### Breaking changes

- 0.5.0 opens 0.6.0 canvases but ignores resolutions, so resolved points show as open. Teams
  should upgrade together.
- `pr-review doctor` prints a checklist instead of a JSON line. Pass `--json` for the JSON line.

### Upgrade from 0.5.0

1. Run `pr-review upgrade` in each project. It updates pr-review, acpx, and the skill copies.
   Commit the skill copies, then restart `pr-review serve`.
2. Upgrade the whole team together. 0.5.0 opens 0.6.0 canvases but shows resolved points as open.
3. Scripts that read `pr-review doctor` output should pass `--json`. Scripts that pass
   `serve --agent` or `--model` should switch to `--chat-agent` and `--chat-model`.
4. Claude now generates canvases with Opus. To keep another model, set it under
   `generation.models` in `pr-review.config.yml` (for example `claude: sonnet`).
5. If you override `generation-format.md` or the `*-incremental.md` templates, merge in this
   release's changes so generated points name their audience.

## 0.5.0

Changes since 0.4.0. Details are in the [reference](docs/reference.md).

### Pending reviews

- **start a review** holds diff comments locally until you submit them together as one review.
  Attention points can join with **add to review**. Drafts survive a reload.
- On GitHub the drafts post as one review. On GitLab they publish as a batch of draft notes.
- Sign-off adds a **comment** verdict, next to **approve** and **request changes**.

### Reading levels

- A **Hide code** control switches between `light`, `moderate`, and `aggressive`. Higher levels
  hide tests, helpers, and wiring, down to pseudo-code. Press `f` to step through them. Set the
  default in **settings**.
- Attention points, threads, and drafts stay visible at every level.
- Validation fails with `FOLD_MISSING` when a large file or layer hides too little.
- Built-in test patterns now cover common Python, Java, Kotlin, C#, Swift, PHP, and other
  conventions (`tests/`, `*_test.*`, `test_*.py`, `*Test`, and more).

### Incremental canvases

- Regenerating for a new head updates the previous canvas instead of starting over. Layers, notes,
  folds, and attention points of untouched files are kept word for word, and dismissals stay.
- Review marks on untouched files and layers follow the new canvas.
- `--force` starts from a blank page. `canvas.incremental: false` turns this off.
- New prompt templates: `generation-strict-incremental.md`, `generation-surfacing-incremental.md`,
  `judging-strict.md`, and `judging-surfacing.md`.

### Upgrades

- `pr-review upgrade` updates pr-review, acpx, and the project's skill copies after asking.
  `--yes` skips the question.

### AI Chat

- A saved model runs as the newest model of its family (`claude-opus-4-8` runs as `opus`).
  Prefix an ID with `pin:` to use that exact model.
- Claude chat uses the `claude` CLI on PATH when there is one, so it gets new models as soon as
  Claude Code updates. Set `CLAUDE_CODE_EXECUTABLE` to use another binary.
- The chat can be minimized at any width, and restoring it keeps the canvas scroll position.

### Review interface

- GitHub is the default skin. Choose **terminal** under **skin** to switch back.
- Quick-question menus stay inside the window.

### Breaking changes

- Canvases written by 0.5.0 cannot be read by earlier versions. Older canvases still open.
- Review marks saved by earlier versions are dropped on first read, so in-progress reviews start
  their ticks again. Dismissals, posted comments, and chat threads are kept.

### Upgrade from 0.4.0

1. Run `npm install -g @vintasoftware/pr-review-canvas@0.5.0` and restart `pr-review serve`.
   Later upgrades can use `pr-review upgrade`.
2. Run `pr-review upgrade` in each project to refresh the skill copies, then commit them.
3. Upgrade the whole team together, since 0.4.0 cannot open 0.5.0 canvases.
4. If you override `generation-strict.md` or `generation-surfacing.md`, move judging rules into
   `judging-strict.md` or `judging-surfacing.md`. Regenerations use the `*-incremental.md`
   templates, so override those too, or set `canvas.incremental: false`.

## 0.4.0

Changes since 0.3.0.

### Review before the pull request

- Two reviews of the work in a clone, each a target of its own: `pr-review prepare --branch` for
  the tip of the current branch, and `pr-review prepare --uncommitted` for the working tree with
  its edits and untracked files on top. Both compare against the default branch, read from
  `origin/HEAD`, and `--base <ref>` overrides it.
- `--uncommitted` stages the working tree into an index of this tool's own and writes a commit
  anchored at `refs/worktree/pr-review-snapshot`, and publishing anchors that canvas's commit
  under `refs/worktree/pr-review-canvas/`, so nothing the user staged is touched and the
  same tree always hashes to the same commit. Both the index and the anchor are per worktree, so
  worktrees of one clone keep their own snapshots. Changing the head afterwards makes the canvas stale, as a push
  does for a pull request.
- The canvases are served at `/review/branch` and `/review/uncommitted`, and the home page links
  to whichever exist. Each keeps its own review progress and chat threads. Attention points and
  the AI chat work there; comments, sign-off, canvas import, and attachment discovery are refused,
  because local work is on no forge.
- `/pr-review-canvas branch` and `/pr-review-canvas uncommitted` run the whole flow from Claude
  Code or Codex.

### Review interface

- A canvas is carried over to a later pull request head whose diff is identical to the one it
  was generated from, as after merging the base branch in without touching the changed files.
  The page shows it under a **Canvas still applies** note, review progress carries over, and
  sign-off keeps working. The new `canvas.keepForIdenticalDiff` project setting (default `true`)
  turns this off. The note says how many commits later the head is, when the head was built on
  the canvas's commit.
- `pr-review publish` accepts a head whose diff is identical to the prepared commit's, instead of
  failing with `CANVAS_STALE`.
- `pr-review import` and the canvas zips discovered on a pull request read the same rule, so the
  CLI no longer reports a canvas as stale that the page shows as current.

### Canvas sharing

- `pr-review publish` now shares PR/MR canvases automatically in a compressed comment and
  updates the current account's existing canvas comment on subsequent publishes. The payload
  is readable by anyone with access to the PR/MR. Oversized canvases can still be shared as ZIPs.
- Discovery reads both compressed canvas comments and existing ZIP links.
- Import rejects a canvas exported for a different pull request, including with `--force`.

### AI chat

- The chat works on an outdated canvas again: it answers about the canvas on screen, with the
  diff of that canvas's commit, instead of refusing with `CANVAS_NOT_FOUND` after every new commit.

### Hosts

- GitLab merge requests work through the [GitLab CLI (`glab`)](https://gitlab.com/gitlab-org/cli),
  alongside GitHub pull requests through `gh`. Origin detection covers gitlab.com, hostnames that
  contain `gitlab`, and self-hosted GitLab via `PR_REVIEW_HOST=gitlab`.
- Nested GitLab groups (`group/subgroup/project`) are stored as the repository owner.
- Comments, inline discussions, approvals, and canvas-zip discovery use GitLab's REST API.
  Request-changes posts the review body as a merge request note.
- New error codes: `GLAB_MISSING`, `GLAB_UNAUTHENTICATED`, `GITLAB_API_ERROR`. Exit code `4` covers
  both CLIs.

### Fixes

- Git commands select the requested project even when launched from a Git hook with inherited
  repository environment variables.
- GitHub attachment images render as external links, and Markdown comment editing uses a
  single Write/Preview toggle.

### Upgrade from 0.3.0

1. Run `npm install -g @vintasoftware/pr-review-canvas@0.4.0` and restart `pr-review serve`.
2. Run `pr-review install-skill` in each project to refresh the bundled skill. Preserve any
   customizations first, and repeat custom directory flags if used.
3. Publishing a PR/MR canvas now posts or updates a comment automatically. Use `pr-review export`
   when you only want a local ZIP.
4. For GitLab projects, install and authenticate `glab`. Set `PR_REVIEW_HOST=gitlab` for
   self-hosted instances whose hostname does not contain `gitlab`.
5. Local branch and uncommitted reviews need an `origin/HEAD` default branch or an explicit
   `--base <ref>`.

## 0.3.0

Changes since 0.2.0.

### Review interface

- Review history groups submitted reviews and omits empty comment-only events while retaining
  written reviews and approval, change-request, and dismissal decisions.
- Outdated comments appear below review history with replies, original locations, and GitHub
  links. Current comments remain in the diff without a duplicate overview section.
- Clicking directly on a section chevron now expands or collapses it. Keyboard toggling continues
  to work.
- Improved review and tool-call spacing, removed the empty gutter beside inline comments and
  annotations, and added SVG branding.

### AI chat

- Chat floats on smaller screens and becomes a minimizable modal on mobile, with keyboard focus
  containment and Escape to minimize. Drafts survive minimizing and resizing.
- Quick questions now lead with "Suggestion to solve this?" and include five suggested prompts.

### Diagnostics and development

- `serve` logs internal HTTP and chat-stream failures with the request method, path, status,
  error code, and original error details. Expected client errors stay quiet.
- Added Oxlint, Oxfmt, and a pre-commit hook for lint, formatting, strict type checks, and tests.
  CI runs the same checks, executing unit tests once through coverage per Node.js version.

### Upgrade from 0.2.0

1. Run `npm install -g @vintasoftware/pr-review-canvas@0.3.0` and restart `pr-review serve`.
2. Run `pr-review install-skill` in each project to refresh the bundled skill copy. Preserve any
   customizations first, and repeat custom directory flags if used.
3. Existing configuration and saved canvases remain compatible; no migration is required.
4. Contributors should run `corepack pnpm install --frozen-lockfile` and `corepack pnpm hooks:install`
   in their clone. Use `pnpm lint:fix` and `pnpm format` to apply automatic fixes.

## 0.2.0

Changes since 0.1.0.

### Review layers

- Generation groups related behavior and decisions into semantic layers. Projects without
  configured layers no longer use a fixed set of eight architecture groups.
- Configured layers provide optional descriptions, path hints, and reading order. The generator
  can combine, split, or reorder them to fit the change. Tests stay with the code they cover.
- Prompt customization instructions are shorter, with detailed rules in `docs/reference.md`.

### Skill installation

- `install-skill` creates portable copies for Claude Code and Codex on every platform.
  Re-running it refreshes managed copies and replaces legacy symlinks.
- Installed skills include a content hash. `doctor` reports outdated or modified copies;
  `serve` warns with a repair command while continuing to start.
- Installation prevents overwriting the bundled skill's source directory.

### Canvas exports

- ZIP filenames include the PR number, UTC generation time, eight-character commit prefix,
  and repository: `pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip`.
- Comparisons before a PR exists use `ref-` instead of `pr-<number>-`. Re-exporting a canvas
  keeps its filename. Attachment discovery recognizes the new names.

### Validation

- Expanded unit coverage for review validation, GitHub attachments, server routes, and UI behavior.
- CI retains coverage reports for seven days for both Node.js versions.

### Upgrade from 0.1.0

1. Run `pr-review install-skill` in each project after upgrading. Repeat custom directory flags
   if used. Preserve customized skills before refreshing managed copies, and commit updated copies.
2. Rename the `prompts` config key `layers-default.md` to `layering-guidance.md`. Update any
   custom generation templates from `{{DEFAULT_LAYERS}}` to `{{CONFIGURED_LAYERS}}` and from
   `{{LAYERS_DEFAULT}}` to `{{LAYERING_GUIDANCE}}`. The old config key is rejected and causes
   configuration to fall back to defaults; old generation tokens fail rendering.
3. Re-export shared canvases and replace their attachments to use automatic discovery in 0.2.0.
   Old ZIP filenames are no longer recognized by discovery; existing archives can still be
   imported manually.
4. Run `prepare` again for updated generation prompts, using `--force` for an existing canvas.
   Restart the server after configuration changes.
