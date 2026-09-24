---
name: pr-self-review
model: opus
description: Deal a self-review deck for a GitHub pull request or GitLab merge request, or for the work in this clone before one exists, with the pr-review tool. Runs `pr-review deck prepare`, writes the deck-model.json of decision cards the prompt asks for (trade-offs and choices a reasonable engineer could make either way, each with sides A and B), validates and publishes it, and points the author to the swipe page. Use when the user runs `/pr-self-review <pr-number>`, `/pr-self-review branch`, `/pr-self-review uncommitted`, or asks to self-review, settle decisions, or "swipe through" their change before it is reviewed.
---

# pr-self-review

You write a short deck of **decision cards** for the author's own change and hand it to the
`pr-review` CLI. Each card is one choice the change makes that a reasonable engineer could make
either way, with two sides, A and B. The author picks a side per card on a swipe page. Picks that
disagree with the code become a fix list for `/pr-self-review-fix`; kept picks become short
justifications that reviewers read instead of asking again.

The deck is not the review canvas. It holds no layers, folds, or attention points, and plain
defects do not belong in it: `/pr-review-canvas` reports those.

Arguments: `<pr-number> [--force]`, `branch [--base <ref>] [--force]`, or
`uncommitted [--base <ref>] [--force]`. A number is a pull request (or merge request): its head
and base come from the forge, fetched into this clone, so any checkout works. `branch` is the tip
of the current branch; `uncommitted` adds the working tree's edits and new files on top. When the
user only says "review my work", ask which, unless the words decide it ("before I commit" is
`uncommitted`, "my PR" with a number is the number). Run every `pr-review` command from the repository root. Nothing here
checks out a branch or writes outside the deck's work directory.

## Model choice

Use the most capable model, such as Opus, to write the deck. The deck is at most ten cards, and
each one has to be a real trade-off, anchored on the right line, with both sides argued fairly;
a weaker model tends to deal checklist items or strawman one side. When delegating to another
agent, pass it the prepared prompt path and have it run on that model. Honor an explicit user
model choice. If the host cannot select models, keep its selected model. Never copy PHI,
secrets, or credentials into a card, even as an example.

## 1. Prepare

```bash
pr-review deck prepare --pr <n> [--force]
pr-review deck prepare --branch [--base <ref>] [--force]
pr-review deck prepare --uncommitted [--base <ref>] [--force]
```

A pull request is compared against its own base branch, so `--pr` takes no `--base`.

The last stdout line is JSON with `promptPath`, `modelPath`, `maxCards`, `settled`, `base`,
`headRef`, `uncommitted`, and `status`.

- `status: "exists"` means the deck already stands for this head. Tell the user to open it, or to
  run again with `--force` for a fresh deck.
- `settled` counts decisions carried from an earlier deck of this review. The prompt lists them;
  do not ask them again unless the code still contradicts the side the author picked.
- An `{ "error": … }` line means prepare failed: report the code, message, and hint verbatim.

Tell the user which base was compared and, for a local review, whether uncommitted work was
included.

## 2. Write the deck

Read `promptPath` in full: it holds the categories of decisions, the rules for a card, the caps,
the diff, and the output shape. Write `modelPath` as JSON only, with the host's file-writing tool.
At most `maxCards` cards; fewer when fewer decisions are real, and zero is a valid deck.

A good card is concrete: both sides are real options for this code, each with its cost, and the
`why` of each side is a sentence the author could say as their own. Mark `current` truthfully:
it is what the code does now, and it decides whether a pick becomes a fix.

Give every side a `scene`, as the prompt's **The scene** section describes: most authors decide
from the card's front, so each scene has to show its side's consequence and cost at a glance,
with real names and numbers. You cannot see a scene rendered; keep it as small as the section
asks, and validation names what the frame would drop.

## 3. Validate, then publish

```bash
pr-review deck validate (--pr <n> | --branch | --uncommitted) --human
```

Fix every line it prints and run it again until it says `ok`. Caps are measured on visible text,
so shorten wording rather than dropping a side's cost. Then:

```bash
pr-review deck publish (--pr <n> | --branch | --uncommitted) --agent <your agent id> [--model <model id>]
```

`DECK_STALE` means the pull request, the branch, or the working tree changed while you worked: offer to prepare
again rather than passing `--allow-stale`. `DECK_INVALID` prints one line per problem; fix them and
publish again, at most three times.

## 4. Hand over

Report the number of cards and the `deckUrl` (`http://localhost:<port>/deck/<n|branch|uncommitted>`),
and tell the user to start `pr-review serve` if it is not running. On the page:

- `a` picks side A, `b` picks side B, or drag the card left or right;
- `n` says neither side fits and takes a note, `s` skips a card and leaves it to reviewers;
- `u` undoes, `e` edits a justification, `o` shows the code, `?` lists every key.

When the deck is cleared, the page writes the fix list and suggests `/pr-self-review-fix <review>`.
