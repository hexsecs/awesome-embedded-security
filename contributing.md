# Contributing Guide

Thanks for helping improve this list.

## What to Contribute

Good contributions include:

- New embedded-security tools, references, and learning resources.
- Fixes for stale links, duplicate entries, naming, or categorization.
- Small documentation or workflow improvements that make the list easier to
  maintain.

## Before You Open a PR

Run the local checks:

```bash
npm ci
npm run validate
```

This does three things:

- Runs `markdownlint` over every markdown file in the repository.
- Runs `awesome-lint` on `README.md`.
- Checks `README.md` for duplicate links, malformed entries, entries out of
  alphabetical order, and Table of Contents anchors that don't resolve to a
  real heading.

`validate` deliberately stays fast and offline. To check links as well, which
takes a couple of minutes and needs network access:

```bash
npm run lint:links
```

CI runs both, and retries the link check to absorb hosts that intermittently
drop connections.

### Entry health

A link check only catches URLs that stop resolving. It says nothing about a
repository that has been archived, renamed, or abandoned while its URL still
returns 200 — the kind of decay nobody opens a PR about, because from the
outside the list still looks correct.

The Entry Health workflow covers that gap. It runs on the 8th of each month,
asks GitHub about every entry hosted there, and files what it finds as a
single issue that it rewrites in place rather than opening a new one each
time. It never edits the list itself: what to do about an archived or moved
project is a judgement call, not something a script should make.

You can run it yourself, though it needs a token with public repository read
access and one API request per entry:

```bash
GITHUB_TOKEN=... npm run check:staleness
```

It reports four things that need a decision — a repository that has gone
(404), one that has been renamed or transferred, one that is archived but
missing its 🗄️ marker, and one still carrying 🗄️ after being unarchived —
and one thing that does not. Repositories with no pushes for two years or
more are listed separately, under a heading that says no action is implied.
Quiet is not the same as unmaintained: paper artifacts and
vulnerable-by-design teaching targets are expected to be frozen, and several
entries here were added knowing they were dormant, because they remain the
best option in their niche.

An API error is never reported as a missing repository. A rate-limited or
rejected request is listed as unchecked instead, because the cost of getting
that wrong is someone deleting a live entry.

### Web entry health

Entry Health only knows about the 152 entries hosted on GitHub. The other 93 —
vendor product pages, standards bodies, a GitLab project, documentation portals
— had no health signal beyond "the URL returned 200". A retired product whose
page collapses to the vendor homepage, or a "discontinued" notice, answers 200
just as cheerfully as a live project.

The Web Health workflow covers those. It runs on the 15th of each month, asks
the GitLab API the same questions Entry Health asks GitHub, and for everything
else records where the URL finally lands after redirects plus a hash of the
page with the volatile parts — scripts, nonces, CSRF tokens, rendered
timestamps, cache-busted asset URLs — normalized out. That snapshot lives in
`scripts/web-health-snapshot.json` and the workflow commits it back, so each
run can diff against the last.

```bash
npm run check:web-health          # add --no-write to leave the snapshot alone
```

It reports two things that need a decision: an entry that now redirects to a
*different* page, and a page whose content changed after holding still for a
year or more, flagged as "recheck the description" rather than as an error.

A difference has to show up on two consecutive runs before it counts. Vendor
sites pick a locale or an A/B variant per request, and reporting the first
sighting would file a fresh finding every month forever, so a new one is
listed under "Seen once, watching" for a month first.

Once reported, a finding stays reported. It does not clear itself next month:
the snapshot holds what the repository has *accepted* separately from what the
web currently looks like, so a retired product cannot be announced once and
then quietly forgotten. A finding goes away when the entry is edited, when the
page goes back to what it was, or when someone signs it off by adding it to
`scripts/web-health-acknowledged.json` — a hand-maintained file the script
reads and never writes, with the exact block to paste printed in the report.

Pages unchanged for two years or more are listed separately under a heading
that says no action is implied — a frozen specification or a finished paper
artifact is supposed to sit still.

Hosts that block automated clients are skipped using the same `ignorePatterns`
the link checker uses, and any non-2xx response, timeout, or bot wall is
recorded as unchecked rather than as a finding. Whether a URL is actually dead
is the link check's question, because the cost of getting that wrong is
someone deleting a live entry.

## Entry Guidelines

When adding or updating an entry:

- Put it in the most relevant section.
- Keep entries in alphabetical order within their section. This is enforced,
  and ordering ignores leading punctuation, so `.NET` files under N.
- Name the entry whatever the project calls itself, not an approximation. The
  link checker cannot catch a misspelled name, because the URL still resolves,
  and someone searching the list for the real name will not find it.
- Use the official project page or repository when possible.
- Keep the description short, factual, and non-promotional.
- Avoid duplicates unless there is a clear reason to list both resources.

Use this format:

```md
* [Project Name](https://example.com) - Short description.
```

### Markers

Two optional markers go between the link and the dash:

```md
* [Project Name](https://example.com) 💰 - Short description.
* [Project Name](https://example.com) 🗄️ - Short description.
```

- 💰 marks a project that is commercial or closed-source. It is about the
  licensing, not the price: open-hardware tools you have to buy — HackRF One,
  Proxmark3, ChipWhisperer — are not marked.
- 🗄️ marks a repository its maintainers have archived. Archived is not a
  reason to remove an entry on its own: paper artifacts and vulnerable-by-design
  teaching targets are expected to be frozen. If a maintained successor exists,
  name it at the end of the description.

### Two rules awesome-lint enforces quietly

Both of these fail CI with messages that don't obviously point at the fix:

- A description must not start with the entry's own name. `* [Honeypots](...) -
  Honeypots, honeynets, and ...` is rejected; reword the description so it
  leads with something else.
- A description must start with a capital letter. Without a marker this is
  reported clearly, as `List item description must start with valid casing`.
  With a 💰 or 🗄️ marker the same mistake is reported as `List item link and
  description must be separated with a dash`, which points at the wrong thing
  entirely — if you see that error on an entry that plainly has its dash, check
  the casing. `* [de4dot](...) 🗄️ - .NET deobfuscator.` fails this way.

## Pull Request Notes

In your PR description, include:

- What changed.
- Why it belongs in the list.
- Any quick verification notes if the change is not obvious.

For larger edits, it helps to include the exact section affected or a short
before-and-after explanation.

## Review Expectations

Reviewers will usually check that:

- The resource is relevant to embedded security.
- The placement and naming make sense.
- The description is accurate.
- The validation checks pass.

If something is borderline, maintainers may ask for clarification instead of
rejecting it outright.

## Link Quality

Please avoid:

- Tracking links, shorteners, and mirror sites when an official source exists.
- Dead, misleading, or unrelated destinations.
- Marketing pages with little technical value.

## Security Issues

If you find a security problem in the repository itself, see `SECURITY.md`.
