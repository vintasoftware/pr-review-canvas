# Publishing to npm

The package is `@vintasoftware/pr-review-canvas`; its installed command is `pr-review`.
The first release is `0.1.0`. Publishing is manual. CI validates changes and has no npm credentials.

## Before the first release

1. Create or sign in to your [npm account](https://www.npmjs.com/login), verify its email,
   and enable [two-factor authentication](https://docs.npmjs.com/about-two-factor-authentication/).
2. Confirm that the `vintasoftware` npm organization exists and that your account can publish
   packages in that scope. GitHub organization membership does not grant npm access.
3. Merge the release-preparation PR. Wait for both `Verify (Node 22)` and `Verify (Node 24)`
   in the **CI** workflow to pass on the resulting `main` commit.
4. Install Node.js 24, Corepack, Git, and GitHub CLI. Authenticate GitHub CLI with `gh auth login`.
   The project pins pnpm in `package.json`; `corepack enable` makes that version available.
5. This is a **public npm package**, even while the GitHub repository is private. Confirm that
   the bundled source, prompts, skill, documentation, and Apache-2.0 license are ready to share.
   Links to the private GitHub repository will require access; the CLI reference is also bundled
   in the installed package at `docs/reference.md`.

The CLI loads the shipped TypeScript through its production `tsx` dependency. No compilation
step is needed. The package smoke test installs an actual tarball with production dependencies
outside the checkout and checks the command, skill installation, server, and browser assets.

## Validate the exact release commit

Start in a clean clone or checkout, with no local edits:

```bash
git switch main
git pull --ff-only
git status --short
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm verify
```

`git status --short` must print nothing. `pnpm verify` runs type checking, all unit tests with
95% coverage thresholds, Chromium tests at three viewport sizes, and the npm package smoke test.
The package smoke test needs registry access to install production dependencies.
On Linux, Playwright's `--with-deps` option may need sudo to install system libraries.

Check CI for the exact commit you are about to publish:

```bash
git rev-parse HEAD
gh run list --workflow ci.yml --branch main --commit "$(git rev-parse HEAD)" --limit 5
# Replace RUN_ID with the run for that commit.
gh run watch RUN_ID --exit-status
gh run view RUN_ID
```

Proceed only if the run concludes **success** and both Node jobs passed. A missing, queued,
skipped, cancelled, or failed run is not a release check. Each job runs `pnpm verify`.
If a fix is needed, merge it and repeat these checks for the new commit.

## Inspect the package and authenticate

```bash
npm pack --dry-run
npm pack
# Inspect the archive printed by npm pack (for the first release):
tar -tzf vintasoftware-pr-review-canvas-0.1.0.tgz
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view @vintasoftware/pr-review-canvas versions --json --registry=https://registry.npmjs.org/
```

For a new public package, the last command should return `E404`. If the package already exists,
confirm ownership and select an unused version before proceeding. A network or authentication
error does not establish name availability. npm versions cannot be reused once published.

The archive should contain runtime source, static assets, prompts, the skill, example config,
CLI reference, README, package metadata, and license. Tests, fixtures, local review data, and
credentials must be absent. `pnpm test:package` checks the package contents and installation.

## Publish 0.1.0

From the same clean, verified checkout:

```bash
npm publish --access public --registry=https://registry.npmjs.org/
```

Complete npm's interactive authentication/2FA prompt. Public access and the registry are also
set in `publishConfig`. The `prepublishOnly` hook reruns `pnpm verify` and stops publishing if
any check fails. Keep pnpm and Chromium installed; do not use `--ignore-scripts` to bypass it.
Publish from the checkout as shown: publishing a `.tgz` directly does not run this checkout's
`prepublishOnly` hook. No npm token or publishing workflow is required.

## Verify and tag the release

```bash
npm view @vintasoftware/pr-review-canvas@0.1.0 version dist.integrity --registry=https://registry.npmjs.org/
npm install -g @vintasoftware/pr-review-canvas@0.1.0
pr-review --help
git tag -a v0.1.0 -m 'Release 0.1.0'
git push origin v0.1.0
```

From a project clone, run `pr-review install-skill`, then `pr-review serve` and open
http://localhost:3010. `pr-review doctor` checks GitHub access and local setup;
`doctor --all-checks` additionally requires the optional `acpx` installation.

Optionally create a GitHub release for `v0.1.0` with release notes. Remove the README's
first-release availability note in a follow-up documentation change once npm installation works.

## Later releases

Use a branch to update the version before running CI:

```bash
git switch -c release/0.1.1
npm version patch --no-git-tag-version
pnpm install --lockfile-only
```

Use `minor` or `major` when appropriate. Commit the version change and any release notes,
open a PR, merge after CI passes, then repeat validation and publishing from `main`.
Substitute the new version in all inspection, verification, and tagging commands.

References: [npm public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[npm publishing authentication](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/),
and [npm publish lifecycle](https://docs.npmjs.com/cli/v11/using-npm/scripts/).
