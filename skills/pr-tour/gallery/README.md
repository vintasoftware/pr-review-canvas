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

**What it does:** Vite's dev server can now send browser errors, unhandled rejections, and `console.error` / `.warn` calls back over the existing HMR WebSocket and print them in its terminal with a source-mapped code frame. `server.forwardConsole` turns this on by itself when `@vercel/detect-agent` sees a coding agent.

**Why this technique:** The change adds parts and connections on both sides of a boundary that already existed (browser tab and Node, joined by the HMR socket). Only a system diagram with that boundary drawn shows the real news: the old socket now carries traffic the other way.

**Craft notes to copy:**

1. **Draw the boundary as a band with lanes.** The unchanged lane (`update · full-reload`, pointing to the browser) stays gray, so the new lane pointing the other way reads as the change at once. The hero wire runs straight through its lane, one line from sender to receiver, instead of stopping at the band's edge.
2. **One row per moment, each flowing its own way.** The startup path (`server.forwardConsole` → `clientInjections` → `client.ts`) runs right to left along the top. The runtime path (throw → capture → socket → plugin → terminal) runs left to right below it. Arrowheads carry the direction, so no legend is needed. The scene ends where the output lands: the real terminal output from the PR's docs.
3. **HTML boxes on a CSS grid; wires from a script.** The zones are grid items that overlap behind the nodes. Wires are SVG paths computed from `getBoundingClientRect()` and redrawn by a `ResizeObserver`. On a phone the grid reflows to two columns, and the two wires that would cross boxes go around the margin instead (a per-wire `'L'`/`'R'` hint).

### `lineage`

`lineage.scene.html`

[Refactor content streams](https://github.com/encode/httpx/pull/1296) (merged 2020-09-18, head `07062aa`)

**What it does.** It deletes `httpx/_content_streams.py` (395 lines) and splits it between `_content.py`, where the stream classes become plain `encode_*` functions, and `_multipart.py`, where `DataField` and `FileField` are pulled out of `MultipartStream`. Three copies of the same content handling (in `PlainByteStream`, `encode_request`, and `encode_response`) are merged into one new `encode_content`.

**Why a lineage map.** Every symbol has a different fate: moved as is, pulled out of a class, turned from a class into a function, or split into branches that merge elsewhere. The reviewer's question is which of them to read. A map from each symbol to its new form, with that fate written on it, answers that question in one look.

**Craft notes**

- **Open functions into their branches.** `encode_request` is drawn with its five branches as sub-rows (`content`, `data + files`, `data`, `files`, `json`), and `PlainByteStream` with its `get_headers()`. Extractions and merges then have a real source row. One arrow from a whole function to four new ones would hide the refactor.
- **Write the fate on the target row, not on the arrow.** Each new row says what happened to it: "was a class", "2 branches merged", "63 → 31 lines · only picks an encoder", "renamed · 99% similar". Eighteen arrows never fight their labels. An arrow takes its target's tone, plain edges are drawn first, and merges are drawn on top.
- **The hero is the merge point.** Three thick arrows from three far-apart rows meet at one glowing `encode_content`, and a reader sees "duplication removed" before reading a word. The rows are HTML. A script measures their laid-out boxes to route the curves and redraws when the width changes, so the same markup works at 1120 px and at 360 px.

### `sankey`

`sankey.scene.html`

[Move comparison helpers to their own files out of `assertion/util.py`](https://github.com/pytest-dev/pytest/pull/14520) (merged 2026-05-25, head `7a1c94e`)

**What it does.** It splits the 702-line `src/_pytest/assertion/util.py` into eight new modules (`_guards.py`, `_typing.py`, `highlight.py`, `compare_text.py`, `_compare_sequence.py`, `_compare_any.py`, `_compare_set.py`, `_compare_mapping.py`) and leaves `util.py` with 200 lines. The only rewrite turns the five `elif op ==` set branches in `assertrepr_compare` into a `SET_COMPARISON_FUNCTIONS` table.

**Why a Sankey.** A reviewer of a split asks two things: how much went where, and did any of it change on the way. Ribbons sized by line count answer both. The one rewritten strand shows up against the gray of the verbatim moves.

**Craft notes**

- **Draw the source as the old file, top to bottom.** The left node is `util.py` as one tall bar in file order, with each segment's symbol names inside it and its first line number (`L151`, `L284`, …) beside it. The "before" then reads as the file's layout, and the ribbon crossings show the code being sorted into its new files. Two strands land on `_compare_any.py` and two on `compare_text.py` because those symbols sat far apart in the old file.
- **Make the numbers add up.** Each ribbon is the real count of removed lines. A script walked the base file's AST and gave every `-` line to its symbol, with blank separators going to the symbol after them. 702 = 188 kept + 489 moved + 14 rewritten + 11 dropped imports. Each destination bar is the file's real size: the lines that arrived, plus a green cap for the file's own new lines (imports, the table). A reader who checks one number finds it right.
- **Verbatim moves are gray, so the eye goes to the one change.** Code that only changed homes is unchanged code, so it gets the muted tone. The single amber ribbon (glow, slow pulse, labeled at both ends) is then the one thing to review. Right-column slots are `max(bar, label)` tall so labels never collide, and the left bar is centered against that taller column.

### `heatmap`

`heatmap.scene.html`

[Switch follow redirects default](https://github.com/encode/httpx/pull/1808) (merged 2021-09-13, head `9f5f582`)

**What it does.** It renames `allow_redirects` to `follow_redirects` across the client API and flips the default from `True` to `False`. `Client` and `AsyncClient` gain the argument. The tests that relied on redirects now pass `follow_redirects=True`, and the docs explain the new default.

**Why a heatmap.** The 378 changed lines (+218 −160) look like a rename, and the behavior change hides inside 24 of them: the `= True` became `= False` on the same lines that renamed the argument. A map of every changed line, colored by what that line does, shows the reviewer where to look. It also shows how much of the diff is the cost: green tests asking for redirects back.

**Craft notes**

- **One square per changed line, in diff order, in columns sized by lines.** The `httpx/`, `tests/`, and `docs/` columns are flex items whose `flex-grow` is their line count, so area is honest. Because the squares keep diff order, the pattern inside a file means something: the amber and gray stripes in `_api.py` are the nine signatures and their pass-throughs, one after another.
- **Color by what the line does, not by + or −.** Gray means same behavior (renamed, moved, or unrelated), amber is the flip, green is added for the new default, and red dashed is removed docs of the old default. The lines were classified one by one from the diff, and the legend counts (198 + 20 + 4 + 129 + 27) add up to the PR's 378.
- **Define the hero with the code before the map.** A large "24" and a four-line snippet of the real hero lines sit above the squares, toned like their squares. "Amber" means `allow_redirects: bool = True,` → `follow_redirects: bool = False,` before the reader scans a single cell. Only the hero squares glow and pulse.

### `dependency-matrix`

`dependency-matrix.scene.html`

**PR:** [vercel/next.js#82844](https://github.com/vercel/next.js/pull/82844), "[types] refactor shared types" (merged 2025-08-20, 68 files, +442 −392).

**What it does:** It moves the App Router types that client and server both use out of `server/app-render/types.ts` and `app-router-context.shared-runtime.ts` into a new `shared/lib/app-router-types.ts`. Client code then stops importing a server module, and `browser-chunks.test.ts` ("must not bundle any server modules into browser chunks") passes.

**Why this technique:** The PR is 68 files that each re-point an import or two. A file list hides the pattern, and a graph of the edges is a hairball. In a matrix the whole PR is one column emptying (`server/app-render/types`, 44 → 0 from client and shared rows) and one new column filling (69 imports).

**Craft notes to copy:**

1. **Group both axes by layer.** Put client, shared, and server bands on both axes, and bracket the rows that ship to the browser. The change grammar then reads like a map: the red column sits in server territory, the green one in shared. The two column totals under the matrix give the outcome in two numbers, so no banner is needed.
2. **Show numbers only where something changed.** Unchanged cells are gray dots sized by `log(count)`, so the 1,212 on the server diagonal is quieter than the 7 that matter. Removed cells are dashed, struck, and faded. A count that only dropped is amber, with the old number struck small in the corner.
3. **Count it, and say what kind of import each one is.** The cells come from a script run over the PR's base and merge commits, with tests left out. The script also tells type imports from value imports: a `2v` badge and the one glow mark the two value imports of the `const enum HasLoadingBoundary`. A bundler keeps value imports and erases `import type`, which is why those two cells matter.

### `impact-map`

`impact-map.scene.html`

**PR:** [vitest-dev/vitest#5876](https://github.com/vitest-dev/vitest/pull/5876), "fix(expect)!: check more properties for error equality" (merged 2024-12-10).

**What it does:** Vitest's deep equality no longer compares two `Error`s by `message` alone. A new `isErrorEqual` checks prototype, name, message, `cause` (only when the expected error has one), `AggregateError.errors`, and own enumerable props. `toThrowError(new Error(…))` now uses the same equality.

**Why this technique:** The logic change is +41 −4 lines in `jest-utils.ts`, at the bottom of the call graph. Its reach is every matcher that calls `equals()`. An impact map shows the whole fan of unchanged callers and the tests whose verdict flips, which a diff of `jest-utils.ts` cannot show.

**Craft notes to copy:**

1. **Lay the columns out from effect to cause and on to the output:** tests → callers → the change → what prints when it fails. Draw every unchanged caller in gray, and fold matcher families into one pill with a count (`×4`, `×6`). The reader sees how wide the fan is before reading a word.
2. **Put verdicts at the edge of the map.** Each test card says `before ✓ / now ✕` and why. The tests are taken from the PR's own tests and docs, including the one case that still passes (cause is one-way). The last panel is the real diff the first test now prints, and the cost shows up as two of Vitest's own assertions that had to change.
3. **Motion that means something.** A ripple runs from the changed function back out along the wires, hop by hop, to every caller. At rest the wires are gray, because that code is unchanged; only the one new call (`toThrow → equals`) is green, and only the new function glows. On a phone the callers share a single wire, and wires stay clear of the column labels.

### `storyboard`

`storyboard.scene.html`

[Denormalized number of orders placed by the user](https://github.com/saleor/saleor/pull/17859) (merged 2025-06-25, head `e538c2d`, BSD-3-Clause)

**What it does.** It adds `User.number_of_orders` and backfills it with a Celery task that queues itself batch by batch after migrate. The count goes up in `order_created()`, and in `orderBulkCreate` it goes up per user on commit. It goes down when expired orders are deleted.

**Why this technique.** A denormalized counter is one idea spread over every write path in 16 files. Four panels of intent (store, backfill, count, uncount) show that each path that changes the truth got a step, and show the one path that did not.

**Craft notes**

- Give each panel the picture its step needs: a table with the new column, a chain of batches, a fan-in with the delta per path, and a time axis over the test's expired orders. Keep the frame the same in every panel: a number, a top edge toned by the change grammar (green for new, amber for changed), and the files with their +/− counts at the bottom.
- Put the deltas from the tests in big type (+1, +2) and keep the unchanged path in the picture: `confirmAccount` → `match_orders_with_new_user()`, gray with a dashed ring, ±0. A counter drifts at the edge of the change, so draw that edge.
- Say what the code at the head does, even where it is wrong. The backfill's `.get(user.id)` returns None, not 0, for a user with no orders, no test in the PR runs the task, and #17882 fixed it. That goes in one amber "!" line in the checks, not in a banner.

### `sequence`

`sequence.scene.html`

[sync: preserve FIFO lock order when coop budget is exhausted](https://github.com/tokio-rs/tokio/pull/8371)

**The change.** `Acquire::poll` used to check the task's coop budget before calling `semaphore.poll_acquire`, so a task with no budget left returned `Pending` without joining `waiters.queue`, and a later task could take the lock first. The fix calls `poll_acquire` first and checks the budget only once the permit is `Ready`.

**Why a sequence diagram.** The bug is about ordering: two tasks poll in the order t_a, t_b and get the lock in the order t_b, t_a. Only lifelines and numbered messages show "who asked first" next to "who got it first". The scene follows the PR's own test, `mutex_fifo_with_coop_budget`, step for step.

**Craft notes to copy.**

- Draw both panels on one row grid: the same actors, the same six numbered steps, the same row heights. The eye reads across, and the only rows that differ are step 3 (t_a's poll) and step 6 (who is woken). A tinted band behind step 3 marks the step where the two runs split.
- Show the hidden state next to the messages. The `waiters.queue` column (`[ ]`, then `[t_b]`, against `[t_a]`, then `[t_a, t_b]`) explains the outcome before the wake arrow does. Activation bars show who holds the lock: t0 until `drop(g0)`, then the task that won.
- Draw a call that never happens as a dashed red arrow that ends in ✕ where it would have landed, with no arrowhead. Below each panel, put the test's own assertion as the verdict: `assert!(!t_b.is_woken())`, ✕ before and ✓ after.

### `control-flow`

`control-flow.scene.html`

**PR:** [rails/rails#48600: Active Record commit transaction on `return`, `break` and `throw`](https://github.com/rails/rails/pull/48600)

**What it changes:** A `transaction` block left through `return`, `break`, or `throw` now commits when `commit_transaction_on_non_local_return` is true, which is the `load_defaults 7.1` default. With the setting false, it still rolls back, now with a deprecation warning. The two `written_indirectly` branches are gone.

**Why this technique:** The change is one new line at the top of an `ensure` chain, and it reroutes a single exit path from ROLLBACK to COMMIT. Two flowcharts side by side, with their rows aligned, show exactly where the routes part.

**Craft notes:**

- Draw it as a metro map: a vertical spine with small diamonds (decisions), a square (the new action), and circles (start and end). Conditions in code sit to the left, and "yes" exits go right to outcome pills. The spine, markers, and arrows are pure CSS on grid cells, so there is no edge-drawing script to fail.
- The two panels are subgrids of one grid, so row N is the same height in both. A step that exists on one side only leaves an empty slot on the other side (blank before the new line, blank after the removed checks). The reader sees the added and removed steps as gaps.
- Follow one real input, the PR's CHANGELOG block with its `return` line highlighted, as a thick hero line. It is drawn in the text color (`--fg`) where both panels agree. It turns green from the new node onward, and it is red and dashed where the old route exits. Two dots ride the panels in step, one row per beat, so motion shows the moment they part.

### `state-machine`

`state-machine.scene.html`

**PR:** [nodeshift/opossum#389: Fix stuck halfOpen when using errorFilter](https://github.com/nodeshift/opossum/pull/389)

**What it changes:** If the one trial call in half-open fails with an error that `errorFilter` ignores, the breaker now emits `'success'` and closes. Before the fix, `fail()` returned early, so the breaker stayed half-open with `pendingClose: false` and no timer, and every later `fire()` was rejected.

**Why this technique:** The bug was a state with no way out, and only a state diagram shows that: the reader can see the dashed red loop that never leaves half-open, and the widened `'success'` edge that replaced it.

**Craft notes:**

- Nodes and edge labels are HTML in a CSS grid (`grid-template-areas`). After layout, a script reads each box and draws the SVG edges behind them, and every edge runs through or beside its own label. Text never collides, and the phone layout reflows into the same topology without a second drawing.
- Split a state where the change lives (half-open becomes `pendingClose: true` and `pendingClose: false`) so the trap is a box you can point at. Draw the change as an edge's condition: one amber `'success'` edge, with the old "resolved" clause in gray and the new clause tagged in green, which is truer to the code than adding a second edge.
- Under the diagram, the PR's own test is a four-step trace, with the real options and the before and after outcome in the last cell. While motion runs, a token rides the same path and lights each step. At rest, the trace alone still tells the story.

### `trace`

`trace.scene.html`

[Improve commits list performance to reduce unnecessary database queries](https://github.com/go-gitea/gitea/pull/33528)

**The change.** Rendering a page of commits looked users up one email at a time: `GetUserByEmail` ran once per author and again for every commit's committer, at 2 queries each. Now `ValidateCommitsWithEmails` and `ParseCommitsWithSignature` each collect the page's emails and make one `GetUsersByEmails` call: 3 `IN (…)` queries, however many commits there are.

**Why a trace.** The PR is an N+1 fix, and its claim is a count under a workload. Two icicle traces on one query axis make the claim visible: 106 red ticks become 6 green ones, and the after trace ends 100 queries earlier. The workload is one page of 50 commits (`CommitsRangeSize`), e.g. by 3 authors. The unchanged `GetLatestCommitStatus` per commit is kept gray in both traces, so the reader sees the next N+1 this PR leaves alone.

**Craft notes to copy.**

- One scale for both runs, counted in real units (queries, from reading the code), not invented milliseconds. Where the count depends on the data (a third status query only when a commit has statuses), draw that tick hatched instead of guessing.
- When the "after" is too thin to label at true scale, keep the true scale and add a zoom lens: a dashed trapezoid from the sliver to an inset that names every frame and every query (`email_address IN`, `user.id IN`, `user.lower_name IN`).
- Put the saving where the time went: a dashed green box fills the space the after trace no longer uses ("100 fewer queries"). A playhead moving at the same pace over both traces shows the after run finishing first.

### `data-flow`

`data-flow.scene.html`

[reverseproxy: Implement trusted proxies for `X-Forwarded-*` headers](https://github.com/caddyserver/caddy/pull/4507)

**The change.** `reverse_proxy` used to keep whatever `X-Forwarded-For` and `X-Forwarded-Proto` the client sent, and it passed `X-Forwarded-Host` through untouched. Now `addForwardedHeaders` keeps prior values only when `req.RemoteAddr` is in the new `trusted_proxies` list. For any other client it writes all three headers from what it saw on the connection: `RemoteAddr`, `req.TLS`, and `req.Host`.

**Why a data-flow diagram.** The bug is about where a value comes from: a header that anyone can forge reached the upstream app as if Caddy had vouched for it (issue #4503: a crawler's arbitrary `X-Forwarded-For` values spoiled the backend's statistics). Wires from each source to each upstream header show that origin directly. A single new gate, with three wires stopped at it, shows the fix.

**Craft notes to copy.**

- Use the same three columns in both panels: what the client sends, what Caddy knows, what the upstream reads. Use one lane per header, so the before and after rows line up. The client column has dashed borders, marking input anyone can write.
- Let the wires carry the change grammar. Removed flows are red and dashed into struck-out values. Blocked flows end in ✕ at the green `trusted_proxies` gate. The unchanged `RemoteAddr` flow is gray. The flow that now wins is amber (changed), and the brand-new `req.Host` flow is green.
- Draw the wires with a script that measures the laid-out chips (`getBoundingClientRect`) and redraws on resize, so the same markup works at 1120 px and at 360 px. Keep the text in HTML. The data that decides (the client's address feeding the trust check) gets its own thin wire.

### `schema`

`schema.scene.html`

[Replace `PageRevision` with generic `Revision` model](https://github.com/wagtail/wagtail/pull/8441) (merged 2022-05-17, head `83e49d0`, BSD-3-Clause)

**What it does.** It renames `wagtailcore_pagerevision` to `wagtailcore_revision` and replaces its `page` foreign key with a generic pointer: `object_id` (now a `varchar(255)`) plus two foreign keys to `django_content_type`. Migration 0071 fills `content_type` from each revision's own JSON and `base_content_type` with the Page content type, and 0072 makes both NOT NULL.

**Why this technique.** The change is a relationship that changes kind (a database-enforced FK becomes a pointer matched as text), plus a three-step row migration. An ER diagram over the same rows at each migration shows the new shape and how existing data reaches it.

**Craft notes**

- Draw the changed relationship twice between the same two columns. The dropped FK is a red dashed arc, and the new pointer is the glowing amber dotted line, labeled with what replaces the constraint ("matched as text, no constraint"). A dashed ghost box ("any other model") gives the reason for the change without inventing a caller: "no model but Page saves one yet".
- Show the migration as a filmstrip: the same two example rows (pages 4 and 7 from `test.json`), one card per migration, each cell toned by what that step did. Hatched means no column yet, a green outline means added but NULL, and filled green means populated. A dotted wire runs from the `"content_type"` key in each row's JSON to the cell 0071 fills, so provenance is the second hero.
- Mark stand-ins honestly. Content type ids are drawn as `⟨tests.eventpage⟩`, with a caption saying what `⟨x⟩` means, instead of made-up integers. The script computes the wires from element rects and re-routes them into a left gutter on a phone. On a phone the 0072 card folds into the 0071 card's label.

### `scenario-matrix`

`scenario-matrix.scene.html`

**PR:** [expressjs/express#4212: Throw on invalid status codes](https://github.com/expressjs/express/pull/4212)

**What it changes:** `res.status()` now throws a `TypeError` when the code is not an integer and a `RangeError` when it is outside 100 to 999. Before, a string like `"410"` or a float like `410.1` was sent with a deprecation warning, and an out-of-range code failed later, inside Node, at `.end()`. `res.sendStatus()`, `res.redirect()`, and the 304 path also go through `res.status()` now.

**Why this technique:** This is a validation change, and its whole effect is "this input, that outcome." A matrix of the PR's own test inputs, with before and after side by side, shows at a glance which rows changed their HTTP status and which only changed which code throws the error.

**Craft notes:**

- Group the rows into bands named by the rule that sorts them: "integers 100 to 999", "outside 100 to 999 → RangeError", "not integers → TypeError, checked first". The bands are the new code's two `if`s, so the reader learns the rule while reading the cases.
- Each cell is a tiny response: a big status number for scanning, plus the exact message the code builds for reading. The status column alone shows the pattern (`410 → 500` on two rows, `500 → 500` on four). A count key above the matrix, which also serves as the color legend, gives the totals before the reader scans.
- Use the change grammar on the cells, not just the rows. A behavior that is gone is a red, dashed, struck-through cell. A new outcome is green. "Same status, new thrower" is amber. Only one row, the `"410"` row that the old suite asserted would send 410, gets the hero ring.

### `ui-journey`

`ui-journey.scene.html`

[feat: change collab trigger & add share dialog](https://github.com/excalidraw/excalidraw/pull/7647) (merged 2024-02-03, head `8b19f3c`, MIT)

**What it does.** The top-right users-icon button becomes a "Share" button (only an icon below 830 px wide). It opens a new Share dialog that offers live collaboration or a read-only shareable link. The main menu and the welcome screen open the same dialog with only its collaboration half (`type: "collaborationOnly"`), and the padlock illustration is removed.

**Why this technique.** The PR is about what a user finds and how many clicks a link takes ("Many users don't know we support collaboration"). A screen flow from the three entry points through the dialogs to the outcomes, before above after on the same grid, shows the new entry point and the shorter path.

**Craft notes**

- Draw each entry point as a small fragment of the real UI (the toolbar strip, the ☰ menu, the welcome screen) with its real locale strings. Start each wire at the edge of the fragment or dialog, at the height of the clicked item, so no wire crosses the drawn UI. Wires into one dialog fan down its left side and do not stack.
- Number the clicks of the one journey that changes: ☰ → Save to... → Export to Link becomes Share → Export to Link. The numbers appear in each band's header and on the clicked controls, so the reader counts the saving without a banner.
- Keep the unchanged paths in the picture: gray wires to the same Save to... dialog and session dialog. The hero is only the Share button (amber glow) and its `type: "share"` wire. The dialog's added half is green, the reworded copy is amber, and the removed padlock is red, dashed, and struck through. A red "Stop session" button would read as removed, so the real danger color is drawn muted.

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
