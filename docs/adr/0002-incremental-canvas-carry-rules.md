# Carry an incremental canvas forward only where the diff is untouched, and let the reviewer decide about marks

A canvas regenerated for a new head starts from the basis canvas: the newest canvas of a commit the
head was built on. `pr-review prepare` splits the basis per file. Content anchored only in files
whose patch is byte-identical is carried as it stands. Everything else is re-judged by the
generator, along with the summary and risk.

The split is per file, never per hunk or line. Hunk ids, fold ranges, and annotation lines only
make sense against the exact diff the canvas was generated from; this is the same reason a
carried-over canvas requires an identical diff. Matching moved hunks would add a second, looser
definition of "the same code" beside the strict one.

The published canvas does not decide review marks. A mark means "I have read this code", so if the
author's canvas said which layers a reviewer may skip, the author's machine would grant review
credit. An incremental canvas records only `basisCanvasSha`. Each reviewer's server recomputes the
unchanged layers and files from the two canvases and its own clone before carrying any mark
forward. A reviewer who never had the basis canvas carries nothing.

Marks are keyed by the generator-chosen `layer.key` instead of the positional `layer-N`, because a
key survives a regeneration that reorders layers. The validator already refuses duplicate keys.
