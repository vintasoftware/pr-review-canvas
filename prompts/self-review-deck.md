# Self-review deck for {{TARGET_WORD}}

The author of this change wants to settle the decisions that are theirs to make before reviewers
weigh in, whether the pull request is not opened yet or has just been. Write a short deck of **decision cards**. Each
card offers two sides, A and B, of one choice the change makes. The author picks one side per
card, one card per screen, without scrolling. Picks that disagree with the code become a fix list
for a coding agent. Picks the author keeps become short justifications that reviewers read
instead of asking again.

You read and write only. Do not check anything out, run tests, or write anywhere except
`{{MODEL_PATH}}`.

## What earns a card

A card is a choice **a reasonable engineer could defensibly make either way** for this change.
If one side is plainly right, it is not a decision: leave it out (the review canvas reports plain
defects). If you cannot name a concrete cost on each side, leave it out. Prefer a card that removes
a reviewer's question over one that repeats what the diff already makes obvious.

Look for these, and use the bucket named in brackets:

- **Rare case: handle it or simplify** [trade-off]. Support the edge case, fail loudly on it, or
  declare it out of scope.
- **Backwards compatibility or a clean break** [trade-off]. Shims, reading both formats, and
  deprecated fields, against breaking and migrating now.
- **Generality or YAGNI** [trade-off]. An option, parameter, or abstraction added for one caller.
- **Failure policy** [trade-off]. Retry, degrade, or fail fast; atomic or best-effort updates.
- **Performance or plainness** [trade-off]. Caching, precomputing, or batching against simple code.
- **An assumption on an ambiguous requirement** [intent]. Where the request or the code's own
  description can be read two ways and the change picked one. Name both readings.
- **A behavior change nobody asked for** [intent]. Something existing callers or users may rely
  on that now works differently.
- **Scope** [intent]. Unrelated changes riding along: keep them here or move them to another change.
- **Delete complexity or move it** [shape]. A restructuring that would make a branch, a mode, or a
  helper disappear instead of adding one.
- **Where the logic lives** [shape]. The layer or module that owns it, against where the change put it.
- **Reuse or build** [shape]. A new dependency or a hand-written version of what the codebase or a
  library already does: lock-in, license, and size against fit.
- **Convention or new pattern** [shape]. A new way of doing something the codebase already does
  one way: it becomes a precedent.
- **Public contract and naming** [shape]. New API, CLI, config, schema, or domain names that will
  be expensive to rename. Check the project glossary when there is one.
- **A silent fallback or an explicit rule** [risk]. Optional types, defaults, and casts that hide
  an unclear rule.
- **A claim against the code** [risk]. A comment, name, or document that promises what the values
  do not deliver, when fixing the claim and fixing the code are both reasonable.
- **Values that must agree** [risk]. Timeouts, windows, and sizes chosen against each other.
- **Stored data shape and migrations** [risk]. Copying derived values, reversibility, and existing rows.
- **Accepting a test gap** [risk]. Write the test now, or accept the gap with a reason.
- **Security and privacy posture** [risk]. Trust boundaries, what is logged, and permission scope.
  Never log or display protected health information or secrets in a card.
- **Shortcut now, follow-up later** [risk]. Fix a known debt in this change, or record it and move on.

The bucket is a label for the reader, not a rule: when a decision fits two, pick the one that
names what the author must weigh. Validation never checks it.

Rank by consequence: what it costs to get the decision wrong once the change is merged. Among
decisions of similar consequence, security and privacy come first, then unrequested behavior
changes. Write at most **{{MAX_CARDS}}** cards for this change ({{CHANGED_LINES}} changed lines).
The number is a ceiling, not a target: stop at the last decision that is real, and zero cards is
a valid deck. When more real decisions remain than fit, drop the ones with the least consequence.

## Where the code is

- Every file this change touches, as it is at the head: `{{HEAD_DIR}}/<path>`; at the base:
  `{{BASE_DIR}}/<path>`.
- The patch of each file, labeled with its chunk ids: `{{PATCH_DIR}}/<file key>.diff`. A chunk id
  is `<file key>#<n>`, so the file key is the part before the `#`.
- Any other file of the repository, to check a convention or the glossary against the rest of the
  codebase: `git show {{HEAD_SHA}}:<path>` from the repository root. Change nothing in the clone.
- A chunk header `@@ -a,b +c,d @@` starts the head side at line `c` and the base side at line `a`;
  count down from there, or read the line number from the head file.

{{SETTLED}}

## How to write a card

- `key`: a lowercase slug that names the decision, such as `csv-empty-rows`. Keep it stable: a
  later deck reuses the key when it asks about the same decision again.
- `bucket`, `topic`: the bucket above, and the kind of choice in a few words ("Rare case vs
  simplify").
- `title`: the decision in plain words, as a question or a noun phrase.
- `context`: one or two sentences on what the code does and why the choice matters now.
- `path`, `line`, `side`: an anchor inside one chunk of the diff. `side` is `"new"` (the head, the
  default when omitted) or `"old"` (the base, for code the change deletes). `line` is any line of a
  chunk on that side, changed or context; pick the one the decision is about. It is where the
  author reads the code and where a justification is posted.
- `a`, `b`: the two sides. The card itself recommends neither: each `consequence` states that side's
  cost as plainly as its benefit, and each `why` is the best case the author would make for that
  side. Which side is A does not matter; publish shuffles them. Each has:
  - `label`: the choice in a few words.
  - `consequence`: what follows from picking it, cost included, in one or two sentences.
  - `snippet` (optional): `{ "code": "...", "lang": "ts" }`, at most {{SNIPPET_MAX_LINES}} lines
    that show this side: the change's own code for the current side, a sketch for the other.
    `lang` is a highlight.js language name; leave it out to use the anchor file's.
  - `sketch`: a small p5 animation of this side's consequence. See **The sketch** below. Every
    side gets one; a side without it shows its consequence as plain text instead.
  - `why`: the one-line justification the author accepts by picking this side. Write it in the
    author's voice ("Empty rows are exports from the old tool; skipping them is expected.").
  - `record`: where that justification belongs once picked. Ask who needs the reason, and when:
    - `code` when it stays true after the change merges and the next maintainer needs it where
      they read the code: an invariant, a case deliberately left out, why the obvious simpler
      version is wrong. The fix skill writes it as a comment or a doc line.
    - `pr-comment` when it answers a question a reviewer of this change would ask and matters
      little once merged: why this scope, why this order of work, why not the alternative now.
    - `none` when the code itself will show it, which is usually the side that changes the code.
- `current`: `"a"` or `"b"` for the side the code implements now, or `null` when it does neither.

## The sketch

The front of a card shows only the title, each side's label, and each side's sketch. The words
(context, consequences, snippets, justifications) are one key away, on the card's back, and most
authors will not turn it over. So the sketch carries the side: at a glance, it shows **what
happens if the author picks it**, to whom, and what it costs.

- **One idea per sketch.** Two to five things on the stage: actors as boxes or icons, and what
  moves between them. A reader should get it in two seconds.
- **Fill the stage.** The scene spans most of the 400 × 300 stage, with actors big enough to read
  from across the room (boxes 80 to 140 wide, icons 40 to 64). A small scene in the middle of an
  empty stage reads as a thumbnail.
- **Same scene, different outcome.** Draw both sides of a card with the same actors in the same
  places, so the eye goes straight to what differs: the row that is dropped on one side and
  stopped with an error on the other; the request that waits on one and fails fast on the other.
- **Show the cost, not only the benefit.** The side's price belongs in the picture: a pile-up, a
  red cross, a lock left open, a clock running, a second box to maintain.
- **Loop gently, then pay off.** While the card is up, the scene loops (`ui.loop`, `ui.pulse`,
  `ui.t`); leaning toward a side speeds its clock up on its own, and the side the author did not
  pick slows down and dims on its own. When the author picks the side, `ui.beat` runs from 0 to 1
  over 0.7 seconds: land the consequence then, good or bad (a check pops, the pile falls, the red
  cross stamps down).
- **The still frame must read alone.** With reduced motion the sketch is drawn once, at
  `ui.t = 1.2` with `ui.beat = 0`. Keep the cost visible all the time rather than only at some
  moment of the loop; a cost that comes later in a sequence (a retry, a second post) can sit on
  the stage throughout, faded, as the end state. Avoid thresholds that land exactly on 1.2
  (`ui.loop(2.4)` is 0.5 there).
- **Few words.** At most five texts on the stage, box labels included, each at most three
  words, at size 12 or more. The label above the sketch already names the side; do not repeat it.
- **Same scene on both sides.** Each sketch is its own code, so write the shared scene twice with
  the same coordinates; only the outcome differs.
- No secrets, credentials, or protected health information, even as sample data.

A sketch is the **body** of `function (p, ui) { ... }`, a complete function body in p5 2.x
instance mode, at most 3000 characters. It assigns `p.draw` (required) and `p.setup` (optional);
the frame creates the canvas, clears it before every frame (leave the background alone), wraps
each frame in `push`/`pop` so style never leaks from one frame to the next, and scales the stage
to fit.

- The stage is `ui.w` × `ui.h` = 400 × 300, origin at the top left. Keep a margin of 12. Use
  `ui.w` and `ui.h`, never `p.width`, which is the canvas in pixels.
- Colors: `ui.ink` (this side's color), `ui.fg`, `ui.muted`, `ui.paper`, `ui.line`, `ui.good`,
  `ui.bad`, `ui.warn`. Use them rather than your own, so the sketch fits both themes.
- State: `ui.t` (seconds on this side's clock), `ui.beat` (the payoff, 0..1), `ui.state`
  (`idle`, `lean`, `picked`, or `other` when the author picked the other side), `ui.side`.
- Motion helpers: `ui.loop(period = 2)` 0..1 repeating, `ui.pulse(period = 1.6)` 0..1..0,
  `ui.ease(f)`, `ui.along(points, f)` for the `[x, y]` a fraction of the way along a polyline.
- Drawing kit. Every position is a center unless it says otherwise.
  - `ui.box(x, y, w, h, label?, { fill, stroke, color, weight, dash, at })`: a rounded box with
    its top-left corner at `x, y`, filled with `ui.paper` and stroked with `ui.fg` by default. The
    label sits in the middle at size 14; `at: 'top'` or `at: 'bottom'` moves it to that edge at
    size 13, which leaves the middle free for what the box holds. `dash: true` dashes the border.
  - `ui.label(text, x, y, { size = 14, color = ui.fg, align = 'center', bold })`: text centered
    on `x, y` (with `align: 'left'` or `'right'`, `x` is that edge).
  - `ui.arrow(x1, y1, x2, y2, { color = ui.fg, weight = 2, dash, head = true })`: head at `x2, y2`.
  - `ui.dot(x, y, r = 6, color = ui.ink)`: a filled circle of radius `r`.
  - `ui.icon(name, x, y, size = 32, color = ui.fg)`: a stroked icon centered on `x, y` in a
    `size` × `size` square. Icons: `user`, `users`, `server`, `db`, `file`, `lock`, `unlock`,
    `key`, `clock`, `check`, `cross`, `warn`, `bug`, `gear`, `cloud`, `bolt`, `eye`, `trash`,
    `shield`, `list`, `package`, `branch`, `chat`, `flag`, `hourglass`.
- Any p5 drawing call on `p` works: shapes, color, transforms, `p.lerp`, `p.noise`,
  `p.drawingContext.setLineDash([4, 4])` for a dashed shape, and so on. Call `p.randomSeed(1)` in
  `p.setup` if you use `p.random`, so the sketch is the same every time.
- A sketch draws and nothing else. It may not use `window`, `document`, `fetch`, `eval`, or any
  other page, network, or storage global, and may not call `p.createCanvas`, `p.load*`,
  `p.save*`, `p.select*`, `p.create*` elements, or `p.http*`. It runs in a sandbox without them.

You cannot see the sketch, so validation looks for you. It draws each sketch without a browser
at seven moments (the loop, a lean, the still frame, the payoff, the other side picked) and
refuses one that: does not parse, names what the sandbox withholds, never assigns `p.draw`,
throws or runs for more than a second, draws nothing, or draws a label smaller than 12, off the
stage, on top of another label, under a filled shape drawn after it, or crossed by a line or an
icon. It estimates a label as 0.56 × its size wide per character (about 8 per character at size
14) and 1.2 × its size tall, so give labels that much room. Draw containers first and what they
hold after, and labels last: `ui.box` is filled, so a box drawn late hides what is under it. To
fade something, draw it in `ui.line` or `ui.muted`, or set `p.drawingContext.globalAlpha`
inside `p.push()` / `p.pop()`. What validation cannot judge is whether the picture tells the
consequence: that part is yours.

For the example card below, side A (skip empty rows):

```js
const rows = [0, 1, 2, 3, 4]
p.draw = () => {
  ui.box(20, 110, 90, 80, 'export')
  ui.box(290, 110, 90, 80, 'imported')
  const f = ui.loop(2.5)
  rows.forEach(i => {
    const x = p.lerp(110, 290, (f + i / 5) % 1)
    const empty = i === 2
    if (empty && x > 190) return
    p.noStroke()
    p.fill(empty ? ui.line : ui.ink)
    p.rect(x - 10, 142, 20, 16, 3)
  })
  ui.label('blank row gone', 200, 225, { size: 12, color: ui.muted })
  if (ui.beat > 0) ui.icon('check', 335, 80, 36 * ui.ease(ui.beat), ui.good)
}
```

## Length caps

Caps count the characters a reader sees; backticks and link targets do not count.

{{CAPS}}

## Output

Write `{{MODEL_PATH}}` as JSON only, no prose and no fence:

```json
{
  "cards": [
    {
      "key": "csv-empty-rows",
      "bucket": "trade-off",
      "topic": "Rare case vs simplify",
      "title": "What happens to empty CSV rows?",
      "context": "The importer skips rows with no cells. Older exports end with empty rows, and a typo can create them too.",
      "path": "src/import/csv.ts",
      "line": 42,
      "current": "a",
      "a": {
        "label": "Skip them silently",
        "consequence": "Old exports import cleanly; an accidental blank row in the middle goes unnoticed.",
        "snippet": { "code": "if (row.every(cell => cell === '')) continue" },
        "sketch": "const rows = [0, 1, 2, 3, 4]\np.draw = () => { ... }",
        "why": "Empty rows only come from the old export tool, which pads its files.",
        "record": "pr-comment"
      },
      "b": {
        "label": "Fail with the row number",
        "consequence": "Nothing is ever dropped quietly, but every old export needs cleaning first.",
        "sketch": "p.draw = () => { ... }",
        "why": "An import should never drop data without saying so.",
        "record": "none"
      }
    }
  ]
}
```

Then run `pr-review deck validate {{REVIEW_FLAG}} --human` and fix every problem it names.

## The change

{{META}}

### Files and chunks

{{MANIFEST}}

{{RULEBOOK}}

### Diffs

{{DIFFS}}
