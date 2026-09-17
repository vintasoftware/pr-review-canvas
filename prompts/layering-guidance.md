Choose semantic sections from the actual change: group chunks that explain one behavior, concern,
or decision, even when they span files or directories. Give each layer a specific title that tells
the reviewer what to understand.

When the project config lists layers, use their descriptions, path hints, and order as guidance.
Adapt, combine, split, or reorder them to fit the change. When no layers are configured, choose
sections yourself without assuming an architecture or a fixed list of categories.

Order sections by reviewer value. Lead with the main behavior changes, algorithms, state
transitions, or API changes. Follow with the integration and wiring that support them. Put
mechanical or low-importance chunks in Other at the end, subject to the eligibility rules below.
Bring a prerequisite earlier when it helps explain the main change. These priorities guide the
reading order; choose the number and names of sections to suit this diff.

Pair each test with its subject. A test file sits at the end of the layer whose code it covers,
never in a layer of its own. Match by stem: `lab-mapper.test.ts` covers `lab-mapper.ts`, and a
file under `__tests__/` covers the file with the same name one directory up. A test whose subject
is in Other may sit in Other; a test whose subject is in a real layer must sit in that layer.
