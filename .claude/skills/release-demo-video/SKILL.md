---
name: release-demo-video
description: Make a release demo video of this project's new features as an HTML/CSS/JS animation rendered to MP4. Use when preparing a release and asked for a demo, walkthrough, or "what's new" video.
---

# Release demo video

A two-minute MP4 that walks users through what the next release changes. It is one HTML page with a seekable timeline: it plays live in a browser, and `scripts/render.mjs` records it frame by frame. [`template.html`](template.html) is the finished 0.6 video; build the new one from it.

Aim for calm and informative: fades, typing, a cursor that clicks, UI mock-ups that look like the real app. No flashy effects. Every scene needs enough time for someone to read its text.

## 1. List the features

Read the `## Unreleased` section of `CHANGELOG.md` and group its entries into 6–9 **chapters**. Each chapter becomes one scene. Lead with the changes users will notice most, and put CLI and breaking changes last. Every entry a user would notice should land in a scene, as the headline, the lede, or a note. Leave out internal fixes.

Every command, flag, output line, and setting name in the video must come from something you ran or read, never from memory:

- Run the real commands in a scratch clone: `git init`, add an `origin` remote such as `https://github.com/acme/widgets.git`, commit on a branch, then `node <repo>/bin/pr-review.mjs prepare --branch --base main --data-dir <scratch>/.pr-review`. `doctor`, `validate`, `publish`, `clean`, and `--help` all work offline there.
- Take install and upgrade commands from `README.md`.
- Take exact UI labels from `static/js/`.

## 2. Capture the real UI

Copy [`scripts/reference-shots.spec.ts`](scripts/reference-shots.spec.ts) into `browser/`. Add a shot for each state a scene will draw. Run it with `SHOTS_DIR=<scratch>/shots npx playwright test browser/reference-shots.spec.ts --project=desktop`, look at every PNG, then delete the copy. The harness in `browser/fixtures.ts` serves PR 42 with a fake GitHub and a fake chat agent. Those fakes are how you script a chat answer or a proposed comment.

## 3. Build the page

Copy `template.html` to `release-video/index.html` at the repo root. `release-video/` is git-ignored, so the page and the MP4 stay out of commits. Set `VERSION`, replace the scenes, and keep the engine. Draw the mock-ups at video scale, with body text 16px or larger, using the classes the template already has: `.card`, `.chat`, `.diff`, `.term`, `.yml`, `.dlg`, `.rail`. A viewer should recognize the real app in them.

## 4. Review stills

Aim at a 2:00 total and adjust `SCENES` durations to get there. Render stills with `node .claude/skills/release-demo-video/scripts/stills.mjs release-video/index.html <scratch>/stills <seconds>...`, then open each PNG. For every scene, check one **settled** frame (everything revealed) and each click, key press, and transition in it. Look for:

- text that wraps badly or overflows its card
- a cursor that misses its target or parks on the chapter bar
- mono ligatures (`===` drawn as one glyph)
- facts that differ from step 1

The script exits non-zero on a page error. This step is done when every scene has a clean settled frame and clean action frames.

## 5. Render and check

Render into the main checkout's `release-video/`, not the current worktree's. A linked worktree's `release-video/` is deleted with the worktree. Keep a copy of the page there too, so the video can be edited later:

```bash
main=$(git worktree list --porcelain | awk 'NR==1 { print $2 }')
mkdir -p "$main/release-video"
node .claude/skills/release-demo-video/scripts/render.mjs release-video/index.html "$main/release-video/pr-review-canvas-<version>.mp4"
cp release-video/index.html "$main/release-video/pr-review-canvas-<version>.html"
```

Pull 3–4 frames from the MP4 with `ffmpeg -ss <t> -i <mp4> -frames:v 1 <png>` and look at them, including at least one mid-click. Report the path, duration (`ffprobe`), and size. List any assumptions the user should confirm, such as the version number. The video has no audio track.

## Engine reference

The `<script>` in `template.html` drives everything from one time value, so any frame can be rendered exactly:

- `SCENES`: `{ id, d }` in playing order. Each scene's start is the sum of the durations before it. Scenes fade in over 0.5s and out over the last 0.45s.
- `data-at="<s>"` on an element inside a scene fades it in (and slides it up) at that local second. `data-dx` and `data-dy` set the slide. Scene copy is paced this way: kicker 0.15, headline 0.35, lede 0.8, notes later.
- `data-chapter="<label>"` on a `<section class="scene">` adds it to the chapter bar. The intro and outro have none.
- `R['<scene id>'] = t => {…}`: per-frame logic in local seconds. Helpers: `P(t, at, dur)` gives eased 0→1 progress, `place(el, k, dx, dy)` applies it, `reveal(wrap, k)` animates height, `io` is ease in-out.
- Terminals: inside a `.term`, a `.ln` with `data-type="cmd"` is typed after `$` at its `data-at`, and other `.ln` lines appear at their `data-at`. Call `termRender(termEl, t)` from the scene's renderer.
- `typeYaml(el, lines, t, at, cps)` types syntax-colored config. `lines` holds `[class, text]` segments using `yk` for keys, `yv` for values, and `yc` for comments.
- Chat answers: give an element `class="stream"` and call `stream(el, t, at, wordsPerSecond)`.
- Cursor: `scene.cursor = [[t, x, y], [t, '<selector>', 'click'], …]`. It travels during the 0.8s before each keyframe, and a `'click'` shows a press and a ripple. Aim clicks at selectors, and aim the final resting point at empty space inside the scene.
- `?render` stops live playback so the scripts can call `window.videoSeek(t)`. `?t=<s>` starts live playback at that second.

Two gotchas the template already handles. Keep them if you rewrite its CSS:

- Diff column rules use child selectors (`.diff .r > span`), so syntax-highlight spans inside a line keep their color and spacing.
- Mono text sets `font-variant-ligatures: none`.

Fonts come from Google Fonts (Inter, JetBrains Mono), so rendering needs network access.
