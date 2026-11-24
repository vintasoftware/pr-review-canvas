# Static viewer: manual tests

The checks to run by hand before a viewer change ships. Unit tests cover the routes and the
sign-in flow against fakes. The Playwright specs in `browser/viewer/` run the production build
under its CSP, with GitHub, its sign-in page, and the auth Worker faked in the browser; they run in
`pnpm verify`. These checks cover what only a real GitHub, a real GitHub App, and a real Cloudflare
deploy show. Add a section when a feature lands, and record the last run at the bottom.

## Setup

- `viewer/.env.local` filled from `viewer/.env.example`, with the app's Client ID (it starts with
  `Iv`), its client secret, and its slug. The slug is optional for the viewer, but without it
  "Reading a private repository" step 2 shows no install link.
- The GitHub App has Contents read-only and Pull requests read and write, and is installed on the
  test repository.
- `pnpm viewer:dev`, then http://127.0.0.1:4174 (not `localhost`: the callback URL names
  `127.0.0.1`).
- A private test repository with a pull request that has a canvas comment, generated with the
  CLI. For the sign-off tests, a second GitHub account that did not open that pull request.

## Reading without signing in

GitHub allows 60 anonymous requests an hour per address, and one page load takes about six. Run
these first, and save the signed-out half of "Reading a private repository" step 3 for when the
limit has room; the page says when it runs out.

1. Open a public pull request whose canvas matches its head, such as
   `?pr=vintasoftware/pr-review-canvas/110`. The canvas opens ready, with layers, diffs, and points.
2. Open one whose canvas is older, such as `/123`. The page says the canvas is outdated, and
   "view stale canvas" shows it with its own diffs.
3. Open one with no canvas comment, such as `/131`. The page says there is no canvas.
4. Mark a file reviewed and reload. The mark is still there.
5. The top strip reads "Reading anonymously: public pull requests only." and posting is off, with
   "sign in with GitHub to post comments and reviews".
6. Open a private pull request. The page says it was not found, or is not public, and suggests
   signing in.
7. On every screen (ready, outdated, no canvas, and an outdated canvas opened with "view stale
   canvas"), the header has refresh and help but no regenerate, export zip, or settings; nothing
   offers to generate a canvas or to drop a zip; and the footer says "hosted viewer". With no
   canvas, the page shows the author `/pr-review-canvas <number>` to run.

## Sign-in

1. Click "sign in with GitHub". GitHub's authorize page names the app; approve it. The page comes
   back to the same pull request and the strip shows "Signed in to GitHub as @login."
2. Cancel on GitHub's authorize page instead. The page comes back and says the sign-in was
   cancelled.
3. Open the viewer in a new tab. It is signed out: the token ends with the tab.
4. Sign out. The strip goes back to reading anonymously, and a reload stays signed out.
5. In devtools, set `expiresAt` of the `pr-review-viewer:auth` session storage entry to a past
   time, and reload. The page refreshes the token through the Worker and stays signed in.
6. Revoke the app in GitHub (Settings, Applications, Authorized GitHub Apps) and reload. The strip
   says GitHub no longer accepts the sign-in, and the page carries on anonymously.
7. With `VITE_GITHUB_CLIENT_ID` set to the numeric App ID, the strip says it looks like the App
   ID.

## Reading a private repository

1. Signed in, open the private test pull request. It opens like a public one.
2. Open a private pull request in a repository the app is not installed on. The page says it was
   not found, or the app is not installed, and links the install page. The footer says "hosted
   viewer", and nothing mentions a clone.
3. Resolve a review thread on GitHub and refresh. Signed in, it shows as resolved; signed out, as
   open.

## Comments

Check each one on GitHub after posting.

1. A comment on one line of the new side.
2. A comment on a range: drag across several lines.
3. A comment on a deleted line, on the old side.
4. A reply in an existing thread.
5. A comment on the whole pull request.
6. A comment from an attention point. After a reload, the point shows as posted.
7. With the app's Pull requests permission set to read-only, posting fails and names the
   permission the app needs.

## Pending review and sign-off

1. Add two drafts, edit one, delete the other, and reload. The edited draft is still there.
2. Submit a comment-only review. The draft arrives on GitHub inside that one review, and the
   pending list empties.
3. Write new drafts and discard them. Nothing reaches GitHub.
4. As the pull request's author, try approve and request changes. Both are refused with "You
   opened this pull request…"; a comment-only review still goes through.
5. As the second account, approve before marking every layer reviewed. It is refused and names
   the layers left. Mark them, approve again, and it goes through.
6. Write a draft as one account, sign out, and sign in as the other in the same browser. The
   draft and the marks are not there, and a review submitted now carries no comments. Sign back
   in as the first account: the draft is back.

## New commits on the pull request

1. Push a commit that leaves the diff the same, such as merging the base in. The canvas stays
   current, marked as carried over.
2. Push a commit that changes code. The canvas shows as outdated.
3. With the canvas current, leave a tab open and push a commit that leaves the diff the same, such
   as an empty one. From the open tab, post an attention point. It is refused: the pull request has
   a new head. (A comment on the whole pull request names no lines, so it still goes through.)
4. With a draft written before that push, submit a review. It is refused, and the refusal says to
   copy or delete the draft; the review tab says the viewer cannot submit it. Delete it, and the
   review goes through. This needs a current canvas: one carried over from step 1 or 3 is enough.
   While the canvas is outdated, posting is off altogether and "finish your review" says so.

## Forks and long threads

1. Open a pull request from a fork, such as `?pr=vintasoftware/pr-review-canvas/107`. The author's
   canvas opens (outdated there), and "view stale canvas" draws its diffs.
2. Open a pull request with more than 100 comments, such as `?pr=jig-harness/jig/1889` (177
   comments, 322 review comments). Every comment loads: compare the counts with GitHub's.

## Large pull requests

1. Open a pull request with several hundred files, such as `?pr=microsoft/TypeScript/65291` (964
   files). The whole diff loads and no banner shows.
2. The rebuild from GitHub's file list only runs when GitHub refuses the diff with 422, which needs
   a change set far larger than most pull requests. When one turns up, open it and check: the
   banner names the files GitHub sent no changes for, each of those files says GitHub sent no diff
   for it because it is too large, and over 3000 files the banner says how many are not shown.

## A canvas comment from a stranger

On a public test repository of your own (not this one), with a pull request that has a canvas:

1. From a second GitHub account with no role on that repository, post a copy of the canvas
   comment's body as a new comment on the pull request.
2. Open the pull request in the viewer. It still shows the author's canvas, and a warning names the
   second account and says its comment was skipped.
3. Add the second account as a collaborator and reload. Its canvas is the one shown now.

## The canvas comment's link

1. In the test repository's `pr-review.config.yml`, set `sharing.viewerLink:
http://127.0.0.1:4174`, and publish a canvas. The canvas comment on the pull request opens
   with "Open the canvas in the viewer", which opens that pull request in the viewer.
2. Remove the setting and publish again. The comment says only to run `pr-review serve`.
3. Set `viewerLink: true`. The CLI warns that the config is invalid and uses the defaults.

## The built page and its headers

Run `pnpm viewer:build` and `pnpm viewer:preview` (with the dev server stopped), then open
http://127.0.0.1:4174.

1. Open a pull request with a canvas, sign in, and post a comment. Everything works as under
   `pnpm viewer:dev`, and the console shows no Content-Security-Policy errors.
2. Open a canvas with a mermaid diagram. It draws.
3. The footer reads `pr-review <version>+<commit>`, with the commit the build was made from.
4. In devtools, the page's response carries `Content-Security-Policy`, `Referrer-Policy:
no-referrer`, and the other headers in `viewer/headers.ts`.
5. After a deploy, repeat 1 to 4 on the hosted site, where `Strict-Transport-Security` is sent too.

## Not covered yet

- A pull request large enough for GitHub to refuse its diff (see "Large pull requests"); the
  rebuild is covered by unit tests and was checked against TypeScript#65291's real file list.
- A canvas comment past a pull request's first 100 comments.
- The hosted site on Cloudflare: nothing is deployed yet.

## Runs

| Date       | Commit    | Who | Result                                                                |
| ---------- | --------- | --- | --------------------------------------------------------------------- |
| 2026-11-23 | `e53405a` |     | Sign-in, reading a private pull request, and one comment: all worked. |
