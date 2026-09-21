# Publishing to npm

Pushing a version tag runs the release workflow: full CI on Node.js 22 and 24,
then npm publishing and GitHub release creation. npm authenticates through GitHub
OIDC trusted publishing, as in `vintasoftware/fhirpath-ts`. No npm token secret is needed.

## Release a version

Open a PR with the version change in `package.json` and release notes and upgrade
instructions in `CHANGELOG.md`. Use `npm version minor --no-git-tag-version`
(or `patch` / `major`) and `corepack pnpm install --lockfile-only`.

Merge the PR after CI passes. From a clean checkout, pull `main` and push the tag:

```bash
git switch main
git pull --ff-only
release_version=$(node -p "require('./package.json').version")
git tag -a "v${release_version}" -m "Release ${release_version}"
git push origin "v${release_version}"
```

Watch **Actions → Release**. After it succeeds, check npm:

```bash
npm view "@vintasoftware/pr-review-canvas@${release_version}" version dist.integrity
```

The tag must match `package.json`. Stable versions use npm's `latest` channel;
prereleases use `next` and create a GitHub prerelease. The workflow generates GitHub
release notes from merged PRs. The changelog contains the detailed upgrade instructions.

Versions through 0.4.0 were published manually. Use a new version for the first
automated release; do not move or re-push an existing release tag.

## One-time setup

Create the `npm-release` environment in this GitHub repository. On the npm package's
**Settings → Trusted publishing**, add a GitHub Actions publisher with:

| Field             | Value              |
| ----------------- | ------------------ |
| Organization      | `vintasoftware`    |
| Repository        | `pr-review-canvas` |
| Workflow filename | `release.yml`      |
| Environment       | `npm-release`      |
| Allowed action    | `npm publish`      |

The environment and workflow names must match exactly. Select direct `npm publish`
permission; stage-only permission does not support automatic publication.

To check the workflow after setup without releasing anything:

```bash
gh workflow run release.yml --ref main
```

Manual runs always verify and dry-run the package. They never publish, push tags,
or create releases. A dry run does not validate npm's OIDC authorization; that is
exercised on the first new tagged release.

## What the workflow checks

The release calls the same CI workflow used by pull requests, at the tagged commit.
Both Node versions run lint, formatting, strict types, coverage, browser tests, and
the package installation smoke test. Publishing waits for both jobs to pass.

The publish job uses npm 11.11.0, packs the source package, prints its contents with
`npm publish --dry-run`, and publishes that same tarball with provenance. It skips
lifecycle scripts because CI has already run the full suite and the package needs
no compilation. Local `npm publish` still runs `prepublishOnly` as before.

## If a release fails

Fix verification failures before publishing a new version. npm versions cannot be
reused once published. If npm publication succeeded but GitHub release creation
failed, create the GitHub release for the existing tag; do not retry publication.

For authentication failures, check the npm trusted publisher's repository,
workflow, environment, and `npm publish` permission. A local npm login is separate
from the workflow's OIDC credentials.

Reference: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
