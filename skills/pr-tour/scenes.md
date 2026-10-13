# Drawing scenes and micro-worlds

A scene is the picture at the heart of a landmark. It sits right under the title and the lead, wider
than the prose (up to 1120 px on a desktop), and the reader looks at it before reading anything
else. So the scene carries the idea, and the prose under it explains what the picture cannot: the
why, the history, the cost. A reader who only looked at the pictures should still come away with
the shape of the change.

A scene is HTML laid out by the kit below, and it may bring its own styles, SVG, canvas, and
scripts to draw, chart, or animate what markup alone cannot. You have the full range of a browser
inside a sandbox: use it. Be inventive with the picture and exact with the facts.

A micro-world is a scene the reader drives: a faithful model of the changed behavior with a few
controls in front of it. See [Micro-worlds](#micro-worlds).

## How to draw one

1. **Name the idea** of the landmark in one sentence. The picture shows that sentence, nothing else.
2. **Ask what kind of idea it is.** Code that moved? Behavior over time? Data changing shape? A
   screen a person sees? A rule with cases? Then pick the technique that fits from the
   [catalog](#the-catalog), and name it on the root: `<div class="scene" data-technique="sequence">`.
   Two scenes of a tour may share a technique; a third may not (validation refuses it), because
   the same picture dealt over and over teaches nothing new. When two fit, take the one this tour
   has used least. A technique not in the catalog is welcome: name it with a slug of your own.
3. **Look at the gallery.** Open the [gallery](#the-gallery) entries closest to your technique and
   look at their PNGs before you write a line. They show the bar: real names, the change grammar,
   one hero, room to breathe.
4. **Draw the end state first.** The picture at rest says the whole thing. Motion, if any, shows
   how the end state comes about, and builds a busy picture up a few parts at a time.
5. **Preview and look.** `pr-review tour preview` screenshots each scene alone at its desktop
   width, and each landmark page on a desktop and a phone. Look at every one and fix what reads
   badly.

## The change grammar

Every tour draws change the same way, so a reader learns it once:

- **Added** is `good` (green). **Changed** is `warn` (amber). **Removed** is `bad` (red), and drawn
  dashed, faded, and struck through, so it reads as gone at a glance; put removed parts to one side
  or below what lives, never mixed among them.
- **Unchanged context** is `muted` (gray), and it stays in the picture: the callers that did not
  change, the service next door, the table nobody migrated. A picture of only the changed parts
  says nothing about what they touch.
- **One hero**, at most two: the element the change is really about (the edge it adds, the state
  it removes, the line that moved) gets the emphasis, a thicker stroke, a glow, a gentle pulse.
  If everything is emphasized, nothing is. Emphasize with weight and light, never with `ink`: the
  accent is green in the github skin, the same green as added, so an `ink` hero reads as "new".
- **Before and after** are the same picture twice, with the same layout, actors, labels, and
  scale, so the eye goes straight to what differs. Side by side on a desktop; stacked on a phone.

## What every scene does

- **Real names and numbers.** The function, the file, the error code, the status, the count, the
  flag, from the diff. `3 drafts → CANVAS_STALE, nothing posted` beats "some drafts may be stale".
  When the diff has no number, take sample data from the change's own tests and fixtures, and mark
  a made-up value as an example ("e.g. 3 pending").
- **At rest, it reads.** Motion is off for reduced motion and in the preview, so the resting state
  states the outcome. An element that starts hidden and only an animation reveals stays hidden:
  style it visible and animate from hidden (`from { opacity: 0 }`), as the kit's `enter` does.
- **It does not repeat the prose.** The title and the lead are right above the picture, so no
  banner restates them. End where the picture ends. A caption is allowed only for what the picture
  cannot show (a unit, a source, "e.g."), in a `small` line, and it never repeats the title.
- **Words in the markup.** Labels, numbers, and verdicts are HTML (or short SVG `<text>` labels), so
  the browser wraps and aligns them. You write a scene before you see it, and the browser's layout
  is what keeps text from colliding; validation refuses a scene whose markup has no words.
- **Room to breathe.** Use the width. A diagram of six nodes laid out across 1120 px reads at a
  glance; the same six crammed into a column do not. Leave white space between groups; let one
  thing be big. Start a tour with a light picture: the first scene is met before the reader holds
  any of the change, so it shows the few parts the change touches, not every wire.
- **A budget for busy pictures.** At most three columns or eight wires in one picture, and no
  label under 0.75 rem. A picture that needs more is two pictures, or it builds up: two parts at a
  time in motion, all of them at rest. A moved function, its callers, and its cache are three
  ideas: draw the one the landmark is about.
- **A phone composition of its own.** On a phone the frame is about 320 px wide, and a diagram
  whose meaning is in its wires loses it when its columns stack and the wires go. Draw the phone
  version on purpose under `@media (max-width: 40rem)`: stack each source above its destination
  with a labeled arrow down, turn a matrix into a compact table, keep before and after as two
  stacked copies of the same small picture, and drop the nodes the picture's question does not
  need. Then check the phone preview: every relationship the desktop picture shows must still be
  readable there.
- **A stage that persists**, when the tour returns to the same system: the background landmark
  may draw a map of the part of the system the change touches (its components and how they talk,
  all `muted`, the way it was), and a later landmark, often the respect landmark, draws the same
  map with the change overlaid in the change grammar. Same positions, same names: the reader sees
  the whole change land on the system they already met.
- **Faithful.** A picture that lies teaches the wrong theory. Every arrow is a real call or a real
  message; every state is a real state; every count is a real count or marked as an example.

## Pictures by landmark

- **Background**: the world before the change, for a reader who does not know it. A map of the
  part of the system the change touches, the old behavior a user meets, or the cost of leaving it:
  the bug, the slow path, the complaint. It stays true outside this pull request.
- **World**: what a user or a caller notices, before and after, drawn where they meet it: the
  screen, the terminal, the response, the config file, the email.
- **Why**: the part the landmark explains, and why it is shaped that way: the sequence it orders,
  the state it adds, the branch it takes, the code it moved, the cases it handles.
- **Respect**: what a later change must keep true: the one place a new case goes, the invariant,
  the boundary, the check that guards it, and what nothing checks yet.
- **State**: the stored data before and after, what happens to existing rows, and the way back.

## The catalog

Starting points, grouped by the kind of idea. Combine them, bend them, and invent your own; the
slug in `code` is what goes in `data-technique`.

### Code that moves or changes shape

- `lineage`: a movement map. Functions, classes, or blocks before (left) and after (right),
  connected by arrows labeled **moved**, **renamed**, **extracted**, **merged**, **inlined**; what
  was deleted fades out at the bottom. For refactors, extractions, renames.
- `sankey`: an alluvial diagram of code redistributed between modules, ribbon width by symbols or
  lines; one big `utils.py` splitting into three, or three helpers merging into one. Draw the
  ribbons in SVG with cubic curves; label both ends.
- `architecture`: the system diagram with the change overlaid: components and connections added,
  changed, and removed in the change grammar, unchanged neighbours kept as context, one hero
  edge. Three or four lanes that match the reader's mental model (browser, server, worker, store),
  not the folder tree.
- `dependency-matrix`: modules on both axes; a cell for each import; cells introduced green,
  removed red; the layering rule the change keeps (or breaks) as a diagonal band. Better than a
  graph once there are more than about eight modules.
- `impact-map`: a call graph around the changed function: its callers on the left, what it calls
  on the right, unchanged code that could be affected in gray with a ring, and a count of call
  sites. For "what does this change touch".
- `heatmap`: a treemap of the files the change touches, area by lines changed, color by kind of
  change (mechanical rename, real logic, tests, docs). Shows at a glance where the substance is.
- `storyboard`: the change as three to five steps of intent across files ("introduce the
  interface → move the callers → delete the old path"), a small picture per panel, numbered, left
  to right.
- `file`: the caller's code before and after: the call site that must change (`file` with `del`
  and `add` lines), and how many call sites there are.
- `code-map`: the changed function's own listing, a dozen lines, with a band beside each region
  saying what happens when the event the change is about lands there (an interrupt, an exception,
  a timeout, a second click): before on one side, after on the other. The reader sees the code and
  its behavior at once, line by line.

### Behavior over time

- `sequence`: actors as columns, messages as arrows down the page, before and after side by side;
  the reordered or new message is the hero. For ordering, protocols, async hand-offs.
- `control-flow`: the code's decisions, loops, early exits, and exception paths as a small
  flowchart, before and after: authorization moved ahead of the write, a retry branch added, a
  `finally` that now always runs.
- `state-machine`: states as nodes, transitions as labeled arrows; the state or transition the
  change adds glows, the one it removes is dashed red; a state nothing leaves is ringed.
- `timeline`: events on a time axis (the kit's `timeline`, or SVG): retries with backoff, a lock
  held, a token expiring mid-request, a deprecation window. Mark the moment the behavior differs.
- `race`: two or three lanes on one clock, who arrives first, and what the user sees when the
  order flips. Animate the lanes, hold on the outcome.
- `trace`: an execution trace or flame graph under the same workload, before and after: 101
  queries collapsing into 2, a hot path that disappears, time per stage as stacked bars.
- `live-state`: the actors as cards with their real fields (a status pill, a small key-value
  table), and the values after each step of one run: `cart:session_42 items 0 → 1`. One stage,
  values changing, like a debugger paused at the interesting moment.

### Rules with cases

- `scenario-matrix`: representative inputs as rows, outcomes before and after as columns, the
  cells that differ tinted: `expired token: 500 → 401`, `valid token: 200 → 200`. The most honest
  picture of a behavior change, and often the best world landmark.
- `decision-table`: the rule as a grid of conditions and the branch each combination takes, with
  the combination the change adds or fixes marked.
- `checks`: the cases handled or tested (the kit's `checks`), with the one gap open: the guards a
  landmark names.
- `test-flips`: the existing tests whose expectations the change rewrote, each assertion before
  and after (`status` 500 → 401, `calls` 1 → 3). A behavior change in the project's own
  numbers, and the best evidence of what a caller will notice.
- `boundary`: where the new behavior stops. Two or three paths side by side under the same input:
  one the change covers, one it charges but does not stop, one it leaves alone, each ending in what
  the reader sees. The edge of a behavior is where readers form the wrong theory, so draw it when
  the prose would need "but not when".

### Data

- `data-flow`: where data comes from, each transformation it goes through, and where it lands,
  before and after: a field now redacted before export, a value normalized at the edge. Draw the
  record itself at each stage, with its real fields.
- `schema`: the tables or types before and after, the field that appears, the one that goes, the
  relation that splits, and what an existing row holds after the migration.
- `rows`: a `table` of rows in and rows out: kept, dropped, changed, flagged, one tone each.
- `unit-chart`: 120 dots, 3 red: how many users, tenants, or records the change touches.

### Where a person meets it

- `screen`: the UI state before and after (a `window` with `skel` lines around what matters): the
  message, the disabled button, the empty state, the toast.
- `ui-journey`: screens as small frames connected by the actions between them, before and after:
  five steps becoming three, a new branch for an error.
- `terminal`: the command and what it prints (`term`): a warning against an error, the exit code,
  `--help` with the new flag.
- `log`: the log line before and after: a stack trace against one line that names the row.
- `config`: the file someone edits: the new key, its default, what they may leave out.
- `message`: the email, notification, chat reply, or review comment as the person receives it.

### Quantities and risk

- `bars`: one scale, before and after (latency, bundle size, queries per request, minutes).
- `meter`: a bar against a limit: a quota, a budget, a timeout; let the bar cross it.
- `chart`: a small line chart or sparkline (SVG `polyline`, points computed by a script): a cache
  warming, memory climbing, error rate after a deploy.
- `risk`: a likelihood-by-impact grid, blast-radius rings (one request, one tenant, every
  tenant), or a one-way door against a two-way door with the rollback path drawn or crossed out.

## The gallery

Real pull requests from open-source projects, each drawn with one technique at its best. They live
beside this guide in `gallery/`: `<slug>.scene.html` or `<slug>.micro.html`, and `README.md`, which
says what each one shows and the craft to copy from it. Before drawing, pick the two to four entries
nearest the pictures you plan, run `pr-review tour gallery <slug> [<slug>…]` (it draws them at the
tour page's width and prints each picture's path), and look at the pictures with the Read tool. Copy
the craft, never the content: your tour draws its own change.

Scenes:

- `architecture`: vite#20916, browser console logs forwarded to the dev server: a new lane on the
  HMR socket beside the unchanged ones.
- `lineage`: httpx#1296, one module split in two, classes becoming functions, three copies merged.
- `sankey`: pytest#14520, a 702-line `util.py` redistributed into eight modules, ribbons by lines.
- `heatmap`: httpx#1808, a renamed and flipped default: one square per changed line, by kind.
- `dependency-matrix`: next.js#82844, shared types moved out of the server: import counts per cell.
- `impact-map`: vitest#5876, stricter error equality: the callers that fan into the changed function.
- `storyboard`: saleor#17859, a denormalized order count: store, backfill, count, uncount.
- `sequence`: tokio#8371, lock order under an exhausted budget: two runs on one row grid.
- `control-flow`: rails#48600, a non-local return now commits: two flowcharts, rows aligned.
- `state-machine`: opossum#389, a circuit breaker stuck half-open: the transition that frees it.
- `trace`: gitea#33528, 106 queries becoming 6: both runs as ticks on one axis.
- `data-flow`: caddy#4507, trusted proxies for `X-Forwarded-*`: forged headers stopped at the gate.
- `schema`: wagtail#8441, page revisions becoming generic revisions: rows traced through migrations.
- `scenario-matrix`: express#4212, invalid status codes now throw: inputs by outcome, before and after.
- `ui-journey`: excalidraw#7647, a new share dialog: three entry points to a link, before and after.

Micro-worlds:

- `trace-player`: p-retry#96, a hook that skips a retry: step through one run, state cards updating.
- `before-after`: date-fns#2616, end-of-month durations: old and new code side by side on one input.
- `race-lab`: swr#1970, two optimistic updates racing: sliders for the timing, the stale value found.
- `state-explorer`: prisma-engines#3391, a closed transaction's error: fire events, see refusals.
- `data-playground`: rails#43945, `normalizes`: edit a record, watch each stage change it.

## Micro-worlds

A micro-world is a small world the reader can fully learn by poking at it: the inputs of the
changed behavior go in, the outcome the code would produce comes out, with the reason in words. A
tour has up to two, only where the change has behavior worth playing with; a micro-world may stand
in for its landmark's scene.

Patterns:

- **A simulator.** The inputs of the changed behavior as controls (a command, a terminal or a
  pipe, a flag; a request, a header, a role), and the code's real branches, transcribed as a small
  script, printing what the code prints: to stdout and stderr, to a response body and a status,
  to a table. A line under it says which branch fired and why.
- **A before/after twin.** The same inputs through the old code and the new code side by side,
  both transcribed from the diff, so the reader finds the input where they differ. Add a "this
  pull request: before | after" switch, the rule itself as a control.
- **A trace player.** One run of the changed code the reader steps, plays, or scrubs through:
  the actors as state cards with real fields that update at each step, the message in flight, and
  the line of code that runs. It opens on a telling step with the outcome already drawn.
- **A race lab.** Sliders for the timing of two or three concurrent events (a click and a
  response, a timeout and a retry, two writers); the timeline redraws and says who wins and what
  the user sees.
- **A state explorer.** The reader fires events at the state machine; a transition the code
  refuses is refused inside the world, with the code's own error where it happens.
- **A data playground.** The reader edits one record (two to four fields) and sees each stage of
  the changed pipeline transform it, with the stage that rejects or changes it marked.
- **A layout switchboard.** Each move of a UI change (a size, a box, a gap, a color) as a switch
  over the same content, so the reader sees each move on its own and all of them together, and
  the page reports what changed.

Rules:

- **Faithful.** The model is the code's branches, with the code's names and values, transcribed
  from the diff; a micro-world that lies teaches the wrong theory. Put the model at the top of the
  script, as plain functions, so it reads.
- **One object to think with.** Build the world around one thing the reader handles (the request,
  the row, the command line), not a panel of knobs. Two to four controls, each changing something
  the reader can see. Group them in `fieldset`s with a `legend` inside a `controls` row.
- **Errors happen inside the world.** Do not disable an input the code rejects; let the reader
  pick it and show the code's real refusal: the status, the error code, the stderr line.
- **The outcome in words, not only in shapes.** A `term`, a `file`, a `table`, or a `window` shows
  what happens; a `small` line under it says why, quoting the live values.
- **Scales that follow the inputs.** A time axis or a bar scale fits the values the current inputs
  produce, and is recomputed when they change; a label that does not fit its bar goes beside it,
  never clipped inside it.
- **Starts in a telling state.** At rest the micro-world proves its landmark's title: it opens on
  the input where before and after differ (or where the counterfactual bites), with the outcome
  drawn before the reader touches anything, and a caption says what the default shows. When the
  landmark also has a scene, open on a case the scene does not draw. Leave one surprising
  combination to find.
- **Labels say what the model tests.** A verdict names what the model checks ("passes
  validation", not "saved"), and a simulated event names where it is injected ("the connection
  drops after the headers"), not a wider interval it stands for ("while loading").
- **Scripts listen with `addEventListener`.** No handler attributes, no `<form>`; a `button` is
  `type="button"`.

## Techniques beyond the kit

- **Your own CSS** in a `<style>` inside the scene: grids, keyframes, transitions, clip paths.
  Scope your classes with a prefix of your own so they cannot clash with the kit, and take every
  color from the kit's tokens (`var(--good)`, `var(--ink)`, …) so the scene fits both themes and
  both skins. Scope element rules too: a rule on every `svg` or `path` also restyles the kit's
  icons, so give your own SVG a class and write the rules under it. Text below about 0.75 rem is
  under 9 px on a phone: size small labels in `em` of a readable base, or raise them under a
  `@media (max-width: 40rem)` rule.
- **Inline SVG** for shapes the kit lacks: nodes and edges, curves, ribbons, zones, charts. Give it
  a `viewBox` and `width="100%"` so it scales; a `viewBox` about 1100 units wide makes 1 unit about
  1 px on a desktop, so SVG text of `font-size="14"` reads like the kit's small text, and stays
  legible on a phone only when the drawing is simple. For a phone, prefer a second, narrower SVG
  shown under a `@media (max-width: 40rem)` rule over one that shrinks to nothing. Colors in SVG go
  through CSS: `style="fill: var(--good)"` or a class, because a presentation attribute such as
  `fill="var(--good)"` ignores `var()`. Arrowheads with
  `<marker>` and `marker-end="url(#id)"` (a marker does not take its path's color: define one per
  tone); gradients by `url(#id)`; motion without a script with `<animate>` and `<animateMotion>`.
- **A script** to build what would be tedious to write: 120 dots, a grid of cells, rows from a
  small data array (put the data at the top, so it reads), chart points computed from numbers,
  ribbons computed from counts.
- **Canvas** for many moving things: particles, a heat map, a queue of a hundred requests. Size it
  with CSS, set its pixel size from `getBoundingClientRect()` times `devicePixelRatio`, and take its
  colors from `scene.color('bad')`.
- **Animation**: CSS keyframes, the Web Animations API (`el.animate(…)`), or
  `requestAnimationFrame` for a simulation. Play once and hold the end state, or loop gently: a
  message travelling an edge, a queue draining, a diagram building up two parts at a time. With
  `scene.reducedMotion`, draw the end state and stop.
- **Emphasis**: make the hero pulse or glow, and `fade` the rest.

## The frame

- **Where to write it.** Write each scene as its own file, `<landmark id>.scene.html`, and a
  micro-world as `<landmark id>.micro.html`, in the scenes directory the prompt names; publish
  reads them into the landmark. Files keep scripts readable: no escaping.
- **The root.** The frame wraps your fragment; start it with
  `<div class="scene" data-technique="…">`, the column the kit lays things out in. A `<style>` and
  a `<script>` may sit inside it. Each scene is its own document in its own frame, so
  `document.querySelector` finds only its own elements, and two landmarks may reuse the same ids
  and class names.
- **Its size.** The frame is up to 1120 px wide on a desktop (about 75 rem; 1 rem is 15 px) and
  about 320 px on a phone (about 27 rem at 12 px), and as tall as the scene: nothing is shrunk or
  cut off, and a tall scene pushes the prose after it down. Lay out with flex and grid, size
  canvases and SVG by width and `aspect-ratio` or `viewBox`, and let rows wrap. A scene taller than
  about 700 px on a desktop pushes the prose out of sight: prefer wide to tall. On a phone, a
  `grid` of three columns becomes cramped; prefer two, or a `row` that wraps, or stack the before
  and the after.
- **What scripts get.** `window.scene` has `reducedMotion` and `color(name)` (a kit token resolved
  for the current skin and theme, such as `scene.color('good')` → `rgb(26, 127, 55)`).
- **What the frame lacks.** It has no origin, network, storage, eval, or workers; it loads nothing,
  so icons, styles, and scripts are all inline (images as SVG, canvas, or `data:`). A scene takes no
  input: the tour owns clicks, drags, and keys, so a scene is watched, never used. A micro-world
  takes input through its own controls, and only there. Validation refuses `<img>`, frames,
  `<link>`, `<meta>`, forms, `<video>`, `<audio>`, event handler attributes (write code in a
  `<script>`), `url()` of anything but `#id` or `data:`, links, and scripts that use `fetch`,
  `XMLHttpRequest`, `WebSocket`, storage, `eval`, or workers; for a scene, it refuses inputs,
  buttons, and selects too, and a scene with no `data-technique`.
- **Size.** At most 12,000 characters per scene; most need far fewer.
- **If a script throws,** what the markup shows is what the reader sees.
- **No secrets, credentials, or protected health information,** even as sample data.

## The kit

- **Layout**: `scene` (the column everything sits in), `row` (items side by side; `row spread`
  pushes them apart), `col`, `grid` (`style="--cols: 3"`), `stack` (items tight on top of each
  other), `controls` (a micro-world's fieldsets, side by side and wrapping).
- **Things**: `box` (a rounded panel; a `label` inside is its caption; `box ghost` dashed and empty,
  `box solid` filled; it stacks and centers its children, so wrap a sentence that mixes text and
  `code` in one `<span>`, or its pieces stack as separate lines, and give a list or a paragraph in a
  box `style="text-align: left; align-items: stretch"`), `chip` (a small pill that never wraps:
  keep it to a few words), `banner` (a full-width bar), `big` (a large number or
  word), `label` (small caps), `small`, `code` (inline code), `strike`, `fade`, `hatch` (a hatched
  fill for what cannot happen: a cell, a slot, a box), `stamp` (a rotated verdict on the scene's
  corner).
- **A screen**: `window` (`data-title="…"` titles it) holding `btn` (`btn solid`, `btn off` for
  disabled, `btn sm` for a row of several), `field` (an input as it looks, toned when it errs; it
  keeps line breaks, so with `style="min-height: 4rem"` it is a text area), `toast`, `skel` (a
  placeholder line, `style="--w: 60%"`), `link`, and `<kbd>`.
- **Controls**, for a micro-world: real `<input>`, `<select>`, and `<button type="button">`
  elements inside a `<fieldset>` with a `<legend>`, each `<input>` wrapped in a `<label>`; the kit
  styles them, and they take the accent.
- **A terminal or log**: `term` (`data-title` optional), one child per line; `cmd` lines get a
  prompt; toned spans and lines color themselves. Always dark.
- **A file**: `file` (`data-title` is its name), one child per line; `add`, `del`, and `hl` mark
  lines.
- **A table**: a plain `<table>` with `<th>` and `<td>`; a toned `<tr>` or `<td>` is tinted; `num`
  right-aligns numbers.
- **Quantities**: `bars`, a grid of three children per row: a `label`, a `bar` with
  `style="--v: 70%"`, and the value. A `bar` alone is a meter. Bars grow in on their own.
- **Time**: `timeline`, an `<ol>` whose `<li data-t="3 s">` items sit on a line with their time; a
  toned item gets a toned dot.
- **A conversation**: `thread` of `msg` bubbles; `msg me` is the author's; `<span class="who">`
  names the speaker.
- **Coverage**: `checks`, a `<ul>` whose items are marked by tone: `good` ✓, `bad` ✕, `warn` !,
  none open.
- **Tones**, on any element: `ink` (the tour's accent, as the skin paints it), `good`, `bad`,
  `warn`, `muted`. A tone sets `--c` on its element, and each thing uses it its own way: `chip`,
  `banner`, `box solid`, `btn solid`, `toast`, `msg me`, and a `bar`'s fill are filled with it, and
  the text and icons in them turn to the paper color; `box`, `field`, `btn`, and a toned `tr` or
  `td` take it as their border or a pale wash; `big`, `label`, `small`, a toned span, `strong`,
  `em`, list item, or cell color their text with it.
- **Tokens** for your own CSS: `--c` (the element's tone, where one is set), `--ink`, `--good`,
  `--bad`, `--warn`, `--muted`, `--fg` (text), `--paper` (background), `--line` (borders), and
  `--tint` (a pale wash of the element's tone).
- **Icons**: `<i data-icon="database" class="lg"></i>`, by [Lucide](https://lucide.dev/icons) name:
  `user`, `users`, `message-square`, `git-pull-request`, `git-commit-horizontal`, `file-code`,
  `database`, `server`, `cloud`, `hard-drive`, `lock`, `lock-open`, `key-round`, `shield-check`,
  `shield-alert`, `clock`, `timer`, `hourglass`, `triangle-alert`, `circle-x`, `circle-check`,
  `ban`, `refresh-cw`, `repeat`, `copy`, `trash-2`, `eye`, `eye-off`, `send`, `inbox`,
  `list-checks`, `bug`, `zap`, `package`, `settings`, `terminal`, `history`, `undo-2`, `split`,
  `merge`, `layers`, `link`, and any other Lucide name. Sizes: none (text size), `lg`, `xl`; leave
  the size off inside a `chip`.
- **Arrows**: `<span class="arrow"></span>` points right, `arrow down` points down,
  `style="--len: 4rem"` sets its length, `data-say="retry"` writes a word on it (beside it, for
  `arrow down`), `arrow flow` animates things moving along it, either way, `arrow blocked` crosses
  it out.
- **Motion**: `pulse`, `bob`, `shake` (a failure), `blink`, `spin` loop; `enter` on a parent deals
  its children in one by one. For reduced motion the kit stops all CSS motion, and the frame jumps
  SVG animations to their end; a script's own animation checks `scene.reducedMotion`.

## Small examples

These show the kit's vocabulary at small scale. The gallery shows what a full-width scene can be.

A terminal, for a world landmark on what a typo now prints:

```html
<div class="scene" data-technique="terminal">
  <div class="grid" style="--cols: 2">
    <div class="term" data-title="before">
      <span class="cmd">pr-review insall-skill</span>
      <span class="muted">{"error":{"code":"BAD_REQUEST","hint":"run pr-review --help"}}</span>
    </div>
    <div class="term" data-title="after">
      <span class="cmd">pr-review insall-skill</span>
      <span class="bad">error: unknown command: insall-skill (BAD_REQUEST)</span>
      <span class="bad">hint: run pr-review --help</span>
    </div>
  </div>
  <p class="small">A person at a terminal reads a sentence; a script piping stdout still gets JSON.</p>
</div>
```

The caller's code, for a why landmark on renaming a client method in one clean break:

```html
<div class="scene" data-technique="file">
  <div class="row">
    <div class="file" data-title="src/jobs/sync.ts">
      <span class="muted">// one of 14 call sites</span>
      <span class="del">const pages = await client.fetchAll(repo, { page: 1 })</span>
      <span class="add">const pages = await client.list(repo).pages()</span>
    </div>
    <div class="col"><span class="big warn">14</span><span class="small">files change with it</span></div>
  </div>
</div>
```

A screen, for a landmark on what Save does while a request is in flight:

```html
<div class="scene" data-technique="screen">
  <div class="window" data-title="Settings · Billing">
    <span class="label">billing email</span>
    <span class="field">ops@example.com</span>
    <span class="skel" style="--w: 70%"></span>
    <div class="row spread"><span class="small">saving…</span><span class="btn solid off">Save</span></div>
    <div class="toast good"><i data-icon="circle-check"></i> Saved once</div>
  </div>
</div>
```

A scenario matrix, for a world landmark on what an expired token now returns:

```html
<div class="scene" data-technique="scenario-matrix">
  <table>
    <tr><th>request</th><th>before</th><th>after</th></tr>
    <tr><td>valid token</td><td class="num">200</td><td class="num">200</td></tr>
    <tr class="warn"><td>expired token</td><td class="num bad">500 · stack trace</td><td class="num good">401 · token_expired</td></tr>
    <tr><td>no token</td><td class="num">401</td><td class="num">401</td></tr>
  </table>
  <p class="small">From the cases in <code>auth.test.ts</code>; only the expired row changes.</p>
</div>
```

A timeline built by a script, for a landmark on retrying with backoff: the attempts land on a time
axis one by one, and the resting state shows them all.

```html
<div class="scene" data-technique="timeline">
  <div class="rt-axis"></div>
  <div class="row spread"><span class="label bad">upstream down for 20 s</span><span class="label">5 attempts, the user waits 30 s</span></div>
  <style>
    .rt-axis { position: relative; width: 100%; height: 4.5rem; border-bottom: 0.12rem solid var(--line); }
    .rt-down { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--bad) 10%, transparent); border-right: 0.12rem dashed var(--bad); }
    .rt-try { position: absolute; bottom: 0.3rem; translate: -50% 0; display: grid; justify-items: center; gap: 0.2rem; font-size: 0.7rem; color: var(--muted); }
    .rt-try::before { content: ''; width: 0.8rem; height: 0.8rem; border-radius: 50%; background: var(--c); }
  </style>
  <script>
    const tries = [0, 2, 6, 14, 30]
    const back = 20
    const end = 32
    const axis = document.querySelector('.rt-axis')
    const down = document.createElement('div')
    down.className = 'rt-down'
    down.style.width = `${(back / end) * 100}%`
    axis.append(down)
    tries.forEach((t, i) => {
      const dot = document.createElement('div')
      dot.className = `rt-try ${t < back ? 'bad' : 'good'}`
      dot.style.left = `${(t / end) * 100}%`
      dot.textContent = `${t} s`
      axis.append(dot)
      if (!scene.reducedMotion) {
        dot.animate([{ opacity: 0, transform: 'translateY(0.6rem)' }, { opacity: 1, transform: 'none' }], {
          duration: 300,
          delay: i * 250,
          fill: 'backwards',
        })
      }
    })
  </script>
</div>
```

A unit chart built by a script, for a state landmark on how many tenants a clean break touches:

```html
<div class="scene" data-technique="unit-chart">
  <div class="row"><span class="big bad">3</span><span class="small">of 120 tenants still send the old field</span></div>
  <div class="uc-dots"></div>
  <ul class="checks"><li class="good">117 tenants: nothing to do</li><li class="bad">3 tenants: migrate by hand</li><li class="warn">rollback: the column stays until v3</li></ul>
  <style>
    .uc-dots { display: grid; grid-template-columns: repeat(20, 1fr); gap: 0.25rem; width: 100%; max-width: 22rem; }
    .uc-dots i { aspect-ratio: 1; border-radius: 50%; background: var(--line); }
    .uc-dots i.bad { background: var(--bad); }
  </style>
  <script>
    const dots = document.querySelector('.uc-dots')
    for (let i = 0; i < 120; i++) {
      const dot = document.createElement('i')
      if ([17, 58, 93].includes(i)) dot.className = 'bad pulse'
      dots.append(dot)
    }
  </script>
</div>
```

A micro-world, a simulator of the rule that picks text or JSON for a command: the reader picks the
inputs, and the model, the code's own branches, prints what the command prints.

```html micro-world
<div class="scene">
  <div class="controls">
    <fieldset><legend>command</legend>
      <label><input type="radio" name="cmd" value="install-skill" checked> install-skill</label>
      <label><input type="radio" name="cmd" value="validate"> validate</label>
    </fieldset>
    <fieldset><legend>stdout is</legend>
      <label><input type="radio" name="out" value="tty" checked> a terminal</label>
      <label><input type="radio" name="out" value="pipe"> a pipe</label>
    </fieldset>
    <fieldset><legend>flag</legend>
      <label><input type="checkbox" name="json"> --json</label>
    </fieldset>
  </div>
  <div class="term" data-title="what prints"><span class="cmd sim-cmd"></span><span class="sim-out"></span></div>
  <p class="small sim-why">The rule, in words.</p>
  <script>
    // The model: outputMode as src/commands.ts has it after this change.
    const AGENT_COMMANDS = new Set(['prepare', 'validate', 'publish'])
    function outputMode(command, flag, stdoutIsTTY) {
      return command === 'doctor' ? flag : flag || !stdoutIsTTY || AGENT_COMMANDS.has(command)
    }
    const picked = name => document.querySelector(`input[name="${name}"]:checked`)
    function render() {
      const command = picked('cmd').value
      const pipe = picked('out').value === 'pipe'
      const flag = picked('json') !== null
      const json = outputMode(command, flag, !pipe)
      document.querySelector('.sim-cmd').textContent = `pr-review ${command}${flag ? ' --json' : ''}${pipe ? ' | cat' : ''}`
      document.querySelector('.sim-out').textContent = json ? '{"skill":"pr-review-canvas","targets":[…]}' : 'Copied the pr-review-canvas skill to:'
      document.querySelector('.sim-why').textContent = flag
        ? '--json is on the command line, so JSON.'
        : pipe
          ? 'stdout is a pipe, so JSON: a script or an agent is reading.'
          : AGENT_COMMANDS.has(command)
            ? `${command} is an agent command, so JSON even at a terminal.`
            : 'A terminal, no flag, not an agent command, so text.'
    }
    document.addEventListener('change', render)
    render()
  </script>
</div>
```
