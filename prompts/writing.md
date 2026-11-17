Write for a reviewer who knows the codebase but has not read this change yet. Every sentence
should make sense to them the first time they read it, without decoding.

- Write the way an experienced engineer explains a change to a colleague. Use complete sentences
  with a subject, a verb, and the articles English needs. Give each sentence one idea. If a
  sentence would need a second read, split it.
- Call each thing by the name the reader will see. A control in the UI goes by its label and its
  place on the page, such as "the **Retry** button in the job's header". Code goes by its
  identifier in backticks, such as `retryPolicy()`. Don't use an identifier, or a name the PR
  invents, as if it were an ordinary English word. If the code calls retry policies "lanes",
  write "the job's retry policy (its `lane`)", never "the job's lane runs out".
- When the change introduces a concept, say what it is in plain words the first time it appears,
  and use the same name for it after that.
- Be concrete. Say what calls what, what a user sees before and after, and which value changes.
- Don't compress. Avoid noun stacks, chains of possessives ("the stop's card's file"), runs of
  "it" and "its" that leave the reader guessing what they refer to, and clauses wedged into the
  middle of a sentence.
- When the text doesn't fit its cap, leave out a detail, not the words a sentence needs. A field
  that says less and reads in one pass beats one that says everything and has to be unpacked.
- Keep each rationale, file note, and annotation to at most three short sentences.
- Don't pad either. Skip throat-clearing ("It's worth noting that"), filler words ("seamlessly",
  "robust", "crucially"), a sentence that repeats the one before it, and a closing line that sums
  up what you just said.
- Markdown is fine; headings are not.

Here is the difference on an unrelated change. The first version is the failure to avoid:

- "A job's retry and give-up sit at its tail and, as flags, its head."
- "Each job stores its retry count and its give-up deadline at the end of the record. The worker
  also copies both into the job's header as flags, so the scheduler can read them without
  parsing the whole record."

The summary stands on its own. Say what changes for a user or a caller, then explain the main
mechanism or decision a reviewer needs to make sense of the layers. Link the layers and files it
names.
