# Contributing Guide

This repository is curated as a security reference. Every contribution must be easy to review, reproduce, and verify.

## Scope

Accepted changes include:

- New embedded-security resources/tools
- Quality fixes for existing entries (stale links, naming, categorization, duplication)
- Structural/documentation improvements that improve curation quality

## Required PR Evidence

Every pull request must include enough evidence for a reviewer to reproduce your claim from a clean clone.

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
- [ ] Markdown links check passes
- [ ] Awesome linter passes
- [ ] Entry placement/category is correct
- [ ] Description is accurate and neutral
```

Minimum evidence requirements:

- Exact file path(s) and line references for each claim
- Exact command(s) used for reproduction/verification
- Clear before/after delta (diff or explicit textual comparison)
- Any assumptions or environment constraints

## Reviewer Triage Flow (Reproducible)

Follow this sequence for every PR:

1. Confirm scope and claim
- Read PR summary and map each claim to changed files.
- Reject ambiguous claims that cannot be verified from repository state.

2. Reproduce claimed changes
- Run the commands provided by the contributor.
- Validate that command output supports each claim.
- Request missing commands/evidence if reproduction is incomplete.

3. Verify curation quality
- Confirm section/category placement is correct.
- Check for duplicates and naming consistency.
- Validate descriptions are factual, concise, and non-promotional.

4. Verify repository checks
- Ensure markdown link checks and awesome-list linting pass in CI.
- If CI is not available, run equivalent local checks and report results.

5. Make review decision
- Approve only when claims are reproducible and checks pass.
- Otherwise request changes with precise, reproducible remediation steps.

## Reviewer False-Positive Guardrails

Do not reject a contribution on intuition alone. Use the matrix below before deciding.

### Reviewer Decision Matrix

| Proposed rejection reason | Required verification step | Decision if verification fails |
| --- | --- | --- |
| "Tool is not embedded-security relevant" | Confirm README/docs show no embedded, firmware, hardware, IoT, or low-level security use case. | Mark as `Needs Clarification` (not rejected). Ask contributor for concrete use case. |
| "Project is dead/unmaintained" | Check recent releases/commits/issues and whether project still works for current workflows. | Downgrade to `Stale but Useful` and allow if historically valuable with clear note. |
| "Duplicate entry" | Search the list for exact project and meaningful synonyms/renames/forks. | Keep submission open and request dedup merge wording. |
| "Security value is weak" | Validate whether at least one realistic security workflow is enabled (audit, reversing, fuzzing, hardening, forensics, verification). | Request expanded description and usage example instead of immediate rejection. |
| "Commercial/proprietary tool not suitable" | Verify project license and ecosystem value against existing list precedent. | Escalate for consistency review; do not reject as a solo reviewer. |
| "Low-quality description" | Confirm whether issue is content quality only, not tool relevance. | Convert to edit request; reject only after no response window expires. |

### Decision Outcomes

- `Accept`: Meets quality/relevance checks.
- `Needs Clarification`: Evidence is incomplete or ambiguous.
- `Escalate`: Potential policy inconsistency or reviewer disagreement.
- `Reject`: Only after reproducible, documented verification against policy.

### Edge-Case Examples

1. Fork with active maintenance, original archived
- Treat as eligible when fork is now the de facto maintained source.
- Ask contributor to reference both upstream and maintained fork if helpful.

2. Tool is old but still standard in labs
- Age alone is not rejection criteria.
- Accept when workflows remain valid and community still references it.

3. Dual-use tool (general RE plus embedded applicability)
- Accept if contributor demonstrates embedded-specific usage.
- Update description to anchor embedded context.

4. Vendor docs moved, repo link changed
- Request URL correction first.
- Do not reject for transient link rot if project identity is clear.

5. New category proposal for emerging techniques
- Escalate for taxonomy review instead of rejecting as out of scope.
- Accept pending category decision when contribution quality is otherwise strong.

## Appeal Path (Contributor-Facing)

If your submission is rejected and you believe the decision is incorrect, open or update the PR/issue with:

1. The rejection reason you are appealing.
2. A short evidence bundle (links, usage proof, maintenance signals).
3. The exact text you propose for the list entry.

Appeal handling rules:

- A different reviewer (or maintainer) performs a second review.
- The second review must cite concrete policy criteria and evidence.
- If disagreement remains, maintainers resolve via documented final decision.

## Verification Checklist (Reviewer Gate)

A PR is review-complete only when all items are true:

- [ ] Every recommendation/finding references exact file path(s) and line(s)
- [ ] Reproduction commands execute successfully from a clean clone
- [ ] Before/after behavior is explicitly demonstrated
- [ ] CI checks pass (`Check Markdown links`, `awesome-lint`)
- [ ] Any rejected/blocked claim includes concrete reason and next action

## Policy-Evasion Variant Checks

Use these checks to detect contributions that imitate acceptable entries while bypassing curation policy.

### 1. Renamed duplicate resources

- Pattern: same project submitted with alternate naming, acronym expansion, or minor URL variation.
- Detection heuristics:
  - Normalize destination identifiers (domain plus canonical `owner/repo`) and compare to existing entries.
  - Compare aliases/taglines in descriptions for near-duplicate semantics.
  - Run targeted searches in `README.md` before accepting a resource as novel.
- Escalate when:
  - Duplicate submissions continue after reviewer correction.
  - Wording appears intentionally altered to bypass previous removal decisions.

### 2. Mirror domains and redirect wrappers

- Pattern: links use non-canonical mirrors, shorteners, or redirect/tracking wrappers in place of upstream sources.
- Detection heuristics:
  - Prefer official project pages/repos when available.
  - Inspect redirect chains and query parameters for affiliate or campaign tracking.
  - Reject links that conceal final destinations during review.
- Escalate when:
  - Destination changes between initial review and merge.
  - Redirect targets resolve to unrelated or commercial landing pages.

### 3. Stale forks presented as upstream

- Pattern: inactive forks or mirrors are represented as primary resources.
- Detection heuristics:
  - Confirm fork lineage and recent maintenance (commits, issues, releases).
  - Validate maintainer identity and governance claims in project docs.
  - Require explicit fork labeling when listing a fork for a justified reason.
- Escalate when:
  - Fork staleness could mislead users into unsafe or obsolete workflows.
  - Submitter omits fork disclosure after reviewer request.

### 4. Marketing content disguised as research

- Pattern: promotional pages submitted as technical references.
- Detection heuristics:
  - Require technical substance (methods, code, reproducible experiments, primary data).
  - Flag conversion-first pages (pricing, lead forms, demo funnels) lacking technical depth.
  - Prefer neutral technical artifacts (papers, talks, docs, benchmarks).
- Escalate when:
  - Claims are non-verifiable or methodology is absent.
  - Submitter repeatedly rotates equivalent promotional URLs after rejection.

## High-Risk Escalation Criteria

Escalate for maintainer consensus when one or more of the following apply:

- Multiple evasion signals appear in the same pull request.
- Contributor shows repeated evasion behavior across recent submissions.
- Resource authenticity or ownership cannot be validated from primary sources.
- Link behavior indicates potential trust degradation (malicious redirects, deceptive ownership, fabricated claims).

Recommended response:

- Pause merge and request a second maintainer review.
- Document evidence-based rejection rationale in the PR.
- Add the newly observed evasion pattern to this guide for future triage.

## Finding Recommendation Format (for audit/report compilation)

When leaving review findings, use this structure to keep report assembly deterministic:

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

This format is required whenever a reviewer recommends a change, so findings can be copied directly into final reports without rework.

## Dynamic Validation Workflow (Web Resources)

Use this lightweight check for any newly submitted URL before merge.

1. Reachability
- Confirm HTTPS is used and the endpoint resolves.
- Accept `2xx` responses or intentional `403` for gated resources.
- Reject dead links, parking pages, and typo-squat lookalikes.

2. Redirect safety
- Follow redirects to the final destination.
- Verify final domain and path match the claimed project/vendor.
- Reject suspicious redirect chains, unrelated destinations, or deceptive tracking hops.

3. Content sanity
- Confirm the page actually contains the described resource.
- Prefer official repos/docs over mirrors when available.
- Reject pages that appear malicious, deceptive, or unrelated to embedded security.

4. Reviewer handoff (when uncertain)
- If behavior appears anomalous, request a second maintainer review before merge.
- Document what was observed and the exact URL chain in the PR comment.
