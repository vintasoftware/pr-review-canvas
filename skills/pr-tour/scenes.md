# Drawing scenes and micro-worlds

A scene is the picture on a landmark, under its lead and its body. Most readers take the landmark
in from the picture before they finish the prose, so the scene carries the idea: the reader should
see, faster than they could read it, **what this part of the change does, to whom, and at what
cost**. It is HTML laid out by the kit below, and it may bring its own styles and scripts to draw,
chart, or animate what markup alone cannot. Be inventive with the picture and plain with the facts.

A micro-world is a scene the reader plays with: the inputs of the changed behavior go in, the
outcomes come out. A tour has one only when the change has behavior worth playing with. See
[Micro-worlds](#micro-worlds).

## What every scene does

- **Where it lands.** Draw the place the change shows up, as the person who meets it sees it: the
  screen a user sees, the terminal a developer reads, the log on-call scrolls at 3 a.m., the config
  someone edits, the row that lands in the table, the comment a reviewer writes.
- **One picture per landmark, and the picture the landmark needs.** The background landmark draws
  the world before the change; the world landmark draws what the change means to a user or a
  caller; a why landmark draws the part it explains and why it is shaped that way; the respect
  landmark draws what a later change must keep true. A before-and-after is the same picture twice
  with a different outcome: the same form, actors, order, labels, and scale, so the eye goes
  straight to what differs.
- **Real names and numbers.** The error code, the file, the command, the count, the flag, taken
  from the diff. `3 drafts → CANVAS_STALE, nothing posted` beats "some drafts may be stale". When
  the diff has no count, as with most UI behavior, take sample data from the change's own tests and
  fixtures, and mark a made-up count as one ("e.g. 3 pending").
- **At rest, it reads.** Motion shows how the outcome comes about; the scene's resting state
  already states the outcome. A reader who glances mid-animation, or who asked for reduced motion,
  still gets it. Motion is off for reduced motion and in the preview, so an element that starts
  hidden and only an animation reveals stays hidden: style it visible and animate from hidden
  (`from { opacity: 0 }`), as the kit's `enter` does.
- **One point.** End on the outcome, cost included, in a few words: usually a `banner` toned
  `good`, `bad`, or `warn`; a `toast`, a `stamp`, or a last terminal line works when it belongs to
  the picture.
- **Beside the prose, not a copy of it.** The lead says it in a sentence; the scene shows the end
  state with the numbers.
- **Words in the markup.** Labels, numbers, and the verdict are HTML, so the browser wraps and
  aligns them. Scripts and SVG draw shapes and move things. You write a scene before you see it,
  and the browser's layout is what keeps text from colliding; validation refuses a scene whose
  markup has no words.
- **A varied tour.** Pick each landmark's picture for that landmark. A tour of six box-arrow-banner
  scenes reads as one picture dealt six times; when two pictures fit equally, take the one the tour
  has used least.

## Where the frame puts it

The frame is as wide as the tour's stage, about 46 rem on a desktop (1 rem is about 15 px there)
and the full width of a phone (about 24 rem at 12 px), and as tall as the scene: nothing is shrunk
or cut off, and a tall scene pushes the prose after it down. So lay out with flex and grid, size
canvases and SVG by width and `aspect-ratio` or `viewBox`, let rows wrap, and keep a scene to what
reads on a phone: a screen with four lines, a terminal with five, a table with four rows, a
timeline with five events. A `grid` of three columns becomes cramped on a phone; prefer two, or a
`row` that wraps.

## Ideas: pick the picture by where the change lands

Ask **where does this show up, and who sees it first?** Then draw that. These are starting points;
combine them, and invent your own when the landmark calls for it.

**A person sees a screen**

- The UI state before and after: the message shown, the button disabled, the empty state, the
  error toast, the page that loads. A `window` with a few `skel` lines around the part that matters.
- The same screen for an existing user, before and after, when behavior changes unasked.
- A form whose field now rejects input, the error text under it; or one that accepts bad input.
- The email, notification, or chat reply the user receives, rendered as they would see it (a link
  clickable or plain text, a table rendered or raw pipes).
- A narrow window for a phone-only consequence; a screen reader's announcement in a `msg` bubble.
- Loading over time: skeleton to content, or a spinner that never ends (animate, rest on the end).
- The keys a user presses (`kbd`) and what the change does with them; a click as a
  `mouse-pointer-2` icon beside the button, with `bob`.

**A developer meets it in a terminal, log, or CI**

- The command they run and its output: a warning against an error, the exit code, what prints.
- A log excerpt before and after: a stack trace against one line that names the row; 500 lines a
  minute against 3.
- CI jobs as `checks` (passing, failing, skipped) and the minutes a pipeline takes as `bars`.
- A deprecation warning on every call against a hard break at upgrade.
- `--help` output with the new flag's name, for a naming decision.
- A diffstat (`+412 −9, 14 files`) or a commit graph, for a scope decision.

**Someone writes or reads code or config**

- The caller's code before and after: the call site that must change (`file` with `del` and `add`
  lines), and how many call sites there are (a big number or a list of files).
- The config a user writes: the new key, its default, the YAML they must add or may leave out.
- The API as it reads at the call site, for naming: `deck.publish({ force })` against
  `publishDeck(key, true)`.
- The type a caller must handle: `string | undefined` against `string`, and the check it forces.
- The stored row or document as it lands, and the same row after the migration.
- A new dependency and the files that now import it.

**Data changes shape** (the state landmark lives here)

- A `table` of rows in and rows out: kept, dropped, changed, flagged, one tone each.
- The shape before and after: two `file` blocks of the schema, the column that appears, the one
  that goes, and what an existing row holds in it.
- A matrix of cases against behavior, ✓ and ✕ cells, the case the change gets wrong tinted.
- A funnel: counts at each stage, as `bars` that shrink.
- A unit chart: 120 dots, 3 red, for how many users, tenants, or records the change touches (a
  script draws the dots).
- A migration as a `timeline`: deploy, backfill, and the step where old readers break, and the
  step that undoes it.

**It is a quantity**

- `bars` on one scale, before and after: latency, bundle size, memory, queries per request, CI
  minutes, lines to maintain, cost.
- A meter against a limit: a quota, a rate limit, a timeout budget; mark the limit, and let the bar
  cross it.
- A small line chart or sparkline (SVG `polyline`, points computed by a script): a cache warming,
  memory climbing with no eviction, error rate after a deploy.
- A big number before and after: `1 query → 101 queries`.
- A stacked bar of where the time goes: network, parse, render.

**It unfolds in time**

- A `timeline` of events: retries with backoff (0 s, 1 s, 3 s, 7 s, gave up), a lock held, a token
  expiring mid-request.
- A race: two lanes, the user's press and the data's arrival, and who wins; animate both lanes,
  then hold on the outcome.
- A request's life: queued, picked up, failed at step 3, retried or dropped.
- A stream: text arriving while half-written markdown renders, shown mid-stream.
- A schedule: a deprecation window (now, v2 warns, v3 breaks), a cache TTL running out, a cron run.
- A sequence diagram: actors as columns (SVG), messages as arrows, for ordering and protocol choices.

**Things move between parts**

- A flow of boxes and arrows: data moving, a call blocked at a trust boundary (`arrow blocked`),
  one event fanned out to N handlers.
- Traffic you can watch: dots moving along a path (SVG `animateMotion`, or a script), piling up at a
  bottleneck, spilling from a full queue, draining after the change.
- A trust boundary as a dashed zone, and the one arrow that carries a secret across it.
- A state machine: states as nodes, the transition the change adds or removes, the state nothing
  leaves.

**It lives somewhere in the codebase** (the respect landmark often lives here)

- A file tree (a `file` or a `stack` of `code` lines) with the new module placed where it went.
- Layers as stacked bands (UI, domain, storage) with the logic in one band, and the arrows that
  now cross a layer counted.
- An import graph with the cycle the change avoids, or the boundary it keeps.
- The one place a later change must touch: the list, the set, the function, boxed and named, with
  what happens when it is skipped.
- Who gets pinged: the code owner or team the change makes responsible.

**People talk about it**

- The review `thread`: the question a reviewer will ask, and whether the change answers it first.
- The support ticket or user complaint the old behavior invited.
- The PR description line, or the changelog entry, the change needs.

**Risk, coverage, and reversibility**

- `checks` of the cases handled or tested, with the one gap open: the guards a landmark names.
- A likelihood-by-impact grid with the change's dot in its cell.
- Blast radius as rings: one request, one tenant, every tenant.
- A one-way door against a two-way door: the rollback path drawn, or crossed out.
- What a log line reveals, redacted against raw, with placeholders such as `<token>` or `▇▇▇▇`.

**Effort now or later**

- This change against a follow-up: a timeline with the ticket that may never be picked up.
- The debt that grows: a counter, or bars per release.
- The to-do list a shortcut leaves (`checks` with open items).

## Micro-worlds

A micro-world is a faithful model of the changed behavior with a few controls in front of it. The
reader changes an input and sees the outcome the code would produce, with the reason in words. Two
patterns from the tour's prototype:

- **A simulator.** The inputs of the changed behavior as controls (a command, a terminal or a pipe,
  a flag; a request, a header, a role), and the code's real branches, transcribed as a small
  script, printing what the code prints: to stdout and stderr, to a response body and a status, to
  a table. A line under it says which branch fired and why.
- **A layout switchboard.** Each move of a UI change (a size, a box, a gap, a color) as a switch
  over the same content, so the reader sees each move on its own and all of them together, and
  the page reports what changed (the height, the count on one screen).

Rules:

- **Faithful.** The model is the code's branches, with the code's names and values, transcribed
  from the diff; a micro-world that lies teaches the wrong theory. Put the model at the top of the
  script, as plain functions, so it reads.
- **Few controls.** Two to four: radios, checkboxes, a select, a button. Every control changes
  something the reader can see. Group them in `fieldset`s with a `legend` inside a `controls` row.
- **The outcome in words, not only in shapes.** A `term`, a `file`, a `table`, or a `window`
  shows what happens; a `small` line under it says why.
- **Starts in a telling state.** The default inputs show the change at its most typical, and the
  outcome is already drawn before the reader touches anything.
- **Scripts listen with `addEventListener`.** No handler attributes, no `<form>`; a `button` is
  `type="button"`.

## Techniques beyond the kit

- **Your own CSS** in a `<style>` inside the scene: grids, keyframes, transitions, clip paths.
  Scope your classes with a prefix of your own so they cannot clash with the kit, and take every
  color from the kit's tokens (`var(--good)`, `var(--ink)`, …) so the scene fits both themes and
  both skins.
- **Inline SVG** for shapes the kit lacks: nodes and edges, curves, zones, charts. Give it a
  `viewBox` and `width="100%"` so it scales; a `viewBox` about 700 units wide makes 1 unit about
  1 px on a desktop, so SVG text of `font-size="14"` reads like the kit's small text. Arrowheads
  with `<marker>` and `marker-end="url(#id)"` (a marker does not take its path's color: define one
  per tone); gradients by `url(#id)`; motion without a script with `<animate>` and
  `<animateMotion>`. Keep text in SVG to short labels; longer words go in HTML beside it.
- **A script** to build what would be tedious to write: 120 dots, a grid of cells, rows from a
  small data array (put the data at the top, so it reads), chart points computed from numbers.
- **Canvas** for many moving things: particles, a heat map, a queue of a hundred requests. Size it
  with CSS, set its pixel size from `getBoundingClientRect()` times `devicePixelRatio`, and take its
  colors from `scene.color('bad')`.
- **Animation**: CSS keyframes, the Web Animations API (`el.animate(…)`), or
  `requestAnimationFrame` for a simulation. Play once and hold the end state, or loop gently. With
  `scene.reducedMotion`, draw the end state and stop.
- **Emphasis**: make the thing that changed pulse or glow, and `fade` the rest.

## The frame

- **Where to write it.** Write each scene as its own file, `<landmark id>.scene.html`, and a
  micro-world as `<landmark id>.micro.html`, in the scenes directory the prompt names; publish
  reads them into the landmark. Files keep scripts readable: no escaping.
- **The root.** The frame wraps your fragment; start it with `<div class="scene">`, the column the
  kit lays things out in. A `<style>` and a `<script>` may sit inside it. Each scene is its own
  document in its own frame, so `document.querySelector` finds only its own elements, and two
  landmarks may reuse the same ids and class names.
- **What scripts get.** `window.scene` has `reducedMotion` and `color(name)` (a kit token resolved
  for the current skin and theme, such as `scene.color('good')` → `rgb(26, 127, 55)`).
- **What the frame lacks.** It has no origin, network, storage, eval, or workers; it loads nothing,
  so icons, styles, and scripts are all inline (images as SVG, canvas, or `data:`). A scene takes no
  input: the tour owns clicks, drags, and keys, so a scene is watched, never used. A micro-world
  takes input through its own controls, and only there. Validation refuses `<img>`, frames,
  `<link>`, `<meta>`, forms, `<video>`, `<audio>`, event handler attributes (write code in a
  `<script>`), `url()` of anything but `#id` or `data:`, links, and scripts that use `fetch`,
  `XMLHttpRequest`, `WebSocket`, storage, `eval`, or workers; for a scene, it refuses inputs,
  buttons, and selects too.
- **Size.** At most 12,000 characters per scene; most need far fewer.
- **If a script throws,** what the markup shows is what the reader sees.
- **Seeing it.** `pr-review tour preview` screenshots every landmark as the tour page shows it, on
  a desktop and on a phone, each scene at rest (reduced motion), with a note under any scene whose
  script threw.
- **No secrets, credentials, or protected health information,** even as sample data.

## The kit

- **Layout**: `scene` (the column everything sits in), `row` (items side by side; `row spread`
  pushes them apart), `col`, `grid` (`style="--cols: 3"`), `stack` (items tight on top of each
  other), `controls` (a micro-world's fieldsets, side by side and wrapping).
- **Things**: `box` (a rounded panel; a `label` inside is its caption; `box ghost` dashed and empty,
  `box solid` filled), `chip` (a small pill), `banner` (a full-width bar: the point), `big` (a large
  number or word), `label` (small caps), `small`, `code` (inline code), `strike`, `fade`, `hatch`
  (a hatched fill for what cannot happen: a cell, a slot, a box), `stamp` (a rotated verdict on
  the scene's corner).
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

## Examples

A terminal, for a world landmark on what a typo now prints:

```html
<div class="scene">
  <div class="term" data-title="terminal">
    <span class="cmd">pr-review insall-skill</span>
    <span class="bad">error: unknown command: insall-skill (BAD_REQUEST)</span>
    <span class="bad">hint: run pr-review --help</span>
    <span class="cmd">pr-review install-skill</span>
    <span>Copied the pr-review-canvas skill to:</span>
    <span class="muted">  claude  .claude/skills/pr-review-canvas</span>
  </div>
  <div class="row"><span class="chip muted">before: one JSON envelope on stdout, hint inside it</span></div>
  <div class="banner good"><i data-icon="terminal"></i> A person reads a sentence; a script still reads JSON</div>
</div>
```

The caller's code, for a why landmark on renaming a client method in one clean break:

```html
<div class="scene">
  <div class="file" data-title="src/jobs/sync.ts">
    <span class="muted">// one of 14 call sites</span>
    <span class="del">const pages = await client.fetchAll(repo, { page: 1 })</span>
    <span class="add">const pages = await client.list(repo).pages()</span>
  </div>
  <div class="row"><span class="big warn">14</span><span class="small">files change in this pull request</span></div>
  <div class="banner warn"><i data-icon="git-pull-request"></i> One clean API; the diff grows by 14 files</div>
</div>
```

A screen, for a landmark on what Save does while a request is in flight:

```html
<div class="scene">
  <div class="window" data-title="Settings · Billing">
    <span class="label">billing email</span>
    <span class="field">ops@example.com</span>
    <span class="skel" style="--w: 70%"></span>
    <div class="row spread"><span class="small">saving…</span><span class="btn solid off">Save</span></div>
    <div class="toast good"><i data-icon="circle-check"></i> Saved once</div>
  </div>
  <div class="banner warn"><i data-icon="ban"></i> 1 request, not 2; the button waits on the network</div>
</div>
```

Quantities on one scale and a flow, for a landmark on a new dependency against a hand-written
renderer:

```html
<div class="scene">
  <div class="bars">
    <span class="label">today</span><span class="bar muted" style="--v: 59%"></span><span>112 kB</span>
    <span class="label">+ react-markdown</span><span class="bar warn" style="--v: 81%"></span><span>153 kB</span>
    <span class="label">budget</span><span class="bar bad" style="--v: 79%"></span><span>150 kB</span>
  </div>
  <div class="grid" style="--cols: 3">
    <div class="box">markdown</div>
    <div class="box"><span class="arrow flow" style="--len: 4rem" data-say="parse"></span></div>
    <div class="box good">HTML</div>
  </div>
  <table>
    <tr><th>markdown</th><th>renders</th></tr>
    <tr><td>tables, footnotes</td><td class="good">yes</td></tr>
    <tr><td>links</td><td class="warn">needs an allowlist</td></tr>
  </table>
  <div class="banner warn"><i data-icon="package"></i> Every block kind, 3 kB over the budget</div>
</div>
```

A script, for a landmark on retrying with backoff: the attempts land on a time axis one by one, and
the resting state shows them all.

```html
<div class="scene">
  <div class="rt-axis"></div>
  <div class="row spread"><span class="label bad">upstream down for 20 s</span><span class="label">5 attempts</span></div>
  <div class="banner warn"><i data-icon="timer"></i> The user waits 30 s, then gets the page</div>
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
<div class="scene">
  <div class="row"><span class="big bad">3</span><span class="small">of 120 tenants still send the old field</span></div>
  <div class="uc-dots"></div>
  <ul class="checks"><li class="good">117 tenants: nothing to do</li><li class="bad">3 tenants: migrate by hand</li><li class="warn">rollback: the column stays until v3</li></ul>
  <div class="banner warn"><i data-icon="users"></i> 3 tenants migrate by hand; 117 never notice</div>
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
