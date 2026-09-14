# Release data review

Reviewed on 2026-09-14. Scope: the extracted source, prompts, skills, tests, and committed
fixtures, including `__fixtures__/pr-278/review.json` (the SHL server PR).

The SHL canvas contains engineering descriptions, source paths, commit IDs, the repository
URL and public GitHub author handle. No patient records, personal contact details, production
credentials, or private service URLs were found. Its `dev-shl-service-token-change-me` value
is an explicitly named development placeholder from `.env.example`. Secret variable names
appear in the documentation; their values do not.

The captured ACP fixture contained a developer's absolute home-directory path. It was
replaced with `/workspace/example-project`. The authentication fixture uses `someone@example.com`;
the captured read output is suppressed.

Only tracked tool files were extracted. Building Blocks Git history, `.env` files, generated
canvases, chat transcripts, node_modules, and browser traces were excluded. The new repository
ignores those runtime files. This review covers the release files, not all historical SHL
source or future generated canvases.

A pattern scan of all 276 extracted text files checked private-key headers, common provider
credentials, credential-bearing URLs, personal filesystem paths, and email addresses. Candidate
URLs were redaction-test examples; the other matches were Git SSH remotes. No live credentials
were found. This is a best-effort source review, not a guarantee about future attachments.
