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

This currently does two things:

- Lints `contributing.md`.
- Runs `awesome-lint` on `README.md`.

GitHub Actions also checks markdown links in CI.

## Entry Guidelines

When adding or updating an entry:

- Put it in the most relevant section.
- Use the official project page or repository when possible.
- Keep the description short, factual, and non-promotional.
- Avoid duplicates unless there is a clear reason to list both resources.

Use this format:

```md
* [Project Name](https://example.com) - Short description.
```

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
