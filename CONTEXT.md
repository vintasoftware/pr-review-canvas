# PR Review Canvas

PR Review Canvas helps authors explain a pull request and reviewers examine its changes by intent.

## Language

**Canvas**:
A guided review of one change set of a pull request, combining semantic layers, source diffs, and review notes. It is generated for a particular commit, and keeps applying to any later commit whose diff is identical.
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

**Missing-test point**:
An attention point generated from a behavior with no test. It belongs to the reviewer unless the
writer assigns it to the author, and counts alongside explicitly written attention points.
A carried entry keeps its published title and audience; its anchor follows the carried code.

**Audience**:
Who an attention point is for. An author point asks something the author can answer alone; a reviewer point needs someone else's judgment.
_Avoid_: Severity, priority

**Self-review**:
The author's pass over their own canvas before asking for review, resolving the attention points they can answer.
_Avoid_: Self-approval, pre-review

**Resolved point**:
An attention point the author answered with a reason saved in the canvas. The author may resolve any point, a reviewer point too when it does not apply. It leaves the open-point list and stays readable with its reason for anyone loading that canvas.
_Avoid_: Dismissed, approved, closed

**Dismissal**:
A reader's personal mark that hides an attention point from their own list. Anyone may dismiss, the author too. It does not answer the point for other readers or complete the author's self-review.
_Avoid_: Resolution, approval

**Review progress**:
The reviewer's record of which changes they have examined, kept against the canvas they examined them on rather than against a commit. Progress survives every later commit that canvas keeps applying to.
_Avoid_: Test coverage, approval

**Pending review**:
A review the reviewer is still writing: comments anchored to lines, kept in the local review state
and posted to nobody, until one submission sends them together with a verdict. Discarding it
withdraws nothing, because nothing was ever sent.
_Avoid_: Draft pull request, unsaved comment, queued request

**Local review app**:
The review interface and saved review state on the reviewer's machine. GitHub operations and AI requests still communicate with their respective services.
_Avoid_: Offline AI, code never leaves the machine

**Carried-over canvas**:
A canvas generated for an earlier commit of the pull request, shown as current because the head's diff is identical to the one the canvas was generated from.
_Avoid_: Merge-tolerant canvas, approximately matching canvas

**Incremental canvas**:
A canvas generated for a new commit of a pull request that already had one, built by updating that earlier canvas rather than by starting from a blank page.
_Avoid_: Partial canvas, diff of canvases

**Basis canvas**:
The earlier canvas an incremental canvas is built from: the newest one generated for a commit the head was built on. A canvas from a line of work the head no longer contains is never a basis.
_Avoid_: Parent canvas, carried-over canvas

**Carried**:
Content of the basis canvas reused as it stands, because the head's diff leaves the code it is anchored to untouched. An attention point whose own lines are unchanged is carried even when they moved; only its line numbers follow them. A point the generator wrote is carried only when every file its body links to is untouched too.
_Avoid_: Cached, approved, still valid

**Re-judged**:
Content of the basis canvas that the head's diff touched, or a point the generator wrote whose body links to a file the head touched. The generator decides it anew. It may come back the same, changed, or not at all.
_Avoid_: Invalidated, rejected, expired

**Outdated canvas**:
A canvas of another commit of the pull request that the head's diff no longer matches, shown with the diff of its own commit and a bar saying so. Review marks made on it stay with it and never count for a later canvas.
_Avoid_: Stale review, expired canvas

**Review checkout**:
A copy of the repository at the reviewed commit, kept apart from the reader's own checkout, which the AI chat reads code from. It follows the commit being chatted about, and is removed once nobody has chatted about that review for a while; it comes back on the next chat turn. A review of uncommitted work has none: the chat reads the reader's own checkout, because that is the work under review.
_Avoid_: PR checkout, reader's checkout, working tree, materialized head

**Illustrative sample**:
An attributed walkthrough of selected changes from a public pull request, with editorial layer groupings and scripted chat examples. It demonstrates concepts without claiming to be a complete generated canvas.
_Avoid_: Live review, live AI chat
