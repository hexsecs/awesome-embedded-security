# Contributing Guide

This repository is curated as a security reference. Every contribution should be
easy to review, reproduce, and verify from a clean clone.

## Scope

Accepted changes include:

- New embedded-security resources and references.
- Quality fixes for existing entries, such as stale links, naming, categorization,
  or duplication.
- Documentation and workflow changes that improve curation quality or repository
  maintenance.

## Local Validation

Use the pinned tooling in `package.json` before opening a pull request:

```bash
npm ci
npm run validate
```

Current validation behavior:

- `npm run lint:markdown` checks `contributing.md` and `docs/**/*.md` with
  `markdownlint-cli2`.
- `npm run lint:awesome` runs `awesome-lint` against `README.md`.
- GitHub Actions also runs markdown link checking via
  `.github/workflows/markdown-lint.yml`.

`README.md` is intentionally excluded from markdownlint because the awesome-list
layout uses formatting patterns that conflict with the default markdownlint
ruleset.

## Required PR Evidence

Every pull request should include enough evidence for a reviewer to reproduce the
claim from repository state.

Use this template in the PR description:

```md
## Change Summary
- What changed and why

## Evidence
- Files changed: `README.md`, `...`
- Reproduction commands:
  - `git diff -- README.md`
  - `rg -n "<tool-or-section>" README.md`
- Expected result:
  - Before: <state>
  - After: <state>

## Verification
- [ ] `npm run validate` passes locally
- [ ] Markdown link check passes in CI
- [ ] Entry placement/category is correct
- [ ] Description is accurate and neutral
```

Minimum evidence requirements:

- Exact file paths and line references for each claim.
- Exact commands used for reproduction or verification.
- A clear before-and-after delta.
- Any assumptions or environment constraints.

## Reviewer Triage Flow

Follow this sequence for every PR:

1. Confirm scope and claim.

   - Read the PR summary and map each claim to changed files.
   - Reject ambiguous claims that cannot be verified from repository state.

1. Reproduce claimed changes.

   - Run the commands provided by the contributor.
   - Validate that command output supports each claim.
   - Request missing commands or evidence if reproduction is incomplete.

1. Verify curation quality.

   - Confirm section or category placement is correct.
   - Check for duplicates and naming consistency.
   - Validate descriptions are factual, concise, and non-promotional.

1. Verify repository checks.

   - Ensure `npm run validate` and the markdown link workflow pass.
   - If CI is not available, run the equivalent local checks and report results.

1. Make a review decision.

   - Approve only when claims are reproducible and checks pass.
   - Otherwise request changes with precise, reproducible remediation steps.

## Reviewer False-Positive Guardrails

Do not reject a contribution on intuition alone. Use the matrix below before
deciding.

### Reviewer Decision Matrix

| Proposed rejection reason | Required verification step | Decision if verification fails |
| --- | --- | --- |
| Tool is not embedded-security relevant | Confirm `README.md` or supporting docs show no embedded, firmware, hardware, IoT, or low-level security use case. | Mark as `Needs Clarification` and ask for a concrete use case. |
| Project is dead or unmaintained | Check recent releases, commits, issues, and whether the project still supports current workflows. | Downgrade to `Stale but Useful` and allow if it remains historically valuable. |
| Duplicate entry | Search the list for the exact project and meaningful synonyms, renames, or forks. | Keep the submission open and request dedup wording. |
| Security value is weak | Validate whether at least one realistic workflow is enabled, such as audit, reversing, fuzzing, hardening, forensics, or verification. | Request an expanded description and usage example instead of immediate rejection. |
| Commercial or proprietary tool not suitable | Verify license and ecosystem value against existing list precedent. | Escalate for consistency review instead of rejecting solo. |
| Low-quality description | Confirm the problem is content quality only, not tool relevance. | Convert to an edit request and reject only after the response window expires. |

### Decision Outcomes

- `Accept`: Meets quality and relevance checks.
- `Needs Clarification`: Evidence is incomplete or ambiguous.
- `Escalate`: Potential policy inconsistency or reviewer disagreement.
- `Reject`: Reserved for reproducible, documented policy failures.

### Edge Cases

1. Fork with active maintenance and archived upstream.

   - Treat the fork as eligible when it is now the de facto maintained source.
   - Ask the contributor to reference both upstream and maintained fork if useful.

1. Tool is old but still standard in labs.

   - Age alone is not rejection criteria.
   - Accept when workflows remain valid and the community still references it.

1. Dual-use tool with embedded applicability.

   - Accept if the contributor demonstrates embedded-specific usage.
   - Update the description to anchor the embedded context.

1. Vendor docs moved or repo link changed.

   - Request a URL correction first.
   - Do not reject for transient link rot if project identity is clear.

1. New category proposal for emerging techniques.

   - Escalate for taxonomy review instead of rejecting as out of scope.
   - Accept pending category decision when contribution quality is otherwise
     strong.

## Appeal Path

If a submission is rejected and the contributor believes the decision is
incorrect, they should update the PR or issue with:

1. The rejection reason being appealed.
1. A short evidence bundle, such as links, usage proof, or maintenance signals.
1. The exact text proposed for the list entry.

Appeal handling rules:

- A different reviewer or maintainer performs a second review.
- The second review cites concrete policy criteria and evidence.
- If disagreement remains, maintainers resolve it with a documented final
  decision.

## Verification Checklist

A PR is review-complete only when all items are true:

- [ ] Every recommendation or finding references exact file paths and lines.
- [ ] Reproduction commands execute successfully from a clean clone.
- [ ] Before-and-after behavior is explicitly demonstrated.
- [ ] CI checks pass, including `npm run validate` and link validation.
- [ ] Any rejected or blocked claim includes a concrete reason and next action.

## Policy-Evasion Variant Checks

Use these checks to detect contributions that imitate acceptable entries while
bypassing curation policy.

### Renamed Duplicate Resources

- Pattern: the same project is submitted with alternate naming, acronym
  expansion, or minor URL variation.
- Detection heuristics:
  - Normalize destination identifiers, such as domain plus canonical
    `owner/repo`, and compare them to existing entries.
  - Compare aliases and taglines for near-duplicate semantics.
  - Run targeted searches in `README.md` before accepting a resource as novel.
- Escalate when:
  - Duplicate submissions continue after reviewer correction.
  - Wording appears intentionally altered to bypass previous removal decisions.

### Mirror Domains and Redirect Wrappers

- Pattern: links use non-canonical mirrors, shorteners, or tracking wrappers
  instead of upstream sources.
- Detection heuristics:
  - Prefer official project pages or repos when available.
  - Inspect redirect chains and query parameters for affiliate or campaign
    tracking.
  - Reject links that conceal final destinations during review.
- Escalate when:
  - The destination changes between initial review and merge.
  - Redirect targets resolve to unrelated or commercial landing pages.

### Stale Forks Presented as Upstream

- Pattern: inactive forks or mirrors are represented as the primary resource.
- Detection heuristics:
  - Confirm fork lineage and recent maintenance through commits, issues, and
    releases.
  - Validate maintainer identity and governance claims in project docs.
  - Require explicit fork labeling when a fork is listed for a justified reason.
- Escalate when:
  - Fork staleness could mislead users into unsafe or obsolete workflows.
  - The submitter omits fork disclosure after reviewer request.

### Marketing Content Disguised as Research

- Pattern: promotional pages are submitted as technical references.
- Detection heuristics:
  - Require technical substance such as methods, code, reproducible
    experiments, or primary data.
  - Flag conversion-first pages like pricing, lead forms, or demo funnels when
    they lack technical depth.
  - Prefer neutral technical artifacts, such as papers, talks, docs, or
    benchmarks.
- Escalate when:
  - Claims are non-verifiable or methodology is absent.
  - Submitters repeatedly rotate equivalent promotional URLs after rejection.

## High-Risk Escalation Criteria

Escalate for maintainer consensus when one or more of the following apply:

- Multiple evasion signals appear in the same pull request.
- A contributor shows repeated evasion behavior across recent submissions.
- Resource authenticity or ownership cannot be validated from primary sources.
- Link behavior indicates potential trust degradation, such as malicious
  redirects, deceptive ownership, or fabricated claims.

Recommended response:

- Pause merge and request a second maintainer review.
- Document the evidence-based rationale in the PR.
- Add newly observed evasion patterns to this guide for future triage.

## Finding Recommendation Format

When leaving review findings, use this structure to keep report assembly
deterministic:

```md
### Finding: <short title>
- Severity: <low|medium|high|critical|informational>
- Evidence:
  - File: `<path>:<line>`
  - Command: `<exact command>`
  - Output summary: <what proves the issue>
- Reproduction steps:
  1. <step>
  2. <step>
- Recommendation:
  - <specific remediation>
- Verification of fix:
  - Command: `<exact command>`
  - Expected result: <pass condition>
```

## Dynamic Validation Workflow

Use this lightweight check for any newly submitted URL before merge.

1. Reachability.

   - Confirm HTTPS is used and the endpoint resolves.
   - Accept `2xx` responses or intentional `403` responses for gated resources.
   - Reject dead links, parking pages, and typo-squat lookalikes.

1. Redirect safety.

   - Follow redirects to the final destination.
   - Verify the final domain and path match the claimed project or vendor.
   - Reject suspicious redirect chains, unrelated destinations, or deceptive
     tracking hops.

1. Content sanity.

   - Confirm the page actually contains the described resource.
   - Prefer official repos or docs over mirrors when available.
   - Reject pages that appear malicious, deceptive, or unrelated to embedded
     security.

1. Reviewer handoff.

   - If behavior appears anomalous, request a second maintainer review before
     merge.
   - Document the observed behavior and exact URL chain in the PR comment.
