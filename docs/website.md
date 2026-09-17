# Website development and publishing

The landing page and high-level documentation live in `site/`. They use HTML, CSS, and JavaScript with the repository's existing Vite dependency. There are no website API keys, AI calls, analytics, or remote font dependencies. The local review app remains separate.

## Preview locally

From a checkout containing the website:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm site:dev
```

Open **http://127.0.0.1:4173/pr-review-canvas/**. Vite reloads the page when you edit the source. Stop the server with Ctrl+C.

To preview the exact production output:

```bash
corepack pnpm site:build
corepack pnpm site:preview
```

Open the same URL. Run only one preview/development server on port 4173 at a time. The explicit `/pr-review-canvas/` base path matches GitHub project Pages, so local testing catches broken subpath assets.

## Validate

```bash
corepack pnpm exec playwright install --with-deps chromium
corepack pnpm site:test --workers=2
```

The command builds the site, starts a production preview, and runs browser checks at desktop, tablet, and mobile sizes. It checks source links, layer selection, separate review progress, keyboard-operated folds, scripted chat, copy buttons, no-JavaScript content, and horizontal overflow. Stop any existing server on port 4173 first.

Run `corepack pnpm verify` before pushing repository changes, as required by the contributing guide. The Pages workflow runs the site-specific checks in addition to the repository's normal CI workflow.

## Publish through GitHub Actions

The site URL is **https://vintasoftware.github.io/pr-review-canvas/**. In the repository's Settings → Pages, the publishing source must be **GitHub Actions**. The `GitHub Pages` workflow builds and tests the site, uploads only `dist-site/`, and deploys using GitHub's Pages actions and short-lived workflow permissions. Pull requests build and test without deploying.

Only `main` can publish. Pushes to `main` that change `site/**`, `package.json`, `pnpm-lock.yaml`, or `.github/workflows/pages.yml` trigger the workflow. The `github-pages` deployment environment allows only the `main` branch.

To publish manually, use Actions → GitHub Pages → Run workflow and select `main`. Deployments from other branches are skipped. Source lives in Git; generated output is ignored and uploaded as a Pages artifact, so there is no generated `gh-pages` branch to maintain.

## Demo source and attribution

The interactive sample uses selected excerpts from [TanStack/query #9612](https://github.com/TanStack/query/pull/9612), merged September 5, 2025: 471 additions and 51 deletions across 18 files. Source links are pinned to commit `7922966810988298e6c40761b8888597d6e0e0d7`.

The layer grouping is editorial, the diff excerpts are real, and chat responses are scripted explanations of the linked source. The sample is not a full generated canvas, a live AI conversation, or an endorsement by TanStack. The source is MIT-licensed; its copyright and permission notice ship in `site/public/tanstack-query-LICENSE.txt`.

The provider's new file and tests each occupy one added chunk in the real diff. The sample assigns them to the provider layer and refers back to them from scheduling, rather than implying that the same chunk belongs to multiple layers. The fold contains a real import-only chunk; it does not hide the entire observer change.

## Editorial direction

The site leads with semantic layers for large PRs, followed by folds, contextual chat, local execution and subscription reuse, setup, and configuration. It credits Vinta Software's AI-Native SDLC initiatives. “Local” describes where the app and saved state run; GitHub and AI provider requests still leave the machine, and the user's provider limits still apply.

Inspiration: [CodeRabbit Change Stack](https://www.coderabbit.ai/blog/introducing-change-stack-the-first-ai-native-code-review-interface) for explaining reviews by intent, [Graphite Chat](https://graphite.com/docs/graphite-chat) for contextual review questions, and [Reviewable's documentation](https://docs.reviewable.io/) for connecting the product story with practical review guidance. The copy, visual design, and sample implementation are original to this site.

## Search and sharing

The page includes a descriptive title, canonical URL, Open Graph and Twitter preview metadata, and static JSON-LD for the software, website page, and Vinta Software. Product explanations and FAQs are in the HTML and remain available without JavaScript. Keep structured data consistent with the visible copy; provider charges are separate from the free software.

`site/public/sitemap.xml` lists the production canonical URL. Submit https://vintasoftware.github.io/pr-review-canvas/sitemap.xml in Google Search Console after deployment. A project-level `robots.txt` would not control crawling: robots rules must live at https://vintasoftware.github.io/robots.txt, outside this project's Pages path.

`site/public/social-preview.png` is the 1200 × 630 sharing image. Update its text when changing the product positioning. The footer uses the [official Vinta SVG wordmark](https://cdn.prod.website-files.com/64b9f7763232fd7832edb0c8/681a89078f700d7ca9e6b76c_vinta-wordmark-copy.svg), downloaded from Vinta's homepage and served locally.

The UI and site call diff sections **chunks**. Internal identifiers, stored fields, configuration options, and link targets retain Git’s **hunk** terminology.
