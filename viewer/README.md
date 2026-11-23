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

## How it works

The page boots the same `static/js/app.js` the local server serves. `main.ts` replaces `fetch` for
the page's `/api` calls, and `viewer-api.ts` answers them in the browser:

- The pull request, its comments, and the diff come from GitHub's REST API (`github-client.ts`),
  read with the server's own mappers (`src/github/pr.ts`, `src/github/comments.ts`) and diff parser
  (`src/git/diff-collector.ts`).
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

### Deploy

Set `GITHUB_CLIENT_ID` and `ALLOWED_ORIGINS` in [`worker/wrangler.toml`](../worker/wrangler.toml),
then:

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --config worker/wrangler.toml
```

```bash
npx wrangler deploy --config worker/wrangler.toml
```

Build the viewer with the app and the Worker named:

```bash
VITE_GITHUB_CLIENT_ID=<client id> VITE_AUTH_WORKER_URL=https://<worker host> VITE_GITHUB_APP_SLUG=<slug> pnpm viewer:build
```

## Limits

- Anonymous reads are limited to 60 requests an hour per address, and GitHub counts a 304 against
  that too. A cold load of a pull request costs about six requests. Answers are reused for five
  minutes, and the page's refresh command asks again. Signed in, the limit is the reader's own.
- Anonymous readers see resolved review threads as open: GitHub's GraphQL API, which reports
  them, needs a token.
- Screens built for the local app still offer its commands, such as generating a canvas or
  dropping a zip, and those fail with a "not available in the viewer" message.
