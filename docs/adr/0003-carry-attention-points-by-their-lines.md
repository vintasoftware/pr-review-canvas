# Carry an attention point by its lines when its file changed around it

This supersedes one part of ADR 0002: the rule that an attention point is carried only when its
whole file is untouched. Layers, files, notes, folds, annotations, and review marks still follow
ADR 0002 unchanged.

A point names a few lines, not a file. Under the file rule, one edit anywhere in a file sent every
point in it back to the generator, which then judged the same code a second time and could come
back with a new title, and so a new fingerprint that lost the reviewer's dismissal. `pr-review
prepare` now also carries a point of a changed file when its own lines are unchanged: every line
has the same text and is shown by the head diff with the same row (`+`, `-`, or context) as in the
basis diff, and the lines form one block that only moved. The block is found by a shortest edit
script (Myers) between the two versions of the file on the point's side, the head versions for a
new-side point and the merge-base versions for an old-side one. The split records the lines the
point sits on in the head, so the generator moves it rather than finding it again.

ADR 0002 refused per-line matching because a second, looser notion of "the same code" would sit
beside the identical-diff rule. This rule is not looser: it compares text and diff rows exactly,
and it only ever reuses the point's own words, which are anchored to nothing but those lines. A
fold or an annotation is still carried only with an untouched file, because its meaning depends on
the rows around it, and a review mark still follows only a byte-identical patch, because a mark
claims the reviewer read the whole file. Where repeated lines make more than one match
possible, the rule takes the one the shortest edit script picks, deterministically. When this
machine lacks either version of the file, or the two versions differ by more than
`MAX_LINE_EDITS` lines, the point is re-judged as before.
