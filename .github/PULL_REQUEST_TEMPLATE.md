<!-- markdownlint-disable-file MD041 -->
<!--
Mirrors "Pull Request Notes" in contributing.md. The failure mode it guards
against is a pull request that a reviewer cannot judge without going and
looking: an entry with no case made for it, or a change whose verification
nobody can reproduce.

MD041 is disabled for this file only, in the file rather than in
.markdownlint-cli2.jsonc: this is a fragment pasted into a pull request
body, not a document, and an H1 at the top of every pull request to make a
linter happy would be worse than the warning.
-->

## What changed

<!-- The section affected, and a before/after if the edit is not obvious. -->

## Why it belongs

<!--
For a new entry: what it does that the entries already listed do not.
For a fix: what was wrong.
-->

## Verification

<!-- Anything you checked that CI cannot: that the project is what it claims, that a moved link is the same project, that a description is accurate. -->

- [ ] `npm ci && npm run validate` passes locally
- [ ] Alphabetical order within the section is preserved
- [ ] 💰 (commercial or closed-source) and 🗄️ (archived upstream) markers are correct

<!--
`npm run validate` is offline and fast. `npm run lint:links` also checks every
URL and takes a couple of minutes; CI runs it either way.

If the checks fail on an entry that plainly has its dash, see
contributing.md → "Two rules awesome-lint enforces quietly".
-->
