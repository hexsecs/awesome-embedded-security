#!/usr/bin/env node
// Checks the GitHub-hosted entries in README.md for decay that the link
// checker cannot see. A link check only catches URLs that stop resolving;
// it says nothing about a repository that has been archived, renamed, or
// abandoned while its URL still returns 200. Those are the failures nobody
// opens a PR about, because from the outside the list still looks correct.
//
// Run locally with `npm run check:staleness`. In CI it runs monthly and,
// with --report-issue, files its findings as a single GitHub issue that it
// rewrites in place on each run rather than opening a new one every month.
//
// Exits 0 even when it finds problems: this reports, it does not gate. The
// link check in markdown-lint.yml is what fails a build.

'use strict';

const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, '..', 'README.md');

// A repository with no pushes in this long is reported, but only as
// context. contributing.md is explicit that quiet is not the same as
// unmaintained — paper artifacts and teaching targets are expected to be
// frozen, and several entries were deliberately listed while dormant
// because they remain the best option in their niche. So these are printed
// under their own heading, phrased as "no action implied", and are never
// mixed in with the findings that do need a decision.
const QUIET_MONTHS = 24;

// Matches "* [Name](url) 🗄️ - Description", capturing the marker segment
// between the closing paren and the dash so an entry that already carries
// 🗄️ is not reported as newly archived.
const ENTRY_RE = /^\s*\*\s+\[([^\]]+)\]\(([^)]+)\)([^-]*)-\s*(.*)$/;

const ARCHIVED_MARKER = '\u{1F5C4}'; // 🗄 — the entries add U+FE0F after it

const API_ROOT = 'https://api.github.com';
const CONCURRENCY = 8;

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

function apiHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'awesome-embedded-security-staleness-check',
  };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  return headers;
}

// --- Read the entries -------------------------------------------------
// The Table of Contents is skipped for the same reason check-readme.js
// skips it: its items are markdown links too, and they point at anchors
// rather than projects.

function readEntries() {
  const lines = fs.readFileSync(README_PATH, 'utf8').split('\n');

  const tocStart = lines.findIndex((l) => l.trim() === '## Contents');
  const tocEnd =
    tocStart === -1
      ? -1
      : lines.findIndex((l, i) => i > tocStart && /^##\s+/.test(l));
  const tocLast = tocEnd === -1 ? lines.length : tocEnd;

  const entries = [];

  lines.forEach((line, idx) => {
    if (tocStart !== -1 && idx > tocStart && idx < tocLast) return;

    const match = line.match(ENTRY_RE);
    if (!match) return;

    const [, name, rawUrl, markers] = match;
    const url = rawUrl.trim();

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.hostname.toLowerCase().replace(/^www\./, '') !== 'github.com') {
      return;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return; // a user or org page, not a repository

    entries.push({
      name: name.trim(),
      url,
      owner: segments[0],
      repo: segments[1],
      // "…/rt-thread/security" points into a repository rather than at it.
      // The repository metadata still applies, but a rename cannot be fixed
      // by swapping the first two path segments, so that suggestion is
      // suppressed for these.
      deepPath: segments.length > 2,
      hasArchivedMarker: markers.includes(ARCHIVED_MARKER),
      lineNo: idx + 1,
    });
  });

  return entries;
}

// --- Ask GitHub about each repository ---------------------------------

async function lookup(entry) {
  let response;
  try {
    response = await fetch(`${API_ROOT}/repos/${entry.owner}/${entry.repo}`, {
      headers: apiHeaders(),
    });
  } catch (err) {
    return { ...entry, status: 'error', detail: err.message };
  }

  if (response.status === 404) {
    return { ...entry, status: 'missing' };
  }

  // 401, 403 and 429 mean unauthenticated, rate limited, or blocked — never
  // that the repository is gone. Reporting those as findings would send
  // someone deleting live entries, so they are surfaced as check failures
  // instead. The preflight below should catch these before any repository is
  // looked up, but a limit can be reached part way through a run.
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    return {
      ...entry,
      status: 'error',
      detail:
        response.status === 401
          ? 'GitHub API rejected the credentials'
          : remaining === '0'
            ? 'GitHub API rate limit exhausted'
            : `HTTP ${response.status} from the GitHub API`,
    };
  }

  if (!response.ok) {
    return { ...entry, status: 'error', detail: `HTTP ${response.status}` };
  }

  const data = await response.json();
  return {
    ...entry,
    status: 'ok',
    archived: Boolean(data.archived),
    fullName: data.full_name,
    pushedAt: data.pushed_at,
    htmlUrl: data.html_url,
  };
}

// Ask about the rate limit before asking about 144 repositories. A bad
// token or an exhausted quota otherwise produces a wall of identical
// failures that reads like the whole list has broken, which is both
// alarming and useless.
async function preflight(needed) {
  let response;
  try {
    response = await fetch(`${API_ROOT}/rate_limit`, { headers: apiHeaders() });
  } catch (err) {
    return { ok: false, reason: `cannot reach the GitHub API: ${err.message}` };
  }

  if (response.status === 401) {
    return {
      ok: false,
      reason:
        'the GitHub API rejected the credentials. Set GITHUB_TOKEN to a ' +
        'token with public repository read access.',
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `the GitHub API returned HTTP ${response.status}.` };
  }

  const data = await response.json();
  const core = data.resources && data.resources.core;
  if (core && core.remaining < needed) {
    const resetAt = new Date(core.reset * 1000).toISOString();
    return {
      ok: false,
      reason:
        `only ${core.remaining} API requests remain and this run needs ` +
        `${needed}. The quota resets at ${resetAt}.`,
    };
  }

  return { ok: true };
}

async function lookupAll(entries) {
  const results = [];
  let next = 0;

  async function worker() {
    while (next < entries.length) {
      const index = next++;
      results[index] = await lookup(entries[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker)
  );

  return results;
}

// --- Sort the results into what needs doing ---------------------------

function classify(results) {
  const findings = {
    missing: [],
    renamed: [],
    needsMarker: [],
    staleMarker: [],
    quiet: [],
    errors: [],
  };

  const quietBefore = new Date();
  quietBefore.setMonth(quietBefore.getMonth() - QUIET_MONTHS);

  for (const result of results) {
    if (result.status === 'error') {
      findings.errors.push(result);
      continue;
    }

    if (result.status === 'missing') {
      findings.missing.push(result);
      continue;
    }

    // The API follows renames, so a full_name that disagrees with the URL
    // means the project moved and the link is surviving on a redirect.
    const linked = `${result.owner}/${result.repo}`;
    if (result.fullName && result.fullName.toLowerCase() !== linked.toLowerCase()) {
      findings.renamed.push(result);
    }

    if (result.archived && !result.hasArchivedMarker) {
      findings.needsMarker.push(result);
    } else if (!result.archived && result.hasArchivedMarker) {
      findings.staleMarker.push(result);
    }

    if (result.pushedAt && new Date(result.pushedAt) < quietBefore) {
      findings.quiet.push(result);
    }
  }

  return findings;
}

function monthsSince(iso) {
  const then = new Date(iso);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24 * 30.44));
}

// --- Render -----------------------------------------------------------

function render(findings, checked) {
  const out = [];
  const actionable =
    findings.missing.length +
    findings.renamed.length +
    findings.needsMarker.length +
    findings.staleMarker.length;

  out.push(`Checked ${checked} GitHub-hosted entries in README.md.`);
  out.push('');

  if (findings.missing.length > 0) {
    out.push('## Gone (404)');
    out.push('');
    out.push(
      'The repository no longer resolves. Remove the entry, or repoint it ' +
        'if a successor exists. This also fails the link check, so it blocks ' +
        'every open pull request until it is fixed.'
    );
    out.push('');
    for (const f of findings.missing) {
      out.push(`- **${f.name}** — \`${f.url}\` (README.md:${f.lineNo})`);
    }
    out.push('');
  }

  if (findings.renamed.length > 0) {
    out.push('## Moved');
    out.push('');
    out.push(
      'The link still works through a GitHub redirect, so the link check ' +
        'stays green, but the URL names a project that has been renamed or ' +
        'transferred. Worth updating before the redirect stops.'
    );
    out.push('');
    for (const f of findings.renamed) {
      const suffix = f.deepPath ? ' (link points inside the repository)' : '';
      out.push(
        `- **${f.name}** — \`${f.owner}/${f.repo}\` is now ` +
          `\`${f.fullName}\`${suffix} (README.md:${f.lineNo})`
      );
    }
    out.push('');
  }

  if (findings.needsMarker.length > 0) {
    out.push('## Archived, and missing the 🗄️ marker');
    out.push('');
    out.push(
      'Archived is not a reason to remove an entry on its own — but ' +
        '`contributing.md` asks that these carry 🗄️, and that a maintained ' +
        'successor be named at the end of the description if one exists.'
    );
    out.push('');
    for (const f of findings.needsMarker) {
      out.push(`- **${f.name}** — \`${f.url}\` (README.md:${f.lineNo})`);
    }
    out.push('');
  }

  if (findings.staleMarker.length > 0) {
    out.push('## Marked 🗄️ but no longer archived');
    out.push('');
    out.push('These have been unarchived upstream. The marker should come off.');
    out.push('');
    for (const f of findings.staleMarker) {
      out.push(`- **${f.name}** — \`${f.url}\` (README.md:${f.lineNo})`);
    }
    out.push('');
  }

  if (findings.errors.length > 0) {
    out.push('## Could not be checked');
    out.push('');
    out.push(
      'Rate limiting or a network failure, not evidence of a problem with ' +
        'the entry. These were not classified either way.'
    );
    out.push('');
    for (const f of findings.errors) {
      out.push(`- **${f.name}** — \`${f.url}\`: ${f.detail}`);
    }
    out.push('');
  }

  if (findings.quiet.length > 0) {
    out.push(`## Quiet for ${QUIET_MONTHS}+ months`);
    out.push('');
    out.push(
      '**No action implied.** Listed for awareness only. A dormant ' +
        'repository is often still the best tool in its niche, and paper ' +
        'artifacts and vulnerable-by-design teaching targets are expected ' +
        'to be frozen. Several entries here were added knowing they were ' +
        'quiet.'
    );
    out.push('');
    const sorted = [...findings.quiet].sort(
      (a, b) => new Date(a.pushedAt) - new Date(b.pushedAt)
    );
    for (const f of sorted) {
      out.push(
        `- **${f.name}** — last push ${f.pushedAt.slice(0, 10)} ` +
          `(${monthsSince(f.pushedAt)} months ago)`
      );
    }
    out.push('');
  }

  if (actionable === 0 && findings.errors.length === 0) {
    out.push('## Nothing needs doing');
    out.push('');
    out.push(
      'No entry is missing, moved, or wrongly marked. Anything listed ' +
        'above under "Quiet" is informational.'
    );
    out.push('');
  }

  return { body: out.join('\n').trimEnd(), actionable };
}

// --- File the report as an issue --------------------------------------
// One issue, rewritten in place. A new issue every month would bury the
// repository in near-identical reports, and the interesting question is
// always "what is wrong now", not "what was wrong in March". The marker
// below is how the run finds its own issue again; it is invisible when
// GitHub renders the body.

const ISSUE_MARKER = '<!-- entry-health-report -->';
const ISSUE_TITLE = 'Entry health report';

async function findExistingIssue(owner, repo) {
  const response = await fetch(
    `${API_ROOT}/repos/${owner}/${repo}/issues?state=open&per_page=100`,
    { headers: apiHeaders() }
  );
  if (!response.ok) return null;

  const issues = await response.json();
  return (
    issues.find(
      (issue) => !issue.pull_request && (issue.body || '').includes(ISSUE_MARKER)
    ) || null
  );
}

async function reportIssue(body, actionable) {
  const slug = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    console.error('GITHUB_REPOSITORY is not set; cannot file an issue.');
    process.exitCode = 1;
    return;
  }
  if (!token()) {
    console.error('No GITHUB_TOKEN; cannot file an issue.');
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const fullBody = [
    ISSUE_MARKER,
    `_Last checked ${stamp}. This issue is rewritten in place by ` +
      '`scripts/check-staleness.js`; edits to the body will be overwritten._',
    '',
    body,
  ].join('\n');

  const existing = await findExistingIssue(owner, repo);

  // Nothing to do and no open report: stay quiet rather than opening an
  // issue that says everything is fine.
  if (!existing && actionable === 0) {
    console.log('No findings and no open report issue; nothing filed.');
    return;
  }

  if (existing) {
    const response = await fetch(
      `${API_ROOT}/repos/${owner}/${repo}/issues/${existing.number}`,
      {
        method: 'PATCH',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: fullBody,
          // Close it once the list is clean again, so an open report always
          // means there is something to decide.
          state: actionable === 0 ? 'closed' : 'open',
        }),
      }
    );
    if (!response.ok) {
      console.error(`Failed to update issue #${existing.number}: ${response.status}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      actionable === 0
        ? `Closed issue #${existing.number}; nothing left to act on.`
        : `Updated issue #${existing.number} with ${actionable} finding(s).`
    );
    return;
  }

  const response = await fetch(`${API_ROOT}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: ISSUE_TITLE, body: fullBody }),
  });
  if (!response.ok) {
    console.error(`Failed to create issue: ${response.status}`);
    process.exitCode = 1;
    return;
  }
  const created = await response.json();
  console.log(`Opened issue #${created.number} with ${actionable} finding(s).`);
}

// --- Main -------------------------------------------------------------

async function main() {
  const entries = readEntries();
  if (entries.length === 0) {
    console.error('No GitHub-hosted entries found in README.md.');
    process.exitCode = 1;
    return;
  }

  if (!token()) {
    console.error(
      'Warning: no GITHUB_TOKEN set. Unauthenticated GitHub API requests are ' +
        `limited to 60 per hour and this run needs ${entries.length}.`
    );
  }

  const ready = await preflight(entries.length);
  if (!ready.ok) {
    console.error(`Cannot run the check: ${ready.reason}`);
    process.exitCode = 1;
    return;
  }

  const results = await lookupAll(entries);
  const findings = classify(results);
  const { body, actionable } = render(findings, entries.length);

  console.log(body);

  if (process.argv.includes('--report-issue')) {
    console.log('');
    await reportIssue(body, actionable);
  }
}

// Exported for scripts/check-staleness.test.js. The live API path cannot be
// exercised offline, so the parsing, classification and rendering that
// decide what a maintainer is told are tested against synthetic responses
// instead.
module.exports = {
  readEntries,
  classify,
  render,
  lookup,
  preflight,
  reportIssue,
  QUIET_MONTHS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
