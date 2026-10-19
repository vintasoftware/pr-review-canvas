# Tour page prototype brief

Static HTML/CSS prototypes of the tour page (`/tour/<n>`), one file per design. No JavaScript.
The tour page gets its own design, apart from the review canvas: no GitHub, terminal, or olive skin.

## Shared rules

- One self-contained file: `NN-slug.html` in this folder. Inline `<style>`; inline SVG for art.
  Google Fonts `<link>` is allowed. No images from the network, no JS, no frameworks.
- Theme: tourism and guided tours. Playful and colorful, but very readable:
  body prose 16-17px, line height about 1.6, measure about 68ch, WCAG AA contrast on every text.
  Decoration lives around the content (frames, backgrounds, rail, eyebrows), never under prose.
- Buttons and controls feel like GitHub's (Primer): 32px height (40px for the big one), 6px radius
  (a design may round more if the theme asks, but keep the shape), 1px border, a light inset/drop
  shadow, 14px medium-weight label, clear hover and `:focus-visible` rings, a disabled look.
  Default button = neutral; primary ("fill") = the theme's strong color with white text.
  `<kbd>` hints look like GitHub's kbd.
- Each design has its own palette, type, and layout idea. Do not reuse the canvas's look.
- Width: the page column is about 760-860px, centered; it must also work at 390px wide
  (no horizontal scroll; the rail may wrap or scroll inside itself).
- At the top of the body, a small fixed label "Prototype NN · <Design name>" with a link
  "all designs" to `index.html`.

## What the page must show (stack these as screens, top to bottom)

Use exactly this content, so the designs compare like for like. Label each screen with a small
caption above it ("Cover", "Landmark", "Decision", "Quiz", "Plan").

### Header (once, at the top)
- Wordmark "pr-review" · project "vintasoftware/pr-review-canvas" (link).
- Buttons: `canvas`, `regenerate tour`, `export zip`, `help`, and a theme toggle (sun/moon icon).
- Title: "Tour #101 Carry reader picks across regenerated tours" (the "Tour" word is styled).
- Meta: by `fjsj` · `fjsj/carry-picks → main` · `+412 −87` (green/red) ·
  pill "tour by claude · opus-5.5 · acpx" · "generated 3 minutes ago".

### Progress rail (once, under the header, sticky look)
Groups: cover (1 seg) · "5 landmarks" (5 segs) · "3 decisions" (3) · "2 questions" (2) · plan (1).
States: cover done, landmarks 1-2 done, landmark 3 current, rest of landmarks open,
decisions and questions ahead (locked), plan ahead. Make the states obvious without color alone
(shape, icon, or fill pattern). Each segment would be a button; give the theme a metaphor
(stops on a route, stamps, stations, trail markers...).

### Cover
- Eyebrow: tag "Tour" · "#101 · vintasoftware/pr-review-canvas".
- Title: "Carry reader picks across regenerated tours".
- Meta: by fjsj · fjsj/carry-picks → main · +412 −87 in 14 files · guide: `docs/tour-guide.md` ·
  touches: tour store, tour page, chat.
- Agenda (the route ahead), each with a stage label:
  1. Before this change — "Picks lived and died with one tour"
  2. The world — "A decision key outlives its tour"
  3. Why — "Keys come from the anchor, not the title"
  4. Why — "Stale picks wait instead of vanishing"
  5. What to respect — "Never carry a pick across a changed anchor"
- Budget: 5 landmarks · 3 decisions · 2 questions · ~12 minutes.
- Big primary button "start the tour", hint: `→` next · `←` back · `i` code · `?` help.

### Landmark (landmark 3 of 5, stage "Why")
- Return banner (optional state, show it): "Jumped from landmark 2. Decide now, or go back and
  keep reading." + button "back to the landmark".
- Eyebrow: stage tag "Why" · "landmark 3 of 5".
- Title: "Keys come from the anchor, not the title".
- Lead: "A decision's key is a hash of its file and the code around it, so renaming the decision
  keeps the reader's pick."
- Scene: a framed figure (the real one is a sandboxed iframe drawn by the generator). Draw a simple
  inline-SVG diagram in it: two boxes "tour @ a1b2c3" and "tour @ d4e5f6", each with a decision
  card, and an arrow labeled "same key → pick carried". Under it, a "micro-world" box with header
  "micro-world · try it: change the inputs" and a placeholder of two inputs and a result.
- Body (2 paragraphs):
  1. "When the tour is generated again, every decision gets a fresh title. If the key came from
     the title, a reworded decision would look new, and the reader's earlier keep or change would
     be lost. So `decisionKey()` hashes the anchor path and the three lines around it."
  2. "This means a decision moves with its code. Move the function to another file and the key
     changes on purpose: the reader should look again, because the code they judged is gone."
- Chips: "one decision waits here" + link chip "Hash the anchor, or the title? →".
- Note box: label "Something I noticed" (hint "optional"), textarea with placeholder
  "A thought while reading, so you do not have to hold it until the decisions".
- Button "hide code `i`", then the code panel: tabs "literate diff" (selected) / "raw diff";
  one paragraph of prose, then a file label `src/tour/keys.ts` and a diff:
  ```
  @@ -12,7 +12,11 @@ export function decisionKey(d: Decision): string {
  -  return slug(d.title)
  +  const around = linesAround(d.anchor, 3)
  +  return sha1(`${d.anchor.path}\n${around}`).slice(0, 12)
   }
  ```

### Decision (decision 1 of 3, category "Architecture")
- Eyebrow: tag "Architecture" · "decision 1 of 3" · link "from landmark 3: Keys come from the anchor, not the title".
- Title: "Hash the anchor, or the title?"
- Context (lead): "The key decides which picks survive a regenerated tour. The anchor is stable
  while the code is; the title changes with every generation."
- Anchor: `src/tour/keys.ts:14` in mono.
- Your note card: "Your note on landmark 3" — "What if two decisions share an anchor?"
- Three options (radio cards), the first one selected:
  - keep — marks "what the code does" and "the tour recommends" — "Hash the anchor path and
    nearby lines" — "Picks survive rewording. A moved function asks the reader again."
  - alternative — "Hash the decision title" — "Simpler, but every regeneration that rewords a
    title drops the pick."
  - something else — "Something else" — "Neither side: say what you want instead, then approve
    it as restated."
- Try-it card: header "try it · verified when this tour was generated"; ordered steps
  `pnpm start --repo .` and "Regenerate the tour of #101 and open decision 1"; look-for list
  "The pick you made is still selected"; checkbox "I tried it".
- Actions: state "✓ kept" + button "undo". Also show the hint style once:
  "pick one: `k` keep · `a` alternative · `c` something else".

### Quiz (question 1 of 2)
- Eyebrow: tag "Quiz" · "question 1 of 2" · "private · stays on this machine".
- Question: "You move `decisionKey()` into another file. What happens to the reader's picks?"
- Options (numbered 1-3), option 2 answered wrong:
  1. "They carry over: the key ignores the path." 
  2. "They carry over, because the title did not change." (marked wrong)
  3. "They wait as stale: the key changed with the path." (not chosen yet)
- Why box (wrong): "Not quite. The key hashes the anchor path, so a move changes it, and the
  pick waits as stale for the reader to look again." + button "reopen landmark 3: Keys come from
  the anchor, not the title" + hint "then answer again".

### Plan (short)
- Eyebrow tag "The plan". Title "1 change to make, 2 kept".
- Lead: "Read it once. When you confirm, the prompt is written and the record is shared."
- Changes: 1 item — "Stale picks wait instead of vanishing" / "Show stale picks in a separate
  list on the plan." `src/tour/plan.ts:40`.
- Kept: 2 items (label + consequence).
- Primary "confirm the plan" + hint "writes the prompt, shares the record" + button
  "restate the plan with the agent".

### Footer nav (sticky look at the bottom of the landmark screen, or once at the end)
`← back` · "landmark 3 of 5" · primary `next: landmark 4 →`.
