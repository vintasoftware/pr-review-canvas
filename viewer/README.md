# Static viewer (proof of concept)

A static page that opens the canvas published on a GitHub pull request, with nothing to install.
It is the first step of [ADR 0005](../docs/adr/0005-static-read-only-viewer.md). Public pull
requests open without signing in. With a GitHub App configured, a reader can sign in to open the
private repositories the app is installed on.

```bash
pnpm viewer:dev
```

Then open http://127.0.0.1:4174/?pr=vintasoftware/pr-review-canvas/110. The `pr` parameter takes
`owner/repo/123`, `owner/repo#123`, or the pull request's URL. `pnpm viewer:build` writes the static
files to `dist-viewer/`.

Before a change ships, run the checks in [MANUAL-TESTS.md](MANUAL-TESTS.md), and add to it when a
feature lands.

## How it works

The page boots the same `static/js/app.js` the local server serves. `main.ts` replaces `fetch` for
the page's `/api` calls, and `viewer-api.ts` answers them in the browser:

- The pull request, its comments, and the diff come from GitHub's REST API (`github-client.ts`),
  read with the server's own mappers (`src/github/pr.ts`, `src/github/comments.ts`) and diff parser
  (`src/git/diff-collector.ts`).
- The diff is GitHub's compare diff, which held 964 files and 4 MB when tried. For a larger range
  GitHub answers 422, "The diff is taking too long to generate", and `diff-fallback.ts` rebuilds
  the diff from a file list instead: the pull request's, up to 3000 files, or a comparison's, up to
  300 for an older canvas. GitHub sends no patch for a file too large to diff, so the page lists
  that file with its line counts and says its diff was not sent, and a banner names the files left
  out and the ones past the list's limit.
- The canvas is the newest canvas comment on the pull request, read with `readCanvasZip` like an
  import. It shows as ready, carried over, or outdated by the same rules as the local app.
- Review marks, dismissals, hidden threads, the pending review, and the skin and theme stay in
  `localStorage`.
- A signed-in reader posts comments (on a line, as a reply, or on the pull request) and submits
  reviews with the server's own GitHub code (`src/github/post-comment.ts`,
  `src/github/post-review.ts`). The same checks run first: the line must be in the diff, the page
  must show the current head, an approval needs every layer reviewed, and the author cannot
  approve their own pull request. A pending comment goes out only with a review on the diff it was
  written on.
- AI chat, generation, and import answer `NOT_IMPLEMENTED`.

## Sign in with GitHub

Sign-in uses a GitHub App and the authorization-code flow with PKCE (`auth.ts`). GitHub only hands
out a token for a code when the request carries the app's client secret, so the Worker in
[`worker/`](../worker/auth-worker.ts) does that one exchange, and the refresh before the token's
eight hours run out. The Worker keeps no token and sees no API traffic.

On the page:

- The token and its refresh token live in `sessionStorage` and end with the tab. Sign-out forgets
  them; the app stays authorized on GitHub until the reader revokes it in their settings.
- GitHub answers read with the token stay in the page's memory. Only anonymous answers are kept
  in `sessionStorage` between reloads.
- When GitHub stops accepting the token, the page signs out, says so, and carries on anonymously.
- A private pull request the reader cannot see is reported as not found, with a link to install
  the app when the build names its slug.

### Register the GitHub App

In GitHub, open Settings, then Developer settings, then GitHub Apps, then New GitHub App:

- Callback URL: `http://127.0.0.1:4174/` for local work, plus the hosted viewer's URL. GitHub
  redirects only to these, and the host must match the one in the address bar (`127.0.0.1`, not
  `localhost`).
- Leave "Expire user authorization tokens" on. Turn the webhook off.
- Repository permissions: Contents read-only, and Pull requests read and write, which posting
  comments and reviews needs. Metadata read-only is added on its own. When you raise a permission
  on an app that is already installed, each installation's owner has to accept the change before
  it applies there.
- Generate a client secret.

Install the app on each account or organization whose private pull requests should open.

### Run it locally

Copy `viewer/.env.example` to `viewer/.env.local` and fill in the Client ID (it starts with `Iv`;
the numeric App ID above it on the settings page is not it), the client secret, and optionally the
app's slug. `pnpm viewer:dev` then runs the Worker inside the dev server at
`/__auth`. The secret stays in the dev server's process: only names that start with `VITE_` reach
the page.

### Run the built page locally

`pnpm viewer:build` then `pnpm viewer:preview` serves the production build at
http://127.0.0.1:4174 with the same response headers Cloudflare Pages sends, including the
Content-Security-Policy. The preview server runs the Worker at `/__auth` too, so sign-in works there
the same way it does under `pnpm viewer:dev`. Stop the dev server first: both use port 4174.

## Hosting

The viewer is static files on Cloudflare Pages, and the auth Worker runs on Cloudflare Workers.
The build writes `dist-viewer/_headers` (see `headers.ts`), which Pages sends with every page:

- `Content-Security-Policy`: script only from the page's own origin, no inline script, network
  requests only to `api.github.com` and the auth Worker, images only from GitHub, and no framing.
  Inline styles are allowed, as the local app allows them, for computed widths and colors and the
  style element mermaid draws with each diagram.
- `Referrer-Policy: no-referrer`, since the address holds a pull request's name, and GitHub's
  sign-in code on the way back from GitHub.
- `X-Content-Type-Options`, `X-Frame-Options`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`,
  and `Strict-Transport-Security`.

The footer names the build as `<version>+<commit>`, so the code running can be matched to a commit.

### Deploy

`.github/workflows/viewer.yml` tests and builds the viewer on every pull request and push to main
that touches it, and deploys only from a `viewer-v*` tag on a commit of main, through the
`viewer-production` GitHub environment. Nobody deploys from a laptop.

One-time setup:

1. In Cloudflare, create a Pages project for the viewer, and an API token that can edit that
   project and Workers on the account, and nothing else.
2. Set the Worker's client secret once:

   ```bash
   npx wrangler@4.158.0 secret put GITHUB_CLIENT_SECRET --config worker/wrangler.toml
   ```

3. In the repository's settings, add the `viewer-production` environment, limited to `viewer-v*`
   tags, with the secret `CLOUDFLARE_API_TOKEN`. Add the repository variables
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`, `VIEWER_ORIGIN` (the Pages site, as
   `https://viewer.example.com`), `VIEWER_AUTH_WORKER_URL`, `VIEWER_GITHUB_CLIENT_ID`, and
   `VIEWER_GITHUB_APP_SLUG`.
4. Add `VIEWER_ORIGIN` followed by `/` to the GitHub App's callback URLs.

Then a release is a tag:

```bash
git tag viewer-v0.1.0 && git push origin viewer-v0.1.0
```

## Limits

- A diff rebuilt from a file list can group hunks differently from `git diff`: GitHub's list joined
  two nearby hunks of one file into one, in one file of 964 tried. A note the canvas pins to the
  second of those hunks then has no hunk of its own. Only very large pull requests use the rebuild.

- Anonymous reads are limited to 60 requests an hour per address, and GitHub counts a 304 against
  that too. A cold load of a pull request costs about six requests. Answers are reused for five
  minutes, and the page's refresh command asks again. Signed in, the limit is the reader's own.
- Anonymous readers see resolved review threads as open: GitHub's GraphQL API, which reports
  them, needs a token.
- The page leaves out the local app's commands: regenerate, export zip, settings, generating a
  canvas for the head, and dropping a canvas zip. The bundle's `viewer: true` tells the shared page
  code to draw none of them. With no canvas, the page shows the author the `/pr-review-canvas`
  command to run in their clone.
