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
  - `consequence`: what follows from picking it, cost included, in one or two sentences. It sits
    on the card's front, above the scene.
  - `snippet` (optional): `{ "code": "...", "lang": "ts" }`, at most {{SNIPPET_MAX_LINES}} lines
    that show this side: the change's own code for the current side, an outline of the other.
    `lang` is a highlight.js language name; leave it out to use the anchor file's. Snippets show
    on the card's back, next to the chunk of the diff the card is anchored to.
  - `scene`: this side's consequence as a small picture. See **The scene**.
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

## The scene

The front of a card shows the title and, per side, its label, its one-line `consequence`, and its
`scene`: a small HTML fragment that pictures what happens when the author picks that side. The
reasons and the code are one key away, on the card's back, and most authors decide from the front
alone. So the scene carries the side: at a glance, it shows **what happens, to whom, and what it
costs**.

- **Concrete beats abstract.** Name the real thing: the error code, the file, the command, the
  count, the person. `3 drafts → CANVAS_STALE, nothing posted` beats "some drafts may be stale".
- **Same scene on both sides.** Draw both sides of a card with the same actors in the same order,
  so the eye goes straight to what differs: the count, the color, the banner.
- **One outcome.** End with a `banner` that states the side's consequence, cost included, in a few
  words, toned `good`, `bad`, or `warn`.
- **Few things, big.** Two or three boxes and an arrow or two, a big number where a count matters.
  The frame is about 600 × 440 pixels on a desktop; a scene that needs more reads as clutter.
- **Complementary to the consequence line**, which sits right above the scene: the line says it in
  a sentence, the scene shows the end state with the numbers. Do not repeat the sentence.

A scene is written with the kit's classes, and the browser lays it out: write structure, never
coordinates. The frame wraps your fragment in its root, so start with `<div class="scene">`.

- Layout: `scene` (the column everything sits in), `row` (items side by side; `row spread` pushes
  them apart), `col`, `grid` (`style="--cols: 3"`), `stack` (items tight on top of each other).
- Things: `box` (a rounded panel; a `label` inside it is its caption; `box ghost` dashed and
  empty, `box solid` filled), `chip` (a small pill), `banner` (a full-width bar: the outcome),
  `big` (a large number or word), `label` (small caps), `small`, `code` (inline code), `strike`,
  `fade`.
- Tones, on any element: `ink` (this side's color), `good`, `bad`, `warn`, `muted`. A toned `box`,
  `chip`, `banner`, `big`, `label`, or `small` colors itself; inside a filled `chip`, `banner`, or
  `box solid`, text and icons turn to the paper color on their own.
- Icons: `<i data-icon="database" class="lg"></i>`, by [Lucide](https://lucide.dev/icons) name:
  `user`, `users`, `message-square`, `git-pull-request`, `git-commit-horizontal`, `file-code`,
  `database`, `server`, `cloud`, `hard-drive`, `lock`, `lock-open`, `key-round`, `shield-check`,
  `shield-alert`, `clock`, `timer`, `hourglass`, `triangle-alert`, `circle-x`, `circle-check`,
  `ban`, `refresh-cw`, `repeat`, `copy`, `trash-2`, `eye`, `eye-off`, `send`, `inbox`,
  `list-checks`, `bug`, `zap`, `package`, `settings`, `terminal`, `history`, `undo-2`, `split`,
  `merge`, `layers`, `link`, and any other Lucide name. Sizes: none (text size), `lg`, `xl`; leave
  the size off inside a `chip`.
- Arrows: `<span class="arrow"></span>` points right, `arrow down` points down, `style="--len:
  4rem"` sets its length, `data-say="retry"` writes a word on it, `arrow flow` animates things
  moving along it, `arrow blocked` crosses it out.
- Motion: `pulse`, `bob`, `shake` (a failure), `blink`, `spin` loop; `enter` on a parent deals its
  children in one by one. `on-pick` shows an element only once the author picks this side (a stamp,
  a check); keep it for decoration, since the scene must read before the pick. `off-pick` fades an
  element then.
- Inline `<svg>` is allowed for a shape the kit lacks, and `style` attributes for sizes and colors
  (use the tones' variables: `var(--good)`, `var(--bad)`, `var(--warn)`, `var(--ink)`).
- Not allowed, and refused by validation: `<script>`, `<img>`, `<style>`, forms and inputs,
  frames, event handler attributes, `url(...)`, and links anywhere. At most 4000 characters. The
  frame runs no script and loads nothing, so anything else would silently not show.
- No secrets, credentials, or protected health information, even as sample data.

Validation checks what a scene may contain and that its icons exist; it cannot see the layout.
Keep scenes as small as the rules above ask and they fit.

For the example card below, side A (skip empty rows):

```html
<div class="scene">
  <div class="row">
    <div class="box"><i data-icon="file-code" class="lg"></i><span class="label">export.csv</span><span class="big">120</span><span class="small">rows, 3 blank</span></div>
    <span class="arrow flow" style="--len: 3rem" data-say="import"></span>
    <div class="box good"><i data-icon="database" class="lg"></i><span class="label">imported</span><span class="big">117</span></div>
  </div>
  <div class="banner warn"><i data-icon="eye-off"></i> A blank row in the middle goes unnoticed</div>
</div>
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
        "scene": "<div class=\"scene\"><div class=\"row\">…</div><div class=\"banner warn\">…</div></div>",
        "why": "Empty rows only come from the old export tool, which pads its files.",
        "record": "pr-comment"
      },
      "b": {
        "label": "Fail with the row number",
        "consequence": "Nothing is ever dropped quietly, but every old export needs cleaning first.",
        "scene": "<div class=\"scene\"><div class=\"row\">…</div><div class=\"banner bad\">…</div></div>",
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
