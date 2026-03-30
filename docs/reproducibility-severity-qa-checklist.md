# Reproducibility and Severity QA Checklist

This checklist is the final gate for workstreams in [TRA-2](/TRA/issues/TRA-2#document-plan).

## 1) Reproducibility Evidence Checklist

Use this for every finding and remediation claim.

- [ ] Claim is stated as an observable repository fact (not inference-only).
- [ ] Evidence includes exact file path(s) and line references.
- [ ] Evidence includes exact command(s) used to reproduce (for example `rg`, `sed`, `git diff`).
- [ ] Reproduction can be executed from a clean clone with standard tooling.
- [ ] Before/after state is captured with diff or explicit textual delta.
- [ ] Any assumptions or environment constraints are documented.
- [ ] Validation step confirms the claimed fix or behavior change.

## 2) Severity Consistency Checklist

Apply the CSO rubric consistently across all workstreams.

- [ ] Severity aligns to direct impact on project integrity and maintenance trust.
- [ ] Severity reflects exploitability/likelihood and blast radius, not wording intensity.
- [ ] Similar control failures are assigned equivalent severity across issues.
- [ ] Downgrade/upgrade decisions are justified with explicit rationale.
- [ ] Final severity is stable after cross-workstream comparison.

## 3) CSO Severity Anchor (from TRA-2)

- Critical: trusted-path compromise or systemic maintenance collapse with immediate downstream risk.
- High: materially weak controls/processes that significantly increase risk of bad or stale curation output.
- Medium: bounded process quality gaps without immediate trust break.
- Low: minor editorial/consistency improvement with limited risk impact.
- Informational: hardening guidance without direct risk.

## 4) Cross-Workstream Review Log

Populate this section once workstream issues are complete.

| Issue | Claimed Severity | QA Result | Notes |
| --- | --- | --- | --- |
| [TRA-3](/TRA/issues/TRA-3) | Pending | Pending | In progress; parent waits on child tasks [TRA-7](/TRA/issues/TRA-7) through [TRA-13](/TRA/issues/TRA-13) |
| [TRA-4](/TRA/issues/TRA-4) | Not stated | Partial | Work delivered; explicit severity label missing in issue update |
| [TRA-6](/TRA/issues/TRA-6) | Not stated | Partial | Work delivered; explicit severity label missing in issue update |
