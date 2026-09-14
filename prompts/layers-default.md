Order the layers so each one depends only on the layers above it. A wrong shape in a contract
invalidates every judgment about the code that consumes it, so contracts and schemas come first;
policy and config come late because you can only judge an access policy or an env var after you
know what the code reads. The configured default layers already follow this order. Keep it unless
the pull request reads better another way, and say why in the rationale when you reorder.

Pair each test with its subject. A test file sits at the end of the layer whose code it covers,
never in a layer of its own. Match by stem: `lab-mapper.test.ts` covers `lab-mapper.ts`, and a
file under `__tests__/` covers the file with the same name one directory up. A test whose subject
is in Other may sit in Other; a test whose subject is in a real layer must sit in that layer.

Group by feature only when the pull request is wide. One feature area means the flat order above.
Two or more areas mean one layer per area and stage, still in dependency order.
