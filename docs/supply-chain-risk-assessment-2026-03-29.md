# Supply Chain Risk Assessment

- Project: `awesome-embedded-security`
- Auditor: Supply Chain Auditor (Trail of Bits Security)
- Initial assessment date: 2026-03-29
- Last updated: 2026-03-30
- Scope: repository-level dependency surface, CI dependencies, and supply-chain
  controls

## Executive Summary

The original 2026-03-29 assessment identified two high-priority CI weaknesses:

1. `awesome-lint` was executed through a floating `npx` install path.
1. The markdown link checker action was referenced by a mutable tag.

Those findings have since been remediated. The repository now uses a committed
`package.json` and `package-lock.json`, installs pinned npm tooling with
`npm ci`, and references GitHub Actions by commit SHA.

The primary remaining risks are maintenance and governance gaps rather than an
unbounded dependency surface.

## Current State

### Repository Tooling

- `package.json` and `package-lock.json` are present at the repository root.
- CI tooling is pinned in `package.json`.
- Local and CI validation now share the same npm-managed toolchain.

### GitHub Actions Posture

The markdown workflow in `.github/workflows/markdown-lint.yml` now uses:

- `ubuntu-24.04`
- SHA-pinned `actions/checkout`
- SHA-pinned `actions/setup-node`
- SHA-pinned `gaurav-nelson/github-action-markdown-link-check`
- `npm ci` with a committed lockfile
- explicit `permissions`, `timeout-minutes`, and `concurrency`

### Governance Controls

The repository now includes:

- `.github/dependabot.yml` for npm and GitHub Actions updates
- `.github/CODEOWNERS`
- `SECURITY.md`
- `.gitignore` for local-only tooling and dependency directories

## Findings Status

### Resolved: Unpinned npm package execution in CI

- Original evidence: CI used `npx awesome-lint` without a lockfile.
- Current state: CI installs dependencies with `npm ci` and runs the pinned
  `awesome-lint` package from `package-lock.json`.
- Status: resolved.

### Resolved: Third-party action not pinned to immutable commit SHA

- Original evidence: the markdown link checker used a mutable version tag.
- Current state: the action is pinned to a full commit SHA.
- Status: resolved.

### Resolved: First-party action not SHA pinned

- Original evidence: `actions/checkout@v4` was used by tag.
- Current state: `actions/checkout` and `actions/setup-node` are both pinned to
  immutable SHAs.
- Status: resolved.

### Resolved: Floating runner image

- Original evidence: CI used `ubuntu-latest`.
- Current state: the workflow is pinned to `ubuntu-24.04`.
- Status: resolved.

## Residual Risk

Remaining concerns are now mostly procedural:

- The repository still relies on maintainers to keep docs and policy aligned
  with actual automation.
- Metadata completeness and duplicate detection are documented but not yet fully
  automated.
- The curated `README.md` intentionally uses formatting that falls outside the
  current markdownlint scope.

## Recommended Next Steps

1. Add metadata completeness and duplicate-detection checks for `README.md`.
1. Periodically review Dependabot updates for pinned GitHub Actions and npm
   packages.
1. Revisit whether portions of `README.md` can be validated with a custom
   markdownlint profile without fighting awesome-list formatting.

## Historical Note

This document is maintained as a living assessment. Findings should be updated
when repository controls change so the assessment reflects current reality
instead of a point-in-time snapshot only.
