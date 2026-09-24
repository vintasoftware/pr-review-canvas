# Generate the self-review deck in its own pass, and feed its settled decisions to the canvas

The self-review deck lets an author close decisions on their own change before reviewers see it. Its cards and the canvas's attention points come from the same diff, but we generate the deck with its own skill and store it as its own file for each local review, rather than adding cards to the canvas's `model.json`. Applying the picks is a second, separate skill. Keeping each skill's prompt small was worth reading the diff twice.

The two artifacts meet only through settled decisions. Canvas generation for the pull request reads them. It never raises a settled decision again as a `decide` point, except when the head code contradicts the side that was picked. A card the author skipped becomes an open decision for reviewers. Publishing posts each settled decision whose side calls for a comment as the author's own comment, re-anchored on the pull request head.

## Considered Options

- **Cards in the same generation pass as the local canvas.** One read of the diff, but a larger prompt, and the deck would inherit the canvas's layer and fold machinery that it does not use.
- **Cards as an `alternative` field on attention points.** Less schema, but decisions would compete with `check` and `fyi` points for one budget, and a point has no second side to pick.
