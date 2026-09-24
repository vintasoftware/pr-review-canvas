---
name: pr-self-review-fix
model: sonnet
description: Apply the fix list the self-review deck wrote after the author picked sides of its decision cards. Reads `fixes.md`, interviews the author about any entry that is unclear, changes the code, writes the justifications marked for the code, and then deals a fresh deck for whatever the fixes changed. Use when the user runs `/pr-self-review-fix <pr-number>`, `/pr-self-review-fix branch`, `/pr-self-review-fix uncommitted`, or asks to apply their self-review picks or fix list.
---

# pr-self-review-fix

The author settled the decisions of a self-review deck (`/pr-self-review`). Picks that disagree
with the code became a fix list. You apply it: the decisions are made, so your job is to carry
them out faithfully, not to reopen them.

Arguments: a pull request number, `branch`, or `uncommitted`: the review whose deck was cleared.
When the user names none, use the one whose fix list exists; ask when more than one does.

## 1. Find the fix list

```bash
pr-review deck fixes (--pr <n> | --branch | --uncommitted)
```

It prints `{ "review", "path", "exists" }`. Read `path` in full. When `exists` is false, the
author has not cleared the deck yet: tell them to open `/deck/<review>` and finish it first.

It has up to four sections:

- **Fixes**: each entry names where (`path:line`), what the code does now, the side the author
  wants, and why. `Wanted: neither side` carries the author's own words instead.
- **Reasons to write into the code**: kept decisions whose justification belongs next to the code
  as a comment or a doc line. Write them briefly, in the codebase's own comment style.
- **Queued as pull request comments**: the author's answers to questions a reviewer would ask. They
  stay with the deck for the pull request. Do not write these into the code.
- **Left for reviewers**: skipped cards. Do nothing with them.

For a pull request, the fixes go on its branch: the fix list names it in its first line. If this
clone is on another branch, or behind the pull request's head, stop and tell the author which
branch to check out and pull. Never switch branches for them.

## 2. Interview before changing anything unclear

Go through the fixes before editing. For every entry where the wanted change has more than one
reasonable reading, or would reach beyond the files it names, or conflicts with another entry, ask
the author. Use the host's question tool when it has one (such as AskUserQuestion), one round of
up to four questions at a time, each with your recommended answer first. Never ask about
something you can find in the code yourself. Entries that are clear need no question.

## 3. Apply

Change the code entry by entry, in the order the list gives. Keep each change to what its entry
asks; no drive-by refactors. Follow the project's rules (`CLAUDE.md`, `AGENTS.md`, a configured
rulebook) and match the surrounding code. Never log, print, or copy protected health information
or secrets while doing it.

After the edits, run the project's own fast checks (lint, typecheck, and the tests of what you
changed). Fix what they report. Report what fails and cannot be fixed within the entry's scope,
rather than widening the change.

## 4. Deal the next deck

Fixes change code, and changed code can raise new decisions. Deal a fresh deck for the same review
by following `/pr-self-review <review>` without `--force`: prepare carries every decision the
author already settled, so only new questions appear. If the new deck has no cards, tell the
author the change is ready for review; otherwise give them the deck URL again.

The `uncommitted` review sees your edits at once. The `branch` review compares the branch tip, so
it sees them only once they are committed. A pull request's deck reads the head from the forge, so
it sees them only once they are committed and pushed. Ask the author whether to commit (and, for a
pull request, push) the fixes, and deal the next deck after they do. If they would rather not yet,
stop after step 3 and say so.

Do not commit or push unless the author asks. Summarize what changed per fix-list entry, the reasons you
wrote into the code, and anything you asked about.
