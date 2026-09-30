# Scenes and micro-worlds run the generator's scripts in a frame with no origin

A landmark's scene and micro-world are generated HTML. Drawn from a kit of CSS classes in a frame
that ran no script, they would be safe but narrow: every picture a generator writes comes out as
the same box, arrow, and banner. So they carry their own styles and scripts, and the generator
draws where the change lands (a screen, a terminal, a chart, an animated flow) and models the
changed behavior for the reader to play with, guided by the skill's scene guide.

The frame is the boundary. It runs under `sandbox allow-scripts` with no origin, so a script cannot
read the tour page, the API, or this server's storage; its policy allows inline code only and no
network, forms, popups, or navigation of the tour page; it loads nothing, since the kit and a small
runtime are inlined by the server. The tour page and the frame talk by message: the runtime
reports the scene's height and hears the theme. A scene is watched, so its frame is inert and
the tour's keys keep working; a micro-world takes the reader's input through its own controls,
so its frame is not, and the reader's keys belong to it while it has focus. Validation names the
network, storage, eval, and worker calls a script would find blocked, and the forms and inputs a
scene has no use for, but it is a lint, not the boundary.

This is PR 44's sandbox (its ADR 0005) carried onto the tour, with one change: a micro-world
takes input.

## Considered options

- **Keep the no-script kit and grow it.** No generated code ever runs, but every new kind of picture
  waits on a kit change, and the scenes stay templated.
- **A p5 sketch per scene**, tried earlier on PR 44. Scripts ran sandboxed too, but the generator
  drew text by coordinates without seeing the result, and labels collided. Scenes keep words in
  HTML, laid out by the browser, and use scripts for shapes and motion.

## Consequences

- A content security policy does not govern WebRTC, so a script could still open a peer
  connection and send out what the scene contains. A scene contains what the generator wrote into
  it, and the generator already reads the repository, so this adds no reach over the code; it
  does mean a prompt-injected generator could leak through a scene the reader merely opens.
- A script that loops forever hangs the frame, and in browsers that do not isolate sandboxed
  frames in their own process, the tour page with it. Reloading the page recovers.
- A micro-world's frame takes focus, so the tour's keyboard shortcuts pause while the reader is
  inside it. Clicking the page outside the frame gives them back.
