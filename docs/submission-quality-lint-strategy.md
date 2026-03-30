# Submission Quality Lint Strategy

This document describes the repository's current markdown validation pipeline and
the additional checks that are still planned.

## Current Coverage

The repository currently enforces three automated checks:

1. Markdown style for repository docs.
1. Awesome-list linting for the curated list.
1. Link health validation for markdown content.

## Implemented Checks

### 1. Markdown Style for Docs

Goal: keep contributor-facing process documentation readable and consistent.

Implemented command:

```bash
npm run lint:markdown
```

Implementation details:

- Tool: `markdownlint-cli2`
- Config: `.markdownlint-cli2.jsonc`
- Current scope:
  - `contributing.md`
  - `docs/**/*.md`

`README.md` is intentionally excluded from markdownlint because the awesome-list
layout relies on dense heading and list formatting that conflicts with the
default markdownlint ruleset.

### 2. Awesome-List Validation

Goal: keep the curated list compliant with awesome-list conventions.

Implemented command:

```bash
npm run lint:awesome
```

Implementation details:

- Tool: `awesome-lint`
- Current scope:
  - `README.md`

### 3. Link Health

Goal: detect dead or drifting references while minimizing flaky failures.

Implemented in CI through `.github/workflows/markdown-lint.yml` using
`.github/workflows/markdown.links.config.json`.

Current behavior:

- Runs on pull requests and pushes to `main` when markdown or workflow config
  changes.
- Runs on a monthly schedule to catch drift.
- Retries link checks and allows controlled `403` responses for known anti-bot
  sites.

## Local Validation Path

Contributors should use the pinned toolchain in `package.json`:

```bash
npm ci
npm run validate
```

`npm run validate` currently runs:

1. `npm run lint:markdown`
1. `npm run lint:awesome`

## GitHub Actions Layout

The repository uses `.github/workflows/markdown-lint.yml` with two jobs:

1. `markdown-quality`

   - Installs pinned npm dependencies with `npm ci`.
   - Runs `npm run validate`.

1. `markdown-link-check`

   - Runs the GitHub Action based markdown link checker.

The workflow also uses:

- SHA-pinned actions.
- `permissions: contents: read`.
- Job timeouts.
- Workflow concurrency cancellation for superseded runs.

## Planned Checks

The following controls are still documented strategy, not yet automated in the
repository:

### Metadata Completeness

Goal: every list item includes enough metadata to be reviewable.

Desired minimum fields per entry:

- Project name.
- URL.
- One-sentence description.

Reference format:

```markdown
* [Project Name](https://example.com) - Short description.
```

Candidate heuristic:

```bash
rg -n "^\* \[[^\]]+\]\(https?://[^)]+\) - .+" README.md
```

### Duplicate Detection

Goal: prevent redundant entries and variant duplicates across sections.

Desired checks:

- Duplicate exact URLs.
- Duplicate project names with different URLs.
- Near-duplicate names differing only by punctuation or case.

Candidate commands:

```bash
# Duplicate URLs
rg -o "https?://[^)\s]+" README.md | sort | uniq -d

# Duplicate markdown link labels
rg -o "\[[^\]]+\]\(https?://[^)]+\)" README.md \
  | sed -E 's/^\[([^\]]+)\].*/\1/' \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/ /g' \
  | sed -E 's/^ +| +$//g' \
  | sort | uniq -d
```

## Triage Labels

Use these labels in PR comments or issue triage:

- `confirmed`: deterministic violation with direct evidence.
- `likely`: high-signal finding with low ambiguity.
- `needs-review`: potential false positive or contextual exception.
