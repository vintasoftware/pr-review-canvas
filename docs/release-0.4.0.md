# Publish 0.4.0 after the release PR merges

Release preparation does not publish to npm, push a tag, or create a GitHub release.
The package version is already `0.4.0`; npm's previous release is `0.3.0`.

These commands follow the manual process on `main` when this PR was prepared.
PR #25 proposes publishing automatically when a tag is pushed. If that workflow is
included in the release commit, use its automated process instead of the manual
publish below. Do not publish through both paths.

## 1. Check out the merged release commit

Use Node.js 24, Corepack, Git, and an authenticated GitHub CLI (`gh auth login`).
Start from a clean checkout of `vintasoftware/pr-review-canvas`. Run all subsequent
commands in the same shell, and stop if any command fails.

```bash
git status --short
# Must print nothing before switching branches.
git switch main
git pull --ff-only
release_commit=$(gh pr view release/0.4.0 --repo vintasoftware/pr-review-canvas \
  --json mergeCommit --jq '.mergeCommit.oid')
test -n "$release_commit"
git switch --detach "$release_commit"
test "$(node -p "require('./package.json').version")" = 0.4.0
test ! -f .github/workflows/release.yml
git status --short
```

The checkout must still be clean. The workflow-file check deliberately stops the
manual path if PR #25 has landed in this commit. Detached HEAD keeps later merges
from changing what you validate, publish, and tag.

## 2. Wait for CI and validate locally

```bash
gh run list --workflow ci.yml --branch main --commit "$release_commit" --limit 5
# Replace RUN_ID below with the CI run for release_commit.
gh run watch RUN_ID --exit-status
gh run view RUN_ID
```

Require a successful run with both **Verify (Node 22)** and **Verify (Node 24)**
passing. A missing, skipped, cancelled, or failed run is not sufficient.

```bash
release_shims=$(mktemp -d /tmp/pr-review-release-corepack.XXXXXX)
corepack enable --install-directory "$release_shims"
export PATH="$release_shims:$PATH"
pnpm --version
corepack pnpm --version
# Must report 10.33.0.
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install --with-deps chromium
corepack pnpm verify
```

The temporary Corepack shims put the pinned pnpm first on `PATH`, including for
nested scripts and npm's `prepublishOnly` hook. Keep this shell open through
publishing. Playwright may need sudo to install Linux system libraries.

## 3. Inspect the archive and authenticate to npm

Your npm account needs verified email, 2FA, and publishing access to the
`@vintasoftware` package. GitHub access does not grant npm access.

```bash
npm pack --dry-run
npm pack --pack-destination /tmp
tar -tzf /tmp/vintasoftware-pr-review-canvas-0.4.0.tgz
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view @vintasoftware/pr-review-canvas versions --json --registry=https://registry.npmjs.org/
```

Confirm `0.4.0` is absent from the published versions. A registry error does not
prove availability. Check that the public archive contains the intended runtime
source, assets, prompts, skill, reference, README, metadata, and license, with no
credentials, local review data, tests, or fixtures.

## 4. Publish to npm

From the same verified checkout:

```bash
test "$(git rev-parse HEAD)" = "$release_commit"
test -z "$(git status --porcelain)"
npm publish --access public --registry=https://registry.npmjs.org/
```

Complete the interactive npm authentication/2FA prompt. The prepublish hook runs
`pnpm verify` again. Do not bypass scripts or publish the tarball directly.

## 5. Verify the package, then tag and create the GitHub release

```bash
npm view @vintasoftware/pr-review-canvas@0.4.0 version dist.integrity --registry=https://registry.npmjs.org/
npm install -g @vintasoftware/pr-review-canvas@0.4.0
pr-review --help
git tag -a v0.4.0 "$release_commit" -m 'Release 0.4.0'
git push origin v0.4.0
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const notes = changelog.split('## 0.4.0\n')[1].split('\n## 0.3.0')[0].trim()
writeFileSync('/tmp/pr-review-canvas-0.4.0-notes.md', notes + '\n')
JS
gh release create v0.4.0 --verify-tag --title '0.4.0' \
  --notes-file /tmp/pr-review-canvas-0.4.0-notes.md
gh release view v0.4.0
```

If publication succeeds but tagging or GitHub release creation fails, resume at
that step; do not republish or move an existing tag. npm versions cannot be reused.

## 6. Refresh each project's skill and smoke-test

In each project that uses the tool, preserve customized skill copies and then run:

```bash
pr-review install-skill
pr-review doctor
pr-review serve
```

Repeat any custom skill directory flags previously used. Open
<http://localhost:3010>, check a saved PR/MR canvas, and stop the server with Ctrl-C.
GitLab projects need an authenticated `glab`; self-hosted names without `gitlab`
need `PR_REVIEW_HOST=gitlab`. Optional AI chat checks use `pr-review doctor --all-checks`
and require `acpx`.

Back in this repository, return to `main` with `git switch main`.
