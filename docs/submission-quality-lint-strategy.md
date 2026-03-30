# Submission Quality Lint Strategy

This document defines automatable static checks for list submissions, with CI-ready commands and triage guidance.

## Scope

Target files:
- `README.md`
- `contributing.md`
- `docs/**/*.md`

## CI Check Pipeline

Run checks in this order to fail fast while keeping noise low.

1. Formatting and structure
2. Metadata completeness
3. Duplicate detection
4. Link health

## 1) Formatting and Structure

Goal: enforce consistent markdown style and list formatting.

Suggested command:

```bash
npx markdownlint-cli2 "**/*.md" "#node_modules"
```

Suggested policy:
- Require one top-level heading per file.
- Disallow trailing spaces and inconsistent heading increments.
- Enforce list indentation and blank lines around headings/lists.

Noise reduction:
- Keep repo-level `.markdownlint.jsonc` exceptions narrow and line-specific.
- Prefer fixing style violations over disabling rules globally.

## 2) Metadata Completeness

Goal: every list item must include minimum metadata so entries are reviewable.

Minimum required submission fields per entry:
- Project name
- URL
- One-sentence description

List item format requirement:

```markdown
* [Project Name](https://example.com) - Short description.
```

Suggested command (fast heuristic):

```bash
rg -n "^\* \[[^\]]+\]\(https?://[^)]+\) - .+" README.md
```

Triage notes:
- If a valid entry format intentionally differs (for section-specific reasons), mark as `needs-review` and gate by maintainer decision.
- If URL is present but no description, classify as `likely` quality defect.

## 3) Duplicate Detection

Goal: prevent redundant entries and variant duplicates across sections.

Checks:
- Duplicate exact URLs
- Duplicate project names with different URLs
- Near-duplicate names differing only by punctuation/case

Suggested commands:

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

Triage notes:
- If duplicate URL appears with substantially different context (for example, tool and paper homepage), classify as `needs-review`.
- If same project appears in multiple categories without clear justification, classify as `likely` duplicate.

## 4) Link Health

Goal: detect dead or drifting references while minimizing flaky failures.

Suggested command:

```bash
npx awesome-lint README.md
```

Existing CI already runs markdown link checking plus awesome-lint in `.github/workflows/markdown-lint.yml`.

Noise reduction:
- Allow controlled status-code exceptions for known anti-bot sites via `.github/workflows/markdown.links.config.json`.
- Use retries and monthly scheduled runs to catch drift without blocking contributors on transient outages.

Triage notes:
- `403` with known anti-bot behavior: `needs-review` unless persistent for more than 2 runs.
- `404`/`410`: `likely` broken link.
- DNS/TLS timeout: `needs-review` first, `likely` if repeatable across reruns.

## Finding Confidence Levels

Use the following confidence labels in PR comments or issue triage:
- `confirmed`: deterministic violation with direct evidence (for example malformed list item, exact duplicate URL, `404` confirmed twice).
- `likely`: high-signal check hit with low ambiguity (for example missing description, duplicate normalized project name).
- `needs-review`: potential false positive or contextual exception.

## Suggested GitHub Actions Layout

Use a dedicated workflow (for example `.github/workflows/submission-quality.yml`) with these jobs:

1. `markdown-style`: markdownlint on all markdown files.
2. `metadata-and-duplicates`: regex and duplicate commands above.
3. `links`: existing link checker and awesome-lint.

PR policy:
- Block on `confirmed` and `likely` findings.
- Allow maintainers to override `needs-review` with rationale in review comments.

## Example Local Pre-Submission Command

```bash
npx markdownlint-cli2 "**/*.md" "#node_modules" \
  && npx awesome-lint README.md \
  && rg -o "https?://[^)\s]+" README.md | sort | uniq -d
```

