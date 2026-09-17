#!/usr/bin/env node
// Translates the Validate Markdown failures whose messages point at the
// wrong thing into a single pull request comment.
//
// The worst of them: on an entry carrying a 💰 or 🗄️ marker, a description
// that does not open with a capital letter is reported by awesome-lint as
// "List item link and description must be separated with a dash" — on a line
// that plainly has its dash. contributing.md documents it, but a guide helps
// the contributor who read it before failing, and the people who hit this
// are first-time contributors who have not.
//
// Runs from .github/workflows/pr-guidance.yml on workflow_run, so it has a
// writable token even for pull requests from forks. Its inputs — the failing
// run's log and the pull request's README.md — come from a build artifact
// and are untrusted: they are pattern-matched and quoted, never executed,
// and every quoted fragment is stripped and truncated before it goes into a
// comment body.
//
// Three rules:
//   - it never changes whether the pull request passes (it exits 0 always,
//     from a workflow that is not a required check);
//   - it says nothing at all when the failure is not one it recognises, so
//     that a comment from it always means something;
//   - it rewrites its own comment in place rather than stacking a new one on
//     every push, the same way scripts/check-staleness.js handles its issue.
//
// Deliberately NOT handled here: "Awesome list must reside in a valid git
// repository". It is the most misleading message the tooling produces, but
// it cannot occur in CI, so a branch for it here would be dead code that
// reads like live code. awesome-lint's github rule only takes its throwing
// path when `git branch --show-current` is non-empty and that branch has no
// configured remote; actions/checkout leaves a detached HEAD, so the name is
// empty and the rule resolves `origin` instead. Verified on awesome-lint
// 2.3.0 against all four states — default branch, new local branch, that
// branch with a remote set, and detached HEAD. It is a local-developer
// problem, and scripts/lint-awesome.sh is where it is explained.
//
// Revisit only if markdown-lint.yml ever gives actions/checkout a `ref:`
// that leaves a named local branch checked out. Nothing here does today.

'use strict';

const fs = require('fs');
const path = require('path');

const API_ROOT = 'https://api.github.com';

// How the run finds its own comment again. Invisible once GitHub renders it.
const COMMENT_MARKER = '<!-- pr-guidance-comment -->';

const MONEY_MARKER = '\u{1F4B0}'; // 💰
const ARCHIVED_MARKER = '\u{1F5C4}'; // 🗄 — entries add U+FE0F after it

// awesome-lint, via remark's reporter:
//   "  ✖   58:56  List item link and description must be separated with a dash  remark-lint:awesome-list-item"
const LINT_RE = /^\s*[✖✗x]\s+(\d+):(\d+)\s+(.+?)\s{2,}(remark-lint:[\w-]+)\s*$/;

// check-readme.js prints "Found N issue(s) in README.md:" then "  - <issue>".
const README_ISSUE_RE = /^\s*-\s+(README\.md[:\s].*)$/;

// Same shape check-staleness.js uses: the marker segment is whatever sits
// between the closing paren and the dash.
const ENTRY_RE = /^\s*\*\s+\[([^\]]+)\]\(([^)]+)\)([^-]*)-\s*(.*)$/;

// ...but only markers and whitespace may sit there. Without this, an entry
// that really is missing its dash — "* [Foo](url) 💰 Some multi-word thing" —
// matches ENTRY_RE on the hyphen inside "multi-word" and gets mistranslated
// into advice about casing.
const MARKERS_ONLY_RE = new RegExp(`^[\\s${MONEY_MARKER}${ARCHIVED_MARKER}\\uFE0F]*$`, 'u');

// awesome-lint wants a capital letter, not merely "not lowercase": a
// description opening with a digit, with ".NET", or with a curly quote is
// rejected the same way. Verified against awesome-lint 2.3.0.
const VALID_OPENER_RE = /^\p{Lu}/u;

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Anything lifted out of the artifact goes through here before it reaches a
// comment body: backticks would break out of the code span, and a 500-column
// entry would bury the advice under it.
function quotable(text, limit = 160) {
  const flat = String(text).replace(ANSI_RE, '').replace(/[`\r\n]/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// --- Read what the failing run left behind ----------------------------

function classify(dir) {
  const log = readIfPresent(path.join(dir, 'validate.log')).replace(ANSI_RE, '');
  const readmeLines = readIfPresent(path.join(dir, 'README.md')).split('\n');

  const findings = {
    markerCasing: [],
    repeatedName: [],
    duplicates: [],
    ordering: [],
    toc: [],
  };

  for (const raw of log.split('\n')) {
    const lint = raw.match(LINT_RE);
    if (lint) {
      const [, lineNo, , message] = lint;
      const source = readmeLines[Number(lineNo) - 1] || '';

      if (message === 'List item link and description must be separated with a dash') {
        // The dash error is also the honest error for an entry that really
        // is missing its dash, and that message needs no translation. Only
        // the marker-plus-bad-opener case is misleading, so confirm both
        // halves against the source line before claiming it.
        const entry = source.match(ENTRY_RE);
        const markers = entry ? entry[3] : '';
        const description = entry ? entry[4] : '';
        const marked =
          MARKERS_ONLY_RE.test(markers) &&
          (markers.includes(MONEY_MARKER) || markers.includes(ARCHIVED_MARKER));
        if (entry && marked && description && !VALID_OPENER_RE.test(description)) {
          findings.markerCasing.push({ lineNo, source: quotable(source) });
        }
        continue;
      }

      const repeat = message.match(/^List item description should not start with the item name "(.+)"$/);
      if (repeat) {
        findings.repeatedName.push({ lineNo, name: quotable(repeat[1], 60) });
      }
      continue;
    }

    const issue = raw.match(README_ISSUE_RE);
    if (!issue) continue;
    const text = quotable(issue[1], 300);

    if (/duplicate URL/.test(text)) findings.duplicates.push(text);
    else if (/out of alphabetical order/.test(text)) findings.ordering.push(text);
    else if (/ToC/.test(text)) findings.toc.push(text);
  }

  return findings;
}

// --- Build the comment ------------------------------------------------

// A pull request that mangles the whole list could produce hundreds of
// findings, and a comment past GitHub's 65536-character body limit is not
// posted at all. Ten of a kind is enough to show the pattern.
const MAX_PER_SECTION = 10;

function listed(items, render) {
  const lines = items.slice(0, MAX_PER_SECTION).map(render);
  if (items.length > MAX_PER_SECTION) {
    lines.push(`- …and ${items.length - MAX_PER_SECTION} more of the same.`);
  }
  return lines;
}

function buildBody(findings, runUrl) {
  const out = [];

  if (findings.markerCasing.length > 0) {
    out.push('#### "List item link and description must be separated with a dash"');
    out.push('');
    out.push(
      'The dash is not the problem. On an entry carrying a 💰 or 🗄️ marker, ' +
        '`awesome-lint` reports a description that does not begin with a ' +
        'capital letter as a dash error. A lowercase word does it, and so do ' +
        'a digit, a quotation mark, and `.NET`. Reword so the description ' +
        'opens with a capital:'
    );
    out.push('');
    out.push(
      ...listed(findings.markerCasing, (f) => `- \`README.md:${f.lineNo}\` — \`${f.source}\``)
    );
    out.push('');
  }

  if (findings.repeatedName.length > 0) {
    out.push('#### "List item description should not start with the item name"');
    out.push('');
    out.push(
      'The description must not open with the entry\'s own name — the link ' +
        'already says it. Reword it to lead with what the project does:'
    );
    out.push('');
    out.push(
      ...listed(
        findings.repeatedName,
        (f) => `- \`README.md:${f.lineNo}\` — starts with "${f.name}".`
      )
    );
    out.push('');
  }

  if (findings.ordering.length > 0) {
    out.push('#### Alphabetical order');
    out.push('');
    out.push(...listed(findings.ordering, (text) => `> ${text}`));
    out.push('');
    out.push(
      'Entries are ordered within their own group of siblings, and ordering ' +
        'ignores leading punctuation — `.NET` files under N. Move the line ' +
        'where the message says.'
    );
    out.push('');
  }

  if (findings.duplicates.length > 0) {
    out.push('#### Duplicate URL');
    out.push('');
    out.push(...listed(findings.duplicates, (text) => `> ${text}`));
    out.push('');
    out.push(
      'Comparison ignores `www.`, a trailing slash, and case, so two entries ' +
        'can read differently and still collide. Drop one, or say in the ' +
        'pull request why both belong.'
    );
    out.push('');
  }

  if (findings.toc.length > 0) {
    out.push('#### Table of Contents');
    out.push('');
    out.push(...listed(findings.toc, (text) => `> ${text}`));
    out.push('');
    out.push(
      'The `## Contents` list has to match the real `##`/`###` headings, ' +
        'anchors included. Anchors are the heading lowercased with ' +
        'non-alphanumerics dropped and spaces turned into hyphens.'
    );
    out.push('');
  }

  if (out.length === 0) return null;

  return [
    COMMENT_MARKER,
    '### Validate Markdown failed, and at least one of these errors points at the wrong thing',
    '',
    ...out,
    '---',
    '',
    `Everything else in the [run log](${runUrl}) says what it means. ` +
      'Run `npm ci && npm run validate` locally to reproduce. ' +
      'See `contributing.md` → "Two rules awesome-lint enforces quietly".',
    '',
    '_Rewritten in place on each push by `.github/workflows/pr-guidance.yml`._',
  ].join('\n');
}

// --- Post it ----------------------------------------------------------

function apiHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'awesome-embedded-security-pr-guidance',
    Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`,
  };
}

async function findExistingComment(owner, repo, prNumber) {
  const response = await fetch(
    `${API_ROOT}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers: apiHeaders() }
  );
  if (!response.ok) return null;
  const comments = await response.json();
  if (!Array.isArray(comments)) return null;
  return comments.find((c) => (c.body || '').includes(COMMENT_MARKER)) || null;
}

async function upsert(owner, repo, prNumber, body, { createIfMissing }) {
  const existing = await findExistingComment(owner, repo, prNumber);

  if (!existing && !createIfMissing) return;

  const url = existing
    ? `${API_ROOT}/repos/${owner}/${repo}/issues/comments/${existing.id}`
    : `${API_ROOT}/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  const response = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    console.error(`Could not write the guidance comment: ${response.status}`);
    return;
  }
  console.log(existing ? `Updated comment ${existing.id}.` : 'Posted a guidance comment.');
}

async function main() {
  const dir = process.env.PR_GUIDANCE_DIR || 'pr-guidance';
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const prNumber = readIfPresent(path.join(dir, 'pr-number.txt')).trim();
  const runUrl = process.env.RUN_URL || '';

  // --dry-run prints what it would say and posts nothing. The only way to
  // check a change to the wording or the matching without opening a pull
  // request that fails on purpose.
  if (process.argv.includes('--dry-run')) {
    const preview = buildBody(classify(dir), runUrl);
    console.log(preview || '(nothing recognised; this run would stay quiet)');
    return;
  }

  if (!owner || !repo || !/^\d+$/.test(prNumber) || !process.env.GITHUB_TOKEN) {
    console.log('No pull request context to comment on; nothing to do.');
    return;
  }

  // Green again: retire the comment rather than leaving stale advice under a
  // passing run. Never created in this direction — a pull request that never
  // failed should never hear from this at all.
  if (process.env.RUN_CONCLUSION === 'success') {
    await upsert(
      owner,
      repo,
      prNumber,
      `${COMMENT_MARKER}\nValidate Markdown passes now. Earlier guidance on this pull request no longer applies.`,
      { createIfMissing: false }
    );
    return;
  }

  const findings = classify(dir);
  const body = buildBody(findings, runUrl);

  if (!body) {
    console.log('Nothing recognised in the failure; staying quiet.');
    return;
  }

  await upsert(owner, repo, prNumber, body, { createIfMissing: true });
}

main().catch((error) => {
  // Advisory, and it runs on a pull request that is already red. A crash
  // here must not add a second red mark that looks like a second problem.
  console.error(`pr-guidance failed: ${error.message}`);
});
