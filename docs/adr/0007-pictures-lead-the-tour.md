# Pictures lead the tour, chosen by technique and taught by a gallery

The first tours read as prose with a picture appended. Each landmark was a title, a lead, two or
three paragraphs, and then a scene that ended in a banner restating the lead, so a reader met the
same point four or five times. The scenes came from one small kit and looked alike: boxes, arrows,
and a banner. The preview screenshot stopped at the window's edge, so the generator often never
saw the scene it had drawn below the prose.

We changed the tour so the picture carries each landmark, and we judged the change on real pull
requests (ky#848, click#3818, netbox#22549, and this project's #91) with two outside judges, a
Fable model that decided and GPT-6-Astra as a second opinion, blind to which version was which.

- **The page.** A landmark shows its title and lead, then its scene up to 1120 px wide, then a
  body of at most two paragraphs that says what the picture cannot. No banner restates the lead.
  The cover lists the landmarks by title instead of quoting one.
- **A technique per scene.** Each scene names the kind of picture it draws (a sequence, a lineage
  map, a scenario matrix, a code-map, a boundary picture), and validation refuses a third scene of
  one technique, so the same picture is not dealt over and over. The scene guide is a catalog of
  about thirty techniques grouped by the kind of idea, and a shared change grammar: added green,
  changed amber, removed red and struck through, unchanged context gray, one hero.
- **A gallery of real pull requests.** The skill ships twenty exemplars drawn from merged pull
  requests in MIT, BSD, and Apache-2.0 projects, each one technique at its best. They ship as HTML;
  `pr-review tour gallery <slug>` draws the ones a generator asks for, so an installed skill
  carries no images.
- **More room for behavior.** A tour may have two micro-worlds, and one may stand in for its
  landmark's scene; the guide adds patterns that show behavior (a before/after twin of old and new
  code, a trace player, a race lab, a state explorer, a record bench).
- **A generator that can see.** Preview shoots each scene alone at its width and every decision
  and question, and draws the frames in Chrome's main process so its virtual time waits for them.
- **Exact prose.** The prompt asks for each behavior's edge, a check of the ten strongest claims,
  the review threads read for settled decisions, one home per claim, and prediction questions.

## Considered options

- **Keep scenes inside the prose column and only improve the guide.** Cheaper, but the judges'
  main complaint was that pictures came after the prose and repeated it; the order had to change.
- **A deterministic renderer fed a typed graph**, as PR Lens does. Legible and consistent, but it
  offers two kinds of diagram; its judged walkthroughs scored 4 to 6 against the tour's 7 to 9,
  mostly for one picture dealt many times and no room for state, timing, or UI.
- **A fixed set of graph views**, as Warp's pr-walkthrough does. It reads review threads well, but
  four views of boxes and arrows judged 4 to 6 for the same reason.
- **Ship the gallery's pictures as PNGs.** Simpler for the generator, but 2.4 MB copied into every
  project that installs the skill.
- **A rule for each fault the judges found.** We tried it twice. A third version added bookends,
  anchored code listings, branch-checked universals, and new techniques; a fourth went back to the
  lighter prompt and added five checks the judges had confirmed against the code. Neither beat the
  lighter prompt: the third summed 31.3 against its 31.8 over the four pull requests, the fourth
  lost three of four. Quoting code with its line numbers pushed pictures toward annotated listings
  where a sequence explained more, and the per-branch check left as many wrong claims as before.
  The one rule that won its case was a micro-world whose every caption is computed from its state
  and checked over every combination of its controls; it is the only one kept.

## Consequences

- Judged blind against the first tour, the new one won on all four pull requests with both judges
  (Fable 8.5 against 6.75 on average; Astra 8 against 7). Cognitive load stayed its weakest score.
  The second version, with the cover's route, two-paragraph bodies, and deterministic previews,
  then summed 223 against the first's 216 and lightened the load; the later rounds above did not
  improve on it, and scores settled near 8 of 10.
- A state landmark no longer has to carry a decision on reversibility, and decisions no longer have
  to cover three categories: both quotas made generators write decisions the change never faced. A
  state landmark still says how the change is undone, and validation still requires it.
- The judges kept finding the same faults in every version, at one or two per pull request: a rule
  stated without the branch that breaks it, a keep-reason that argues for the change, a picture
  that loses its wires on a phone. More prompt text did not remove them; a check that reads the
  tour is the next thing to try.
- Every tour is held to the new rules, stored ones too: the tour shipped with no tours in the
  wild, so on 2026-10-19 the stored schema stopped keeping three body paragraphs and the shapes of
  earlier drafts, and the fixture tour of PR 67 was brought to the current shape.
- The gallery has to stay licensed permissively and valid against the frame; a test checks that
  every entry passes the frame's rules and names its technique.
