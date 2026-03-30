# Supply Chain Risk Assessment

- Project: `awesome-embedded-security`
- Auditor: Supply Chain Auditor (Trail of Bits Security)
- Date: 2026-03-29
- Scope: Repository-level dependency surface, CI dependencies, and supply-chain controls

## Executive Summary

This repository has **no application package manifests or lockfiles** (no npm/pnpm/yarn, pip, cargo, go, maven, gradle, etc.), so the conventional transitive dependency tree is effectively empty.

The primary supply-chain attack surface is the GitHub Actions workflow and dynamic tool execution in CI. Two high-priority weaknesses were identified:

1. CI executes `npx awesome-lint` without a pinned version or lockfile.
2. Third-party GitHub Action `gaurav-nelson/github-action-markdown-link-check@v1` is tag-pinned, not commit-SHA pinned.

## Methodology and Results

### 1) Dependency Enumeration

Checked for common dependency manifests/lockfiles at repository root and subdirectories.

- Found: none
- Inferred transitive tree: none for runtime/build artifacts in-repo
- Remaining dependency surface: GitHub-hosted runner image + actions + dynamically downloaded npm package during workflow execution

### 2) Maintainer / Trust Analysis

Assessed trust boundaries for CI dependencies:

- `actions/checkout@v4`
  - Maintainer: GitHub (high trust baseline)
  - Risk: tag reference can move in future major/minor updates within tag policy (lower risk than unknown third-party, but still mutable vs SHA)

- `gaurav-nelson/github-action-markdown-link-check@v1`
  - Maintainer: third-party
  - Risk factors: bus factor unknown, account takeover risk, tag mutability risk if not SHA pinned

- `npx awesome-lint`
  - Maintainer: npm package maintainers (not pinned)
  - Risk factors: package compromise, malicious publish, dependency confusion/typosquat at transitive level, and non-reproducible installs

### 3) Typosquatting Detection

- No local package manifests to evaluate for suspicious names.
- CI dynamic install (`npx awesome-lint`) leaves room for package-level supply-chain events over time.

### 4) Version Pinning Audit

Findings:

- `actions/checkout@v4` is version-tag pinned, not SHA pinned.
- `gaurav-nelson/github-action-markdown-link-check@v1` is major-tag pinned, not SHA pinned.
- `npx awesome-lint` is fully floating (latest at execution time).
- `runs-on: ubuntu-latest` is floating runner image.

### 5) Known Vulnerability Scanning

- No dependency lockfile exists, so deterministic vulnerability scanning is not possible for CI-installed npm artifacts.
- Static scan of manifests is not applicable due to absent manifests.

### 6) Build Reproducibility

Current state is **not reproducible** for CI checks due to floating components (`ubuntu-latest`, tag-pinned actions, unpinned `npx` package).

## Findings (Severity Ranked)

### High: Unpinned npm package execution in CI

- Location: `.github/workflows/markdown-lint.yml`
- Evidence: `run: npx awesome-lint`
- Impact:
  - Pulls whatever version is current at runtime.
  - No lockfile/provenance pinning.
  - A compromised package publish can execute attacker code in CI.
- Recommendation:
  - Create `package.json` + lockfile for CI tooling only and run pinned dependency via `npm ci` + `npx awesome-lint` from lockfile context, or
  - Pin exact version in command (`npx awesome-lint@<exact_version>`) as a minimum control.

### High: Third-party action not pinned to immutable commit SHA

- Location: `.github/workflows/markdown-lint.yml`
- Evidence: `uses: gaurav-nelson/github-action-markdown-link-check@v1`
- Impact:
  - Tag references are mutable; compromised maintainer/repo could alter code behind the tag.
- Recommendation:
  - Pin to full commit SHA and track updates through Dependabot or periodic review.

### Medium: First-party action not SHA pinned

- Location: `.github/workflows/markdown-lint.yml`
- Evidence: `uses: actions/checkout@v4`
- Impact:
  - Lower risk than third-party, but still not immutable.
- Recommendation:
  - Pin to commit SHA for strict reproducibility and tamper resistance.

### Medium: Floating runner image

- Location: `.github/workflows/markdown-lint.yml`
- Evidence: `runs-on: ubuntu-latest`
- Impact:
  - Runtime environment changes over time, reducing reproducibility and potentially introducing unexpected behavior.
- Recommendation:
  - Pin to explicit runner version (`ubuntu-24.04` etc.) and review periodically.

## Remediation Plan

1. Pin all actions to immutable commit SHAs.
2. Remove floating `npx` install path:
   - add minimal `package.json` for CI tooling,
   - pin `awesome-lint` exact version,
   - commit lockfile,
   - use `npm ci` in workflow.
3. Pin runner image to explicit version.
4. Add Dependabot (`github-actions` + `npm`) to manage controlled updates.
5. Add policy check (e.g., `step-security/harden-runner` and/or organization policy) to enforce pinned actions.

## Immediate Alerts

- Immediate attention required for:
  - Unpinned `npx awesome-lint` execution.
  - Third-party action referenced by mutable tag.

## Hand-off Notes

- Reported to: Audit Lead
- Tooling Engineer coordination recommended for:
  - CI hardening automation,
  - action SHA pinning workflow,
  - reproducible tooling bootstrap for markdown lint pipeline.

## Remediation Status Addendum (2026-03-29)

Applied in-repo hardening changes:

- Workflow runner pinned from `ubuntu-latest` to `ubuntu-24.04`.
- `actions/checkout` pinned to immutable SHA for `v4`.
- `gaurav-nelson/github-action-markdown-link-check` pinned to immutable SHA for `v1`.
- Added `actions/setup-node` pinned to immutable SHA for `v4` with Node 20 and npm cache.
- Replaced floating `npx awesome-lint` with lockfile-based install:
  - Added `package.json` with `awesome-lint` pinned to `2.2.3`.
  - Added `package-lock.json`.
  - Workflow now runs `npm ci` then `npm run lint:awesome`.

Residual risk:

- CI policy enforcement is still procedural; consider adding org/repo policy checks to block non-SHA action refs.
- Existing markdown content currently fails `awesome-lint`; this is quality/compliance debt, not a supply-chain exploit indicator by itself.
