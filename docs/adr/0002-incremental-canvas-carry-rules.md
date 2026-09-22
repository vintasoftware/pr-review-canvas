# Carry an incremental canvas forward only where the diff is untouched, and let the reviewer decide about marks

A canvas regenerated for a new head starts from the newest canvas of a commit the head was built on
(the basis canvas), and `pr-review prepare` splits that basis deterministically: content anchored
only in files whose patch is byte-identical to the basis's is carried as it stands, everything else
is re-judged by the generator, along with the pull-request-wide summary and risk. The split is
per file and never per hunk or per line, because the hunk ids, fold ranges, and annotation lines of
a canvas only mean anything against the exact diff it was generated from — the same reason the
carried-over rule of ADR-adjacent work refuses anything but an identical diff. Matching moved hunks
would put a second, looser notion of "the same code" in the codebase beside the strict one.

Review marks are the part a published artifact must not decide. The author generates the canvas;
each reviewer keeps their own marks, and a mark means "I have read this code", so an artifact that
announced which layers a reviewer may skip would let the author's machine grant review credit.
An incremental canvas therefore records only `basisCanvasSha`, and the reviewer's own server
recomputes the unchanged layers and files from the two canvases and its own clone before carrying
any mark forward. A reviewer who never had the basis canvas locally carries nothing, which is
exactly today's behavior. This is why marks are keyed by the generator-chosen `layer.key` rather
than the positional `layer-N`: a key survives a regeneration that reorders the layers, and the
validator already refuses duplicates.
