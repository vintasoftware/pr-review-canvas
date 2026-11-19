# Reviewers read a published canvas in a hosted static viewer

Status: proposed

Today a reviewer has to install the CLI and run `pr-review serve` to read a canvas, even though the
author already published it on the pull request: the canvas comment carries the zip (`manifest.json`
and `review.json`) in its raw body. We add a **static viewer**, a build of the existing browser app
that runs with no local server. It reads the canvas from that comment, fetches the diff from the
host's API, and keeps review state in the browser. Reviewers open a URL and sign in with GitHub or
GitLab. Authors still generate and publish with the CLI, and the local app keeps every feature it
has now.

This narrows ADR 0001. The public website and the local app stay separate. The viewer is a third
piece: it shows real canvases of real pull requests but never runs an AI agent.

## Each project opts in

The viewer is a page hosted by a third party, Vinta, that reads a project's repository with the
reviewer's token. Whether a project may use it depends on that project's client terms, security
requirements, and, for some clients, HIPAA obligations, so each project decides for itself. Nothing
in this ADR approves the viewer for any project. A project that has not decided, or that decides
against it, keeps using the local app, which this ADR does not change.

Two controls enforce this:

- The project config gets `sharing.viewerLink`, false by default. Only when it is true does the
  canvas comment link to the viewer. It is a project setting with no personal override, because
  the decision belongs to the project and not to one reviewer.
- On GitHub, the viewer cannot read a private repository until an admin of its organization
  installs the GitHub App, so installing the app is the project's approval. GitLab has no such
  step: a reviewer's own sign-in reaches every project they can see, so for GitLab projects the
  config setting and the team's own rules are the only controls.

## What the viewer does and does not do

The viewer covers reading and reviewing:

- Layers, files, folds, background, and attention points, rendered by the same modules in
  `static/js/`.
- Review progress, dismissals, and hidden threads.
- Existing review threads, a pending review, and submitting it with a verdict.

It leaves out everything that needs the reader's machine:

- Generating a canvas, incremental or not, because generation runs Claude Code or Codex through
  acpx.
- Chat, because it runs the same agents in a review checkout (ADR 0004).
- Reviews of a branch or of uncommitted work, because neither exists on the host.
- Self-review, because resolving a point republishes the canvas, which the CLI does.

Those controls are hidden in the viewer, with a short note pointing to the local app.

## How it works

### Canvas

The viewer lists the pull request's comments, picks the newest canvas comment, and decodes it with
the existing envelope (`<!-- pr-review-canvas:v1`) and `readCanvasZip`. The checks are the same ones
the local import runs, so a canvas the CLI rejects is rejected here too. With no canvas comment, the
page says so and links to the setup docs.

### Diff

The canvas stores hunk headers, not diff text. The viewer fetches the diff between the manifest's
`mergeBaseSha` and the canvas's head from the host API (`compare` on GitHub, the repository compare
endpoint on GitLab) and checks every file and hunk against the canvas before rendering. If the head
moved, the carried-over and outdated rules apply as they do locally: an identical diff shows the
canvas as current, and any other diff shows the outdated bar. When the API truncates or omits a
patch (large files, large pull requests), the viewer shows which files it could not load and points
to the local app, rather than rendering the canvas over a partial diff.

### Review state

Progress, dismissals, hidden threads, and the pending review live in IndexedDB, keyed the same way
as the local store (host, repository, pull request, canvas head). They stay in that browser. Moving
between machines or between the viewer and the local app does not carry them.

### API seam

`static/js/api.js` is the one place the browser calls the server. The viewer build swaps it for a
browser adapter that implements the read and review calls against the host API and IndexedDB, and
reports generation, chat, and import as unavailable. The rendering modules do not change.

## Sign-in

GitHub's OAuth flow needs a client secret to exchange the authorization code for a token, so a
static page cannot complete it alone. A Cloudflare Worker does that one step:

1. The viewer sends the user to GitHub's authorize URL with a `state` value it keeps in
   `sessionStorage`, plus a PKCE challenge.
2. GitHub redirects back to the viewer with a code.
3. The viewer posts the code and verifier to the Worker. The Worker adds the client secret, calls
   GitHub's token endpoint, and returns the token. It also refreshes expired tokens.

The Worker holds the client secret and nothing else. It stores no tokens, logs no request or
response bodies, and accepts requests only from the viewer's origin. The viewer calls the GitHub API
directly from the browser; the Worker never proxies API traffic and never sees code or comments.

We register a GitHub App rather than an OAuth App. An OAuth App needs the `repo` scope for private
repositories, which grants write access to all of the user's code. A GitHub App asks only for what
the viewer uses (pull requests read and write, contents read, metadata read), and its user tokens
expire after eight hours. The cost is that an organization admin has to install the app before its
members can open private pull requests.

GitLab.com supports the authorization-code flow with PKCE for public applications, with no secret,
so GitLab sign-in runs entirely in the browser and does not use the Worker. A self-managed GitLab
instance needs its own application registered there. The viewer takes the instance URL and
application ID as settings.

The token lives in memory and `sessionStorage`, never in `localStorage` or IndexedDB, so it ends
with the tab session.

## Hosting

The viewer and the Worker both deploy to Cloudflare: the viewer on Cloudflare Pages, the Worker
beside it. GitHub Pages cannot set response headers, and the viewer needs a strict Content Security
Policy in a header: scripts from its own origin only, `connect-src` limited to the host APIs and the
Worker, no inline scripts, and `frame-ancestors 'none'`. The marketing site stays on GitHub Pages.

Canvas text is author-written markdown that the viewer renders while holding a token able to post
reviews. Every rendered fragment already goes through DOMPurify; the viewer keeps that and adds the
CSP so a sanitizer gap cannot load script from elsewhere. Mermaid runs at its strict security level,
as it does locally.

The CSP does not protect against the host itself. Whoever can deploy to the Pages project or change
its headers can ship JavaScript that reads every repository a signed-in reviewer can reach, and the
next page load runs it. The local app has the same exposure only when a user upgrades from npm; the
viewer has it on every load. Deploy access is therefore the main control:

- Only the CI workflow on protected `main` deploys, through a scoped Cloudflare API token, never a
  developer's machine.
- The Cloudflare account requires MFA and has as few members as the work allows.
- Each deploy is a tagged release, and the viewer shows its version, so a reviewer or auditor can
  match the running code to a commit.
- The viewer loads no third-party scripts, analytics, or error reporting. Every dependency is
  bundled at build time from the lockfile.

## Considered options

- Personal access tokens pasted into the page. This is fully static, with no Worker, but users would
  have to create a token by hand, many would grant more than needed, and a long-lived token would
  sit in browser storage.
- A backend that proxies the host API. It would let the viewer hide tokens from the browser, but we
  would run a service that sees every reviewed pull request's code and comments.
- An OAuth App instead of a GitHub App. Organizations would not have to install anything, but the
  `repo` scope is far wider than a read-mostly viewer needs.
- Keeping the CLI as the only way in. There is no new surface to secure, but every reviewer has to
  install Node, the CLI, and `gh` to read something the author already published.

## Consequences

- In a project with `sharing.viewerLink: true`, the canvas comment links to the viewer for that pull
  request and keeps "Run `pr-review serve`" as the second option. Every other project's comment
  stays as it is now.
- Every feature the viewer offers must keep working in the local app. A project that cannot use
  the viewer loses nothing but the convenience.
- Vinta runs a GitHub App registration, a Cloudflare account, and a Worker holding a secret. The
  secret needs an owner and a rotation procedure, and the Cloudflare account becomes as sensitive as
  the GitHub App, since control of either reaches reviewers' repositories.
- The viewer and the local app keep separate review state, so a reviewer who switches between them
  starts with no marks on the other side.
- Pull requests whose diff the host API truncates still need the local app.
- `pnpm verify` gains a viewer build and browser tests that run the app with the browser adapter and
  a mocked host API.

## Open questions

- Before the Worker and GitHub App go live, the project lead should review the token handling, the
  CSP, and the deploy controls. A hosted page that holds host tokens is a new surface for our SOC 2
  baseline.
- HIPAA: code, diffs, and comments never reach Vinta's infrastructure. Cloudflare Pages serves
  static files and the Worker sees only authorization codes and tokens, so the data path is the one
  the local app already has, with IndexedDB in place of `~/.pr-review`. Our reading is that this
  adds no new party that creates, receives, keeps, or transmits PHI, provided the viewer and Worker
  keep to the no-analytics, no-error-reporting, no-logging rules above. The compliance owner has to
  confirm that reading, and each project still decides on its own, since client BAAs and security
  terms can restrict which tools may access a repository whether or not a given pull request holds
  PHI.
- What a project needs to decide. A short checklist in the docs would help: who may approve the
  viewer for a client, what the data path is, what the reviewer's device stores, and how to set
  `sharing.viewerLink`. Code is rarely PHI, but fixtures copied from production, SQL dumps, logs, or
  screenshots in a pull request can be, and a generated canvas can quote them. The viewer shows and
  stores that text as GitHub and the local app already do, under the same device rules (disk
  encryption, no shared browser profiles).
- Whether review state should later sync through the pull request itself (for example a hidden
  comment per reviewer), so marks follow a reviewer between machines.
