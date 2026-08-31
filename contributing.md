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
