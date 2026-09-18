# PR Review Canvas

PR Review Canvas helps authors explain a pull request and reviewers examine its changes by intent.

## Language

**Canvas**:
A guided review of a particular pull request revision, combining semantic layers, source diffs, and review notes.
_Avoid_: Hosted review, automated approval

**Semantic layer**:
A group of related changes that explains one behavior, concern, or decision, even when those changes span files. Different parts of one file can belong to different layers.
_Avoid_: Directory, commit, stacked PR

**Chunk**:
A contiguous section of a file’s diff, including its changed lines and surrounding context. Each chunk belongs to exactly one semantic layer in a canvas.

**Fold**:
A collapsed range of a diff that a reviewer can expand to inspect. Folding a change does not mean it has been reviewed.
_Avoid_: Excluded code, deleted context

**Attention point**:
A concern anchored to changed code that asks the reviewer to decide, check, or take note.
_Avoid_: Proven bug, automatic finding

**Review progress**:
The reviewer's record of which changes they have examined for a particular revision.
_Avoid_: Test coverage, approval

**Local review app**:
The review interface and saved review state on the reviewer's machine. GitHub operations and AI requests still communicate with their respective services.
_Avoid_: Offline AI, code never leaves the machine

**Carried-over canvas**:
A canvas generated for an earlier commit of the pull request, shown as current because the head's diff is identical to the one the canvas was generated from.
_Avoid_: Merge-tolerant canvas, approximately matching canvas

**Outdated canvas**:
A canvas of another commit of the pull request that the head's diff no longer matches, shown with the diff of its own commit and a bar saying so. Review marks made on it stay with it and never count for a later canvas.
_Avoid_: Stale review, expired canvas

**Illustrative sample**:
An attributed walkthrough of selected changes from a public pull request, with editorial layer groupings and scripted chat examples. It demonstrates concepts without claiming to be a complete generated canvas.
_Avoid_: Live review, live AI chat
