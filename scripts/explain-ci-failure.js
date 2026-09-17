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
// --- Threat model -----------------------------------------------------
//
// Stated plainly, because an earlier version of this comment asserted a
// safety property that was not true.
//
// This script runs privileged. .github/workflows/pr-guidance.yml triggers it
// on workflow_run, which hands it the base repository's token with
// pull-requests: write. That is the whole reason for the workflow_run
// detour: a pull_request-triggered workflow gets a read-only token on a fork
// pull request and cannot comment at all, and fork pull requests are exactly
// the first-time contributors this exists for.
//
// Everything in the downloaded artifact is attacker-controlled. Not "could
// conceivably be tampered with" — the producer job runs `npm ci` and
// `npm run validate` against the pull request's merge ref, so the fork's
// package.json defines what `validate` even is. A fork can write whatever it
// likes into validate.log, README.md and pr-number.txt before the upload.
//
// Three consequences, each load-bearing:
//
//   - The pull request to comment on is derived from the triggering run's
//     head SHA through the API, never from the artifact. Trusting
//     pr-number.txt for targeting let any fork make this repository's own
//     token post or overwrite a comment on any pull request in the repo.
//     pr-number.txt survives only as a cross-check that must agree with the
//     derived number; a mismatch aborts rather than falling back.
//   - Nothing from the artifact is executed, and every fragment of it that
//     reaches the comment body goes through codeSpan() — so it renders
//     literally and cannot author markdown, links or HTML under the bot's
//     identity. Before that was enforced, a fork could have made the bot
//     post "**Approved by a maintainer**" above a link of its choosing.
//   - The checkout is pinned to the base repository's default branch, so no
//     fork-authored file is ever on disk next to this script.
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
//
// Three behavioural rules:
//   - it never changes whether the pull request passes (it exits 0 always,
//     from a workflow that is not a required check);
//   - it says nothing at all when the failure is not one it recognises, so
//     that a comment from it always means something;
//   - it rewrites its own comment in place rather than stacking a new one on
//     every push, the same way scripts/check-staleness.js handles its issue.

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

// Mirrors awesome-lint's own escape hatch, which is `/ - [A-Z]/` — ASCII
// capitals only (awesome-lint 2.3.0, rules/list-item.js). That matters: this
// was \p{Lu}, which accepts É and Å, so an entry reading
// "* [Foo](url) 💰 - Émulateur ..." got the misleading dash error from
// awesome-lint while this stayed silent about it — silent on exactly the
// case it exists for. Matching the rule character-for-character is the only
// way to stay in step with it.
const VALID_OPENER_RE = /^[A-Z]/;

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const SHA_RE = /^[0-9a-f]{40}$/;

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// The only way fork-controlled text is allowed into the comment body.
//
// Wrapping in a code span is what makes it inert: inside one, GitHub renders
// markdown and HTML literally, so "**Approved by a maintainer**" stays four
// asterisks and a link stays text. Backticks are stripped first, because a
// backtick is the one character that could close the span early and let the
// rest render; control characters and newlines go too, so a single finding
// cannot spill into lines it does not own. The truncation is not a security
// property, just a courtesy — a 500-column entry would bury the advice.
function codeSpan(text, limit = 160) {
  const flat = String(text)
    .replace(ANSI_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/`/g, '')
    .trim();
  const clipped = flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
  return clipped ? `\`${clipped}\`` : '`(empty)`';
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
          findings.markerCasing.push({ lineNo: Number(lineNo), source });
        }
        continue;
      }

      const repeat = message.match(
        /^List item description should not start with the item name "(.+)"$/
      );
      if (repeat) {
        findings.repeatedName.push({ lineNo: Number(lineNo), name: repeat[1] });
      }
      continue;
    }

    const issue = raw.match(README_ISSUE_RE);
    if (!issue) continue;
    const text = issue[1];

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

// Belt and braces on the same limit, since every fragment below starts out
// fork-sized until codeSpan clips it.
const MAX_BODY = 60000;

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
      ...listed(
        findings.markerCasing,
        (f) => `- \`README.md:${Number(f.lineNo)}\` — ${codeSpan(f.source)}`
      )
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
        (f) => `- \`README.md:${Number(f.lineNo)}\` — starts with ${codeSpan(f.name, 60)}.`
      )
    );
    out.push('');
  }

  if (findings.ordering.length > 0) {
    out.push('#### Alphabetical order');
    out.push('');
    out.push(...listed(findings.ordering, (text) => `- ${codeSpan(text, 300)}`));
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
    out.push(...listed(findings.duplicates, (text) => `- ${codeSpan(text, 300)}`));
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
    out.push(...listed(findings.toc, (text) => `- ${codeSpan(text, 300)}`));
    out.push('');
    out.push(
      'The `## Contents` list has to match the real `##`/`###` headings, ' +
        'anchors included. Anchors are the heading lowercased with ' +
        'non-alphanumerics dropped and spaces turned into hyphens.'
    );
    out.push('');
  }

  if (out.length === 0) return null;

  const body = [
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
    '_Quoted fragments come from the failing run and are shown verbatim. ' +
      'Rewritten in place on each push by `.github/workflows/pr-guidance.yml`._',
  ].join('\n');

  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_Truncated._` : body;
}

// --- Choose the pull request to comment on ----------------------------
//
// The security-critical part. The target comes from the triggering run's
// head SHA — trusted workflow_run metadata a fork cannot influence — and
// from the API's answer about which pull request owns that commit. The
// artifact only gets to agree with it.

function selectPullRequest(pulls, { headSha, headRepo }) {
  if (!Array.isArray(pulls)) {
    return { error: 'the pull request lookup did not return a list' };
  }

  const matches = pulls.filter(
    (pr) =>
      pr &&
      pr.state === 'open' &&
      pr.head &&
      pr.head.sha === headSha &&
      pr.head.repo &&
      pr.head.repo.full_name === headRepo
  );

  if (matches.length === 0) {
    return { error: `no open pull request in ${headRepo} has head ${headSha}` };
  }
  // Two pull requests can share a head commit. Guessing between them is
  // exactly the class of mistake this function exists to prevent.
  if (matches.length > 1) {
    return {
      error: `${matches.length} open pull requests share head ${headSha}; refusing to guess`,
    };
  }

  return { number: matches[0].number };
}

function crossCheck(derived, claimed) {
  if (!/^\d+$/.test(String(claimed == null ? '' : claimed).trim())) {
    return { error: 'the artifact carried no usable pull request number to check against' };
  }
  if (Number(claimed) !== derived) {
    return {
      error:
        `the artifact claims pull request #${Number(claimed)}, but that head ` +
        `SHA belongs to #${derived}`,
    };
  }
  return { number: derived };
}

// `crossCheck` is skipped only for a retire-only run, where there is no
// artifact to cross-check against. That is safe for the reason the artifact
// needed checking in the first place: the target still comes entirely from
// trusted workflow_run metadata, and a retire-only run can do nothing but
// rewrite a comment this bot already authored, to a fixed string, with
// createIfMissing false. There is no input a fork could use to redirect it.
async function resolveTarget({ owner, repo, headSha, headRepo, claimed, requireCrossCheck = true }) {
  if (!SHA_RE.test(String(headSha || ''))) {
    return { error: `head SHA "${headSha}" is not a commit id` };
  }
  if (!headRepo) {
    return { error: 'the triggering run named no head repository' };
  }

  const response = await fetch(`${API_ROOT}/repos/${owner}/${repo}/commits/${headSha}/pulls`, {
    headers: apiHeaders(),
  });
  if (!response.ok) {
    return { error: `pull request lookup failed: ${response.status}` };
  }

  const selected = selectPullRequest(await response.json(), { headSha, headRepo });
  if (selected.error) return selected;
  if (!requireCrossCheck) return { number: selected.number };

  return crossCheck(selected.number, claimed);
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

// Paged, because a single page is a promise this cannot keep. The header
// says it rewrites one comment rather than stacking a new one per push; on a
// thread longer than one page an unpaginated search would never find the
// marker, and every push would post again — the exact behaviour it promises
// not to have, appearing only on the long threads where it is most annoying.
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 10;

async function findExistingComment(owner, repo, prNumber) {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const response = await fetch(
      `${API_ROOT}/repos/${owner}/${repo}/issues/${prNumber}/comments` +
        `?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
      { headers: apiHeaders() }
    );
    if (!response.ok) return null;

    const comments = await response.json();
    if (!Array.isArray(comments)) return null;

    const found = comments.find((c) => (c.body || '').includes(COMMENT_MARKER));
    if (found) return found;

    // A short page is the last page.
    if (comments.length < COMMENT_PAGE_SIZE) return null;
  }

  // Past the cap, assume it is not there rather than paging forever. Worst
  // case is a second comment on a thread of a thousand, which is a better
  // failure than an unbounded loop holding a write token.
  console.error(
    `Stopped searching for an existing comment after ${MAX_COMMENT_PAGES} pages.`
  );
  return null;
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

// What replaces the guidance once it no longer applies. Deliberately says
// which of the three cases happened, so nobody reads "it passes now" on a
// pull request that is still red.
function retirementBody(retireOnly, runUrl) {
  const link = runUrl ? ` See the [run log](${runUrl}).` : '';
  if (process.env.RUN_CONCLUSION === 'success') {
    return (
      `${COMMENT_MARKER}\nValidate Markdown passes now. The guidance that ` +
      'was here no longer applies.'
    );
  }
  if (retireOnly) {
    return (
      `${COMMENT_MARKER}\nValidate Markdown is still failing, but the details ` +
      `of the last run could not be read, so any earlier guidance here may be ` +
      `out of date.${link}`
    );
  }
  return (
    `${COMMENT_MARKER}\nThe errors described here are gone. Validate Markdown ` +
    `is still failing, but not for a reason this bot can explain — the link ` +
    `check and markdownlint say what they mean.${link}`
  );
}

async function main() {
  const dir = process.env.PR_GUIDANCE_DIR || 'pr-guidance';
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  const runUrl = process.env.RUN_URL || '';

  // --dry-run prints what it would say and posts nothing. The only way to
  // check a change to the wording or the matching without opening a pull
  // request that fails on purpose.
  if (process.argv.includes('--dry-run')) {
    const preview = buildBody(classify(dir), runUrl);
    console.log(preview || '(nothing recognised; this run would stay quiet)');
    return;
  }

  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    console.log('No repository context to comment in; nothing to do.');
    return;
  }

  // --retire-only is for the case where the artifact could not be
  // downloaded. There is then nothing to classify, but a comment from an
  // earlier push may still be sitting there describing errors nobody can
  // confirm are still real, so the one safe action is to retire it.
  const retireOnly = process.argv.includes('--retire-only');

  const target = await resolveTarget({
    owner,
    repo,
    headSha: process.env.HEAD_SHA,
    headRepo: process.env.HEAD_REPO,
    claimed: readIfPresent(path.join(dir, 'pr-number.txt')).trim(),
    requireCrossCheck: !retireOnly,
  });

  if (target.error) {
    // Loud, and then nothing. Never a fallback: a path that could not
    // establish which pull request this is, is a path that must not write.
    console.error(`Refusing to comment — ${target.error}.`);
    return;
  }

  const body = retireOnly || process.env.RUN_CONCLUSION === 'success'
    ? null
    : buildBody(classify(dir), runUrl);

  // Nothing to say, in any of three ways: the run is green, the artifact
  // never arrived, or it failed for a reason this does not recognise. All
  // three have the same consequence for a comment left by an earlier push —
  // it is now describing errors that may well be fixed. The commonest path
  // in this repository is the third one: a contributor fixes the casing
  // error, pushes, markdown-quality goes green, and the link check fails on
  // one of the flaky hosts it retries three times for. Leaving the old
  // comment up would have it pointing at a line that no longer has anything
  // wrong with it, which is exactly the "a comment always means something"
  // promise this is built on.
  //
  // Retirement never creates: a pull request that never heard from this bot
  // should not start hearing from it now.
  if (!body) {
    await upsert(owner, repo, target.number, retirementBody(retireOnly, runUrl), {
      createIfMissing: false,
    });
    return;
  }

  await upsert(owner, repo, target.number, body, { createIfMissing: true });
}

// Exported for scripts/explain-ci-failure.test.js. The live API path cannot
// be exercised offline, so what is tested is the targeting decision and the
// escaping — the two places where getting it wrong writes to the wrong pull
// request, or writes something a fork chose.
module.exports = {
  classify,
  buildBody,
  retirementBody,
  findExistingComment,
  codeSpan,
  selectPullRequest,
  crossCheck,
  MAX_PER_SECTION,
};

if (require.main === module) {
  main().catch((error) => {
    // Advisory, and it runs on a pull request that is already red. A crash
    // here must not add a second red mark that looks like a second problem.
    console.error(`pr-guidance failed: ${error.message}`);
  });
}
