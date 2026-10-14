# The gallery

Real pull requests from open-source projects, each drawn with one technique at its best, at
the 1120 px a tour page gives a picture. Draw the entries you want to see with
`pr-review tour gallery <slug> [<slug>…]`, which prints the path of each picture, and look at
the pictures before reading the HTML: the picture is the lesson, the HTML is how it was built.
Copy the craft, never the content: your tour draws its own change.

## Scenes

### `architecture`

`architecture.scene.html`

**PR:** [vitejs/vite#20916](https://github.com/vitejs/vite/pull/20916), "feat: forward browser console logs and errors to dev server terminal" (merged 2026-03-05, +994 −14).

**What it does:** Vite's dev server can now send browser errors, unhandled rejections, and `console.error` / `.warn` calls back over the existing HMR WebSocket, and print them in its terminal with a source-mapped stack. `server.forwardConsole` turns this on by itself when a coding agent is detected.

**Why this technique:** The idea is one sentence: browser errors now travel back to the dev server over the HMR socket it already had. That is a boundary and a new direction across it, which only a system diagram with the boundary drawn can show.

**Craft notes to copy:**

1. **Draw only the parts on the error's path.** Two zones (browser tab, dev server), the socket between them, and four boxes: `src/main.ts`, the new client half, the new server plugin, and the terminal. The config option, the injected define, the agent detection, and the source-map helpers are real, but they are not the idea, so they go in the prose.
2. **One hero: the new lane.** The socket is two gray rails with its old lane (`update · full-reload`, thin, pointing to the browser). The new `vite:forward-console` lane is the one thick green arrow, with a glow, running the other way from sender to receiver.
3. **One error flows through.** The same `throw new Error('this is test error')` starts in `main.ts` and ends as the terminal's real output from the PR's docs. The figure is a static inline SVG with a second, portrait copy for phones (`@media (max-width: 40rem)`), where the socket runs top to bottom.

### `lineage`

`lineage.scene.html`

[Refactor content streams](https://github.com/encode/httpx/pull/1296) (merged 2020-09-18, head `07062aa`)

**What it does.** It deletes `httpx/_content_streams.py` (395 lines) and splits it between `_content.py`, where the stream classes become plain `encode_*` functions, and `_multipart.py`, where `DataField` and `FileField` are pulled out of `MultipartStream`. Three copies of the same content handling (in `PlainByteStream`, `encode_request`, and `encode_response`) are merged into one new `encode_content`.

**Why a lineage map.** The one idea is "three copies became one function". A lineage map draws where code came from and where it went, so three old rows with arrows that meet at one new row says that idea before the reader reads a word.

**Craft notes**

- **Draw the idea, not the whole file.** The PR moves about fifteen symbols. The figure keeps the three sources and the one target and leaves out the rest (`MultipartStream`, the `encode_*` functions that were classes, the test rename). Those moves are real, but they are other ideas, and the prose can name them.
- **Let repetition show the duplication.** Each old box carries the same short label, `bytes → Content-Length`. The reader sees the same words three times and knows they were copies. The old boxes are dashed and red because the file is deleted. The green arrows and the glowing `encode_content` are the one hero.
- **One concrete example.** The new box shows `"hello" → Content-Length: 5`, which is what `encode_content("hello")` returns. On a phone the three sources stack and join a single spine that points down at `encode_content`.

### `sankey`

`sankey.scene.html`

[Move comparison helpers to their own files out of `assertion/util.py`](https://github.com/pytest-dev/pytest/pull/14520) (merged 2026-05-25, head `7a1c94e`)

**What it does.** It splits the 702-line `src/_pytest/assertion/util.py` into eight new modules (five `compare_*` files and three helpers: `_guards.py`, `_typing.py`, `highlight.py`) and leaves `util.py` with 188 of its old lines. The only rewrite turns the five `elif op ==` set branches in `assertrepr_compare` into a `SET_COMPARISON_FUNCTIONS` table.

**Why a Sankey.** A reviewer of a split asks two things: how much went where, and did any of it change on the way. Ribbons sized by line count answer both. The one rewritten strand shows up in amber against the gray of the code that only moved.

**Craft notes**

- **Group the destinations.** Eight new files would make eight ribbons that say the same thing. The figure groups them by what they hold: `compare_* · 5 files` (421 lines) and `helpers · 3 files` (68 lines). With `util.py` (188 kept) and the 11 dropped imports, that makes five ribbons. 188 + 14 + 421 + 68 + 11 = 702, so every number still adds up.
- **Sort so the ribbons never cross.** The source bar is in destination order, not file order, so each ribbon runs straight across. Crossings would show how the old file was laid out, and that is not the idea.
- **Gray for moves, amber for the rewrite.** Code that only changed homes is unchanged code, so it is muted, and the big ribbon says just "moved as is". The 14-line amber ribbon is thin, so it gets a glow and the only colored label, `SET_COMPARISON_FUNCTIONS · was 5 elif`. On a phone the same figure is drawn narrower, with the labels to the right of the bars.

### `heatmap`

`heatmap.scene.html`

[Switch follow redirects default](https://github.com/encode/httpx/pull/1808) (merged 2021-09-13, head `9f5f582`)

**What it does.** It renames `allow_redirects` to `follow_redirects` across the client API and flips the default from `True` to `False`. `Client` and `AsyncClient` gain the argument. Tests that relied on redirects now pass `follow_redirects=True`, and the docs explain the new default.

**Why a heatmap.** The 378 changed lines look like a rename, and the behavior change hides inside 24 of them. One square per changed line, one strip per top-level directory, shows where those 24 sit. It also shows what the rest of the diff is: gray renames in `httpx/`, and green tests and docs that follow the new default.

**Craft notes**

- One hero: the 24 amber squares glow and pulse, and everything else is pale. The squares keep diff order, so the regular amber pairs in `httpx/` are the nine `_api.py` signatures, one after another. The squares were classified from the diff and add up to the PR's 378 (160 + 84 + 134).
- Label each strip directly, at its right, in its own tone ("24 change behavior", "74 opt back in", "27 old default, removed"). Then no legend table is needed. Gray is explained once ("136 rename only") and reads as context everywhere else.
- The only code is two tokens: `True` → `False`, plus the one argument the tests add. The old file list with +/− counts and per-file captions is gone, because the directory and its line count say enough. On a phone each label drops under its strip.

### `dependency-matrix`

`dependency-matrix.scene.html`

**PR:** [vercel/next.js#82844](https://github.com/vercel/next.js/pull/82844), "[types] refactor shared types" (merged 2025-08-20, 68 files, +442 −392).

**What it does:** It moves the App Router types that client and server both use (21 exports, such as `FlightRouterState`) out of `server/app-render/types.ts` and `app-router-context.shared-runtime.ts` into a new `shared/lib/app-router-types.ts`. Client code then stops importing a server module, and `browser-chunks.test.ts` ("must not bundle any server modules into browser chunks") passes.

**Why this technique:** The PR is 68 files that each re-point an import or two. A file list hides the pattern, and a graph of the edges is a hairball. A matrix of who imports what shows the whole PR as one column emptying and one new column filling.

**Craft notes to copy:**

1. **Keep only the two columns that changed.** Three rows (client, shared, server) and two columns (the old server module and the new shared one) make six cells. The real matrix has 8 × 8 groups, but the other cells did not change and do not carry the idea. A bracket marks the two rows that ship in browser chunks, because that is why the client cell matters.
2. **Write the change in the cell.** A removed count reads `40 → 0` with the old number struck, in a dashed red cell. A new count is a plain green number, and a count that only dropped (`19 → 13`, server code) is amber. The glowing `client` cell is the hero: it is the import the browser test forbids. The cells come from counting import statements at the PR's base and merge commits, with tests left out.
3. **Put the example with its column.** Under the new column's header, a `FlightRouterState` chip and "+ 20 types moved here" tell the reader what the new imports point at. The two value imports of a `const enum` are left out. They matter in review, but they are a second idea for the prose. On a phone the grid keeps its shape with narrower columns, and the file names wrap at `/`.

### `impact-map`

`impact-map.scene.html`

**PR:** [vitest-dev/vitest#5876](https://github.com/vitest-dev/vitest/pull/5876), "fix(expect)!: check more properties for error equality" (merged 2024-12-10).

**What it does:** Vitest's deep equality no longer compares two `Error`s by `message` alone. A new `isErrorEqual` checks prototype, name, message, `cause`, `AggregateError.errors`, and own enumerable props. `toThrowError(new Error(…))` now uses the same equality.

**Why this technique:** The logic change is small and sits at the bottom of the call graph, but every matcher that calls `equals()` gets it. An impact map shows that reach: a few callers fanning into one changed function. A diff of `jest-utils.ts` cannot show it.

**Craft notes to copy:**

1. **A few callers stand for the fan.** Four matchers (`toEqual`, `toStrictEqual`, `toHaveBeenCalledWith`, `toThrowError`) and a gray "+ 14 more calls" show how wide the reach is without listing 18 call sites. Unchanged callers and their wires are gray. `toThrowError` is amber, and its wire is the one green "new call".
2. **One hero inside the changed function.** `equals(a, b)` is a plain box. The new `isErrorEqual` inside it glows green, with what it compares in four words (`name · message · cause · props`). The removed rule, `a.message === b.message`, sits struck out below the box, not mixed in.
3. **One example, one verdict.** A small card takes the PR's own test case (`MyError('hi', 'a')` vs `MyError('hi', 'b')` under `toEqual`) and shows `before ✓ now ✕`. The diff it prints, the one-way `cause` rule, and Vitest's own changed assertions go in the prose. On a phone the callers stack and their wires join two trunks (gray and green) down to the function.

### `storyboard`

`storyboard.scene.html`

[Denormalized number of orders placed by the user](https://github.com/saleor/saleor/pull/17859) (merged 2025-06-25, head `e538c2d`, BSD-3-Clause)

**What it does.** It adds `User.number_of_orders` and backfills it with a Celery task that queues itself batch by batch after migrate. The count goes up in `order_created()` (and per user in `orderBulkCreate`), and it goes down when expired orders are deleted.

**Why this technique.** A denormalized counter is one idea spread over every write path: each path that changes the truth must change the count too. Four panels, one per step (add, backfill, count, uncount), follow one user's count through them, so the reader sees the counter stay true.

**Craft notes**

- One toy example runs through every panel: `customer_user` and their orders, with the count going 0 → 1 → 2 → 1. The last step is the PR's own test (2 → 1 when `order_2` expired and was deleted). Each panel is the same tiny picture: a 2–4 word title, the orders as chips, the count in a circle, and the one function name under it. Files, +/− counts, code, and checklists are left to the prose.
- The change grammar sits on the chips: the new column and the new order are green, the deleted order is red, dashed, and struck. The top edge says what the step is: green for new code, amber for a path that changed.
- One hero: the count after `order_created()`, the hot path every new order takes, with a thicker ring and a glow. The other counts keep a thin ring.

### `sequence`

`sequence.scene.html`

[sync: preserve FIFO lock order when coop budget is exhausted](https://github.com/tokio-rs/tokio/pull/8371)

**The change.** `Acquire::poll` used to check the task's coop budget before calling `semaphore.poll_acquire`, so a task with no budget left returned `Pending` without joining `waiters.queue`, and a later task could take the lock first. The fix calls `poll_acquire` first and checks the budget only once the permit is `Ready`.

**Why a sequence diagram.** The bug is about order: t_a asks for the lock before t_b but gets it after. Lifelines read top to bottom as time, so "who asked first" and "who was woken" sit on one page. Two copies of the same small diagram, before and after, show the one message that changed.

**Craft notes to copy.**

- Keep only the actors the reorder needs: t_a, t_b, and the `Mutex` with its queue beside it. t0 is a three-word note, "held by t0", not a lifeline, and the PR test's six steps become three messages. The budget, the permit count, and the test's assertion go in the prose.
- One hero: t_a's `lock()` with its budget spent. Before, it is a dashed red arrow that ends in ✕ short of the `Mutex`, and the queue stays `[ ]`. After, it is a thick green arrow that lands, and the queue reads `[t_a]`. The last arrow, `wake t_b` against `wake t_a`, follows from it without a verdict banner.
- The queue state is the toy data: `[ ]`, `[t_b]` against `[t_a]`, `[t_a, t_b]`. Every label is a call or a value, at most four words.

### `control-flow`

`control-flow.scene.html`

**PR:** [rails/rails#48600: Active Record commit transaction on `return`, `break` and `throw`](https://github.com/rails/rails/pull/48600)

**What it changes:** A `transaction` block left through `return`, `break`, or `throw` now commits when `commit_transaction_on_non_local_return` is true, which is the `load_defaults 7.1` default. With the setting false, it still rolls back, now with a deprecation warning.

**Why this technique:** The change is one new step before a decision, and it sends one exit to the other branch. A flowchart with one diamond and two outcomes shows that in a glance: the same chart twice, the route moving from ROLLBACK to COMMIT.

**Craft notes:**

- Draw the textbook shapes: a rounded start, one rectangle for the new step, one diamond, two outcome boxes. The real `ensure` chain has five checks (exception, aborting thread, two `written_indirectly` cases); only `completed?` decides this route, so the others go in the prose.
- The toy input is the start node itself, `save; return`, so the reader follows one block. The before chart leaves an empty gap where the new step lands in the after chart, and the layout does not move.
- One hero per panel: the dashed red `no` route to ROLLBACK before, the thick green route from `completed = true` to a filled COMMIT after. The setting shows as two small words in the new box, `load_defaults 7.1`, not as a table.

### `state-machine`

`state-machine.scene.html`

**PR:** [nodeshift/opossum#389: Fix stuck halfOpen when using errorFilter](https://github.com/nodeshift/opossum/pull/389)

**What it changes:** If the one trial call in half-open fails with an error that `errorFilter` ignores, the breaker now emits `'success'` and closes. Before the fix, `fail()` returned early, so the breaker stayed half-open with no timer, and every later `fire()` was rejected.

**Why this technique:** The bug was a state with no way out, and a state diagram is the picture that shows a way out. The three breaker states every reader already knows, plus one new arrow, carry the whole fix.

**Craft notes:**

- Three states and five arrows, as a textbook draws a circuit breaker: `closed`, `open`, `half-open`, with `failure`, `resetTimeout`, and `success` in gray. The `pendingClose` flag, the half-open → open failure edge, and the event names stay in the prose.
- One hero: the green arrow from half-open to closed, labeled with the PR test's own call, `fire(400)` and `filtered`. The old behavior is a dashed red self-loop under half-open, labeled `stuck here` and struck through, so new and removed sit next to each other.
- A static SVG with a `viewBox` and fixed label positions is enough for three nodes. On a phone the labels get a larger font size so they stay readable after the picture scales down.

### `trace`

`trace.scene.html`

[Improve commits list performance to reduce unnecessary database queries](https://github.com/go-gitea/gitea/pull/33528)

**The change.** Rendering a page of commits looked users up one email at a time: `GetUserByEmail` ran once per author and again for every commit's committer, at 2 queries each. Now `ValidateCommitsWithEmails` and `ParseCommitsWithSignature` each collect the page's emails and make one `GetUsersByEmails` call: 3 `IN (…)` queries, however many commits there are.

**Why a trace.** The PR is an N+1 fix, and its claim is a count under a workload. Two runs drawn as tick strips on one query axis show that claim and nothing else: 106 faded red ticks, then 6 glowing green ones.

**Craft notes to copy.**

- One scale for both runs, counted in real units: queries, from reading the code, not invented milliseconds. The workload is the toy example, named once above the strips: one page of 50 commits (`CommitsRangeSize`), e.g. by 3 authors. That gives 3 + 50 calls at 2 queries each, or 106.
- Leave out what the idea doesn't need. The call frames, the zoom lens, and the unchanged `GetLatestCommitStatus` per commit all belong in the prose. Each strip has only its function name, a label that multiplies out to its total (`53 calls × 2 queries`, `2 calls × 3 queries`), and the total at the end of the strip.
- Let the ticks show the multiplication. The queries of one call sit close together, and a wider gap ends the call: pairs before, triples after. A reader counting ticks against the label never finds ticks the label doesn't explain.
- The hero is the short strip. It glows, and its number is the biggest thing in the figure. The long strip is the removed path: faded, with its function name struck through. The empty width after the 6 shows the saving, so it needs no box or label.

### `data-flow`

`data-flow.scene.html`

[reverseproxy: Implement trusted proxies for `X-Forwarded-*` headers](https://github.com/caddyserver/caddy/pull/4507)

**The change.** `reverse_proxy` used to keep whatever `X-Forwarded-For` the client sent and append the client's address to it. Now `addForwardedHeaders` keeps prior values only when `req.RemoteAddr` is in the new `trusted_proxies` list. For any other client it writes the header from the connection. `X-Forwarded-Proto` and `X-Forwarded-Host` get the same rule.

**Why a data-flow diagram.** The bug is about where a value comes from: a header anyone can forge reached the upstream app as if Caddy had vouched for it (issue #4503: a crawler's fake `X-Forwarded-For` values spoiled a backend's statistics). One forged value, followed from client to upstream, shows the hole, and one gate in its path shows the fix.

**Craft notes to copy.**

- **One header is enough.** Proto and Host follow the same rule, so drawing all three only repeats it three times. The figure follows `X-Forwarded-For: 198.51.100.7` from a client at `203.0.113.9`, and the prose names the other two headers.
- **The same small picture twice.** Before and after are the same three boxes (client, Caddy, upstream app) at the same positions. Before: the forged value flows through in red dashes and lands struck out in the upstream's value. After: its wire ends in ✕ at a green `trusted_proxies` bar, the one hero, and an amber `RemoteAddr` wire carries the value that now wins.
- **Mark untrusted input by its border.** The client's header sits in a dashed chip, so "anyone can write this" needs no caption. The figure is a static inline SVG, with a stacked portrait copy for phones.

### `schema`

`schema.scene.html`

[Replace `PageRevision` with generic `Revision` model](https://github.com/wagtail/wagtail/pull/8441) (merged 2022-05-17, head `83e49d0`, BSD-3-Clause)

**What it does.** It renames `wagtailcore_pagerevision` to `wagtailcore_revision` and replaces its `page` foreign key with a generic pointer: `object_id` (now a `varchar(255)`) plus two foreign keys to `django_content_type`. Migration 0071 fills `content_type` from each revision's own JSON and `base_content_type` with the Page content type, and 0072 makes both NOT NULL.

**Why this technique.** The change is a relationship that changes kind: a foreign key the database enforced becomes a pointer matched as text. An ER diagram of just the three tables and three columns involved shows that shift, with one row traced through it.

**Craft notes**

- Draw only the columns the migration moves. The revision table has three rows: `object_id` (amber, with `page_id` struck before it) and the two new content type columns (green). The other six columns, the indexes, and the four foreign keys that only follow the rename are left out.
- The changed relationship is drawn twice between the same two columns: the dropped FK as a faded red dashed arc, and the new pointer as the glowing amber dotted hero. Each has a two-word label on the wire ("FK dropped", "matched as text").
- Toy data instead of types: the revision of page 7 "About us" from the test fixture. `"7"` sits in `object_id` and `7` in `page.id`, so the text match is visible. The content type rows are named (`tests.simplepage`, `wagtailcore.page`) rather than given made-up ids. The phone draws its own stacked SVG, with the wires in the side gutters.

### `scenario-matrix`

`scenario-matrix.scene.html`

**PR:** [expressjs/express#4212: Throw on invalid status codes](https://github.com/expressjs/express/pull/4212)

**What it changes:** `res.status()` now throws a `TypeError` when the code is not an integer and a `RangeError` when it is outside 100 to 999. Before, a string like `"410"` was sent with a deprecation warning, and an out-of-range code failed later, inside Node, at `.end()`. `res.sendStatus()`, `res.redirect()`, and the 304 path go through `res.status()` too.

**Why this technique:** This is a validation change, and its whole effect is "this input, that outcome." A small grid of inputs against before and after shows which input changed its HTTP status and which only changed who throws.

**Craft notes:**

- Keep only the rows that tell the story, one per kind of outcome: `201` (unchanged, gray), `"410"` (410 becomes 500), and `99` (still 500, but `res.status()` throws now). The other test inputs (`410.1`, `1000`, `undefined`, `null`) repeat one of these rows, so they go in the prose.
- Each cell is a big status number and a 1–3 word label (`sent`, `TypeError`, `Node throws at .end()`), not the full error message. The status column alone shows the pattern.
- The change grammar is on the cells: the old `410` is red, dashed, and struck; the new `500` is green; "same status, new thrower" is amber. The one hero is the `"410"` row's new cell, the case the old suite asserted would send 410.

### `ui-journey`

`ui-journey.scene.html`

[feat: change collab trigger & add share dialog](https://github.com/excalidraw/excalidraw/pull/7647) (merged 2024-02-03, head `8b19f3c`, MIT)

**What it does.** The top-right users-icon button becomes a "Share" button (only an icon below 830 px wide). It opens a new Share dialog that offers live collaboration or a read-only shareable link. The main menu and the welcome screen open the same dialog with only its collaboration half, and the padlock illustration is removed.

**Why this technique.** The PR is about how many clicks a link takes ("Many users don't know we support collaboration"). The same path drawn twice, before above after, shows the read-only link going from three clicks to two.

**Craft notes**

- Draw one journey only: canvas → ☰ main menu → Save to... → link, against canvas → Share dialog → link. The other entry points (welcome screen, menu item), the session dialog, and the removed padlock do not change the click count, so they go in the prose.
- Each screen is a small sketch of the real UI with its real labels, two or three items, and a numbered badge on the clicked item. The after row keeps the before row's columns, and one long arrow crosses the empty third column, so the saved step shows as a gap.
- One hero: the new Share button, amber (it replaces the users icon) with a glow. The Share dialog is green because it is new; everything else is gray.

## Micro-worlds

### `trace-player`

`trace-player.micro.html`

[sindresorhus/p-retry#96 · options.shouldConsumeRetry](https://github.com/sindresorhus/p-retry/pull/96) (+446 −70, merged 2025-10-09)

**What changed.** A new `shouldConsumeRetry(context)` hook lets a failure retry without using up `retries` or growing the backoff. The loop now counts `retriesConsumed`, and `retriesLeft` and `calculateDelay` follow that count instead of `attemptNumber`.

**Why a trace.** The change is about which counter moves on which line. The reader has to watch `attemptNumber`, `retriesConsumed`, and `retriesLeft` drift apart one step at a time, and see that a failure that doesn't count also skips the `setTimeout`. The run is the one in the PR's test "skipped attempts do not impact backoff".

**Craft to copy**

- **Record first, then play it back.** The model runs once and calls `emit(line, from, to, label, why, changedState)` on each line that matters. The step buttons and the scrubber only pick an index into that array, so the code highlight, the state cards, the arrow, and the run strip always agree. Cards whose value changed on this step are tinted.
- **The outcome is on screen at rest.** Below the trace sits the whole run as a strip of attempts, with each gap scaled to its wait. Under it is the same run on the old code, dashed. Before any stepping, the reader sees "5 attempts, #1 free, waits 100/200/400" against "4 attempts". The current attempt gets a ring, and the page opens on the step where the new hook returns `false`.
- **Messages are arrows between the real boxes.** Each arrow is measured with `getBoundingClientRect`, so it survives the phone layout, where it runs vertically and its label sits on the lower box's corner. It is labeled with what the call returns (`→ false`, `100 ms`). The hero actor, the new hook, has the thicker border and the thicker arrow. Code lines show the change grammar as gutter bars (green added, amber changed) and struck dashed lines for what was removed, so "the line that runs" and "the line the PR added" read together.

### `before-after`

`before-after.micro.html`

[date-fns/date-fns#2616 · `intervalToDuration` fix for end of month calculations](https://github.com/date-fns/date-fns/pull/2616) (+205 −52, merged 2022-02-07)

**What changed.** `intervalToDuration` now steps forward from `start` with `add()` and calls `differenceInMonths(end, remainingMonths)`. Before, it used `sub()` and `differenceInMonths(remainingMonths, dateRight)`. It also throws a `RangeError` when start is after end, where before it turned the interval around with `sign` and `Math.abs`.

**Why a twin.** The fix swaps which date goes first into a helper that isn't symmetric. Nothing in the diff looks wrong on its own. Only the same interval run through both versions, row by row, shows where they part (`months`: 0 against 1 for Aug 31 → Sep 30) and why: `differenceInMonths`'s end-of-month rules look at `dateLeft`, which used to be the start date and is now the end date. The presets are the PR's test cases (issues 2611, 1778, 2910, 2470, and start after end).

**Craft to copy**

- **Mirror the two versions around a shared spine.** Old code goes on the left in a dashed red frame, new code on the right in a solid green frame, and the variable names run down the middle. Each row is then one comparison: the code expression is small and gray, the value is large. Every row that differs is tinted amber, and only the first one (the cause) gets the ring and the large value, so the eye skips the downstream rows that differ as a result.
- **Compute the explanation instead of writing it.** The model's `differenceInMonths` logs the branches it takes (the late-February rule, where `dateLeft` lands, the last-day-of-month rule). A prose row renders that log for each side: "dateLeft is Aug 31, 2021, the start date… lands on Oct 1, 2021, after Sep 30, 2021: the last month is not full. 1 − 1 = 0". It stays true for any dates the reader picks.
- **Help the reader find the inputs that differ.** Both models run on every start date in the year against the next 367 end dates, drawn as a 12 × 31 heat calendar. The 29th–31st columns and Feb 28 light up: "73 of 133,955 intervals differ". A second calendar shows which end dates differ for the chosen start. Clicking a cell sets the input, so the reader can move from the pattern to a single case in one click.

### `race-lab`

`race-lab.micro.html`

[vercel/swr#1970 · Fix race conditions related to optimistic UI](https://github.com/vercel/swr/pull/1970) (+76 −9, merged 2022-05-15, fixes #1965)

**What changed.** A second optimistic `mutate` can start while the first is still in flight. When that happens, the second now remembers the data from before any optimistic write (the new `_o` field) as its rollback target. Before, it remembered whatever was on screen, which was the first mutation's optimistic value. So when both requests failed, the page kept showing data that never saved.

**Why a race lab.** The bug exists only when the two requests overlap. Drag "mutate #2 starts at" past "mutate #1 fails after" and the phantom value disappears. Shorten #2 so it fails first, and the new code drops #1's optimistic value while #1 is still in flight. Turn off `revalidate` and the phantom stays for good. The timing is the lesson, so the timing is the controls. Defaults come from the PR's test: data 0, optimistic 1 and 2, #2 starts at 10 ms, each request fails after 20 ms, and the refetch returns 0 after 20 ms.

**Craft to copy**

- **Simulate the race; don't hand-draw it.** A small discrete-event loop runs the transcribed old and new `internalMutate`, plus the hook's revalidation discard rules, on the same inputs. Timers are ordered by time, then by when they were set, as `setTimeout` orders them, and a `getTimestamp` counter works like SWR's. The lanes are drawn from the loop's log, so every slider position shows what the code would do, including cases the author never thought of.
- **Mark the hazards in the lanes themselves.** The overlap window is shaded amber. A discarded request is dashed and faded. A value on the page that no in-flight request explains is hatched red. Each lane's caption states its outcome with numbers ("fails at 30 ms: rolls back to 1 before, 0 after"; "1 for 20 ms after both POSTs failed"), so the picture reads at rest without a closing banner.
- **Rest on the moment that matters.** The playhead stops where the phantom first appears (30 ms by default), and the two page windows show what the user sees at that moment: `data: 1` in red against `data: 0`. The sweep plays once on load and then holds. Clicking the timeline moves the playhead, so the reader can inspect any instant.

### `state-explorer`

`state-explorer.micro.html`

**PR:** [prisma/prisma-engines#3391](https://github.com/prisma/prisma-engines/pull/3391), "qe: improve error messages for closed transactions" (Apache-2.0, 247 changed lines)

**The change.** Before, the cache of closed transactions stored `()`, so every refused call said "cannot be executed on a closed transaction.." (with the double period). Now it stores how the transaction closed (`ClosedTx::Committed`, `RolledBack`, or `Expired { start_time, timeout }`), so a query, commit, or rollback on a closed transaction names its state, and an expired one also gives the timeout and how long has passed. "Transaction not found" is longer too, and the unused `CachedTx::Aborted` is gone.

**Why this technique.** You only see the change by driving a transaction into a closed state and then firing an event the engine refuses. A state explorer lets the reader reach each closed state, cause each refusal, and watch the expired message's elapsed time grow as the clock runs.

**Craft notes to copy.**

- **Show each refusal in two places.** A `✕ commit refused · P2028` badge goes on the node that refused (the where). The full error goes in the log (the what). In the log, the part of the message the PR changed is in amber, found by taking the common prefix with the old message, and the old message is struck through under it. Every refusal is a before/after comparison without a toggle.
- **Draw the states inside the structure that holds them.** Zones for the `clients` map, the `closed_txs` LRU, and "neither map" make `get_client`'s lookup order the layout itself. The changed type sits in the hero zone's header: `LruCache<TxId, ~~()~~ Option<ClosedTx>>`. The removed `Aborted` variant stays visible, drawn dashed, faded, and struck through.
- **Model what the message depends on, and start from the PR's test.** The default state replays `tx_expiration_cycle` (timeout 1000 ms, commit at 1500 ms), so the refusal is already drawn. A simulated clock plus "wait 500 ms" shows that the elapsed time is measured at the refused call. The wires are computed from the laid-out boxes with a ResizeObserver: curves on a desktop, a side bus on a phone.

### `record-bench`

`record-bench.micro.html`

**PR:** [rails/rails#43945](https://github.com/rails/rails/pull/43945), "Add `ActiveRecord::Base::normalizes`" (MIT, 292 added lines)

**The change.** `normalizes :email, with: -> email { email.strip.downcase }` wraps the attribute's type in `NormalizedValueType`. The value is normalized right after it is cast, so validations and the database see the normalized value. Finder keyword arguments get the same normalization. A SQL string does not, and `nil` is skipped unless `apply_to_nil: true`.

**Why this technique.** The change is a transformation applied stage by stage to one record's values. Its surprises (a keyword lookup matches but a SQL string with the same text does not, and `nil` passes through) only land when the reader types their own messy value and watches which stage changes it and which one rejects it.

**Craft notes to copy.**

- **Make the invisible visible.** Whitespace is drawn as glyph pills (`␣`, `\n`, `\t`). The normalize cell is a character diff of its input: removed characters struck through in red, characters whose case changed in amber, and a count ("2 removed, 23 lowercased").
- **Repeat a value only where it changes.** The context stages (cast, validations) are narrow, muted, and in words ("a String stays a String", "the normalized value"). The eye goes to the glowing green normalize column, the stored row, and the database verdict.
- **Add a lookup lane under the record lanes, on the same stage columns.** A bracket header, `NormalizedValueType#cast: normalize(super(value))`, spans cast and normalize. The keyword finder visibly passes through the same type, and the SQL-string form hatches those stages out and ends in a red `false`. The inputs are Ruby literals (`"…\n"`, `nil`), typed as they would be in a console, which opens the `nil` branch. The defaults are the PR's own CHANGELOG example.
