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
// Three of those findings have exactly one correct edit, and --fix applies
// them to README.md in memory; --open-pr commits the result and opens a
// pull request. See the "Apply the deterministic fixes" section for what is
// in scope and, more importantly, what is not.
//
// The flags compose into a single run — CI passes all three — because the
// sweep is the expensive part: one request per entry, preflighted against
// the quota up front. Running the check once to report and again to fix
// would double that budget and rewrite the issue twice.
//
// Exits 0 even when it finds problems: this reports, it does not gate. The
// link check in markdown-lint.yml is what fails a build.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
  return parseEntries(fs.readFileSync(README_PATH, 'utf8'));
}

// Split out from readEntries so the fix mode and its tests can work on a
// string. The tests must never be able to reach the real README.md: a test
// that rewrites the list is a test that can corrupt it.
function parseEntries(text) {
  const lines = text.split('\n');

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

  // Same reasoning as the status codes above, one step later: a 200 whose
  // body will not parse, or parses to something that is not a repository
  // object, tells us nothing about the repository. Degrade to unchecked.
  // Reading `data.archived` off a non-object would throw out of the worker
  // pool and take the whole sweep with it.
  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ...entry, status: 'error', detail: `unreadable response body: ${err.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...entry, status: 'error', detail: 'the GitHub API returned no repository object' };
  }

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

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ok: false, reason: `the rate limit response could not be read: ${err.message}` };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: 'the rate limit response was not an object.' };
  }

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

// `applied` is the result of a fix run that actually landed — the edits that
// are now sitting in a pull request. Findings covered by one are dropped
// from the report and pointed at the pull request instead, so the issue only
// ever holds what still needs a human to decide. Called without it (a dry
// run, or a fix run that failed), nothing is filtered and the report is the
// same one it has always been.
function render(findings, checked, applied) {
  const out = [];
  const edits = (applied && applied.edits) || [];
  const handled = new Set(edits.map((e) => `${e.kind}:${e.lineNo}`));
  const notApplied = new Map(
    ((applied && applied.skipped) || []).map((s) => [`${s.kind}:${s.lineNo}`, s.reason])
  );
  const remaining = (kind) =>
    findings[kind].filter((f) => !handled.has(`${kind}:${f.lineNo}`));

  const renamed = remaining('renamed');
  const needsMarker = remaining('needsMarker');
  const staleMarker = remaining('staleMarker');

  const actionable =
    findings.missing.length + renamed.length + needsMarker.length + staleMarker.length;

  out.push(`Checked ${checked} GitHub-hosted entries in README.md.`);
  out.push('');

  if (edits.length > 0) {
    out.push(
      `${edits.length} finding(s) had exactly one correct edit and were ` +
        `applied in ${applied.prUrl || 'a pull request'}. They are not ` +
        'listed below; review the pull request instead.'
    );
    out.push('');
  }

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

  if (renamed.length > 0) {
    out.push('## Moved');
    out.push('');
    out.push(
      'The link still works through a GitHub redirect, so the link check ' +
        'stays green, but the URL names a project that has been renamed or ' +
        'transferred. Worth updating before the redirect stops.'
    );
    out.push('');
    for (const f of renamed) {
      const suffix = f.deepPath ? ' (link points inside the repository)' : '';
      const reason = notApplied.get(`renamed:${f.lineNo}`);
      out.push(
        `- **${f.name}** — \`${f.owner}/${f.repo}\` is now ` +
          `\`${f.fullName}\`${suffix} (README.md:${f.lineNo})` +
          (reason ? ` — not fixed automatically: ${reason}` : '')
      );
    }
    out.push('');
  }

  if (needsMarker.length > 0) {
    out.push('## Archived, and missing the 🗄️ marker');
    out.push('');
    out.push(
      'Archived is not a reason to remove an entry on its own — but ' +
        '`contributing.md` asks that these carry 🗄️, and that a maintained ' +
        'successor be named at the end of the description if one exists.'
    );
    out.push('');
    for (const f of needsMarker) {
      const reason = notApplied.get(`needsMarker:${f.lineNo}`);
      out.push(
        `- **${f.name}** — \`${f.url}\` (README.md:${f.lineNo})` +
          (reason ? ` — not fixed automatically: ${reason}` : '')
      );
    }
    out.push('');
  }

  if (staleMarker.length > 0) {
    out.push('## Marked 🗄️ but no longer archived');
    out.push('');
    out.push('These have been unarchived upstream. The marker should come off.');
    out.push('');
    for (const f of staleMarker) {
      const reason = notApplied.get(`staleMarker:${f.lineNo}`);
      out.push(
        `- **${f.name}** — \`${f.url}\` (README.md:${f.lineNo})` +
          (reason ? ` — not fixed automatically: ${reason}` : '')
      );
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

// --- Apply the deterministic fixes ------------------------------------
// Guards against a report nobody transcribes. Three of the findings have
// exactly one correct edit — add the marker, remove the marker, repoint the
// URL — and asking a human to retype them by hand is how a report sits open
// for months while the list rots. Those three are applied here.
//
// `missing` and `quiet` are deliberately absent, and must stay absent.
// Deleting an entry is never automated: a 404 can be a repository briefly
// made private, and quiet is explicitly not the same as unmaintained. The
// entry's display label is left alone for the same reason — renaming
// "GDBFuzz" because the repository moved is a judgement call.
//
// Edits are line-addressed and surgical. The file is never reserialized:
// only the lines the findings name are rebuilt, from the pieces of the line
// that was already there, so the output differs from the input in exactly
// those places and nowhere else.

// The byte sequence the existing entries use, which is not the same as
// ARCHIVED_MARKER: the entries follow U+1F5C4 with the U+FE0F variation
// selector, and an inserted marker that omits it renders as a different
// glyph beside its neighbours.
const ARCHIVED_MARKER_FULL = `${ARCHIVED_MARKER}\uFE0F`;

// Splits an entry line into "* [Name](", the URL, ")", the marker segment,
// and the dash onwards, so one piece can be rewritten and the rest passed
// through untouched.
const ENTRY_PARTS_RE = /^(\s*\*\s+\[[^\]]+\]\()([^)]+)(\))([^-]*)(-.*)$/;

// Mirrors normalizeUrl in scripts/check-readme.js. Not imported: that script
// runs its checks at require time and calls process.exit, so loading it here
// would end this process. The duplicate is deliberate and small; the real
// check still runs over the result in verifyReadme below.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathName = u.pathname.replace(/\/+$/, '');
    return `${host}${pathName}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

// One space on each side of the markers, which is what every entry in the
// list already looks like — and with no markers left, exactly one space
// between the closing paren and the dash.
function markerSegment(tokens) {
  return tokens.length === 0 ? ' ' : ` ${tokens.join(' ')} `;
}

// The canonical URL for a renamed repository, keeping anything the link
// pointed at inside it: "…/old-owner/old-repo/tree/main/docs" has to come
// out as "…/new-owner/new-repo/tree/main/docs", not as the repository root.
function renamedUrl(entry) {
  if (!entry.htmlUrl) return null;

  let linked;
  let canonical;
  try {
    linked = new URL(entry.url);
    canonical = new URL(entry.htmlUrl);
  } catch {
    return null;
  }

  const suffix = linked.pathname.split('/').filter(Boolean).slice(2);
  const base = canonical.pathname.split('/').filter(Boolean);
  const pathName = `/${[...base, ...suffix].join('/')}`;
  const trailing = linked.pathname.endsWith('/') && pathName !== '/' ? '/' : '';

  return `${canonical.origin}${pathName}${trailing}${linked.search}${linked.hash}`;
}

// Returns the rewritten content, the edits that were made, and the edits
// that were refused with the reason why — the caller reports those as still
// needing a human rather than silently dropping them.
function applyFixes(content, findings) {
  const lines = content.split('\n');
  const edits = [];
  const skipped = [];

  // Every URL already in the list, so a rename onto a target that is listed
  // somewhere else is caught before it is written rather than by
  // check-readme.js afterwards, when the whole run would have to be thrown
  // away over one entry.
  const urlLines = new Map();
  lines.forEach((line, idx) => {
    const parts = line.match(ENTRY_PARTS_RE);
    if (parts && !urlLines.has(normalizeUrl(parts[2].trim()))) {
      urlLines.set(normalizeUrl(parts[2].trim()), idx + 1);
    }
  });

  // Markers first, renames last: a rename rewrites the URL that the marker
  // edits match the line on, and an entry can be both archived and moved.
  const planned = [
    ...findings.needsMarker.map((finding) => ({ kind: 'needsMarker', finding })),
    ...findings.staleMarker.map((finding) => ({ kind: 'staleMarker', finding })),
    ...findings.renamed.map((finding) => ({ kind: 'renamed', finding })),
  ];

  for (const { kind, finding } of planned) {
    // The overriding rule of this script: an entry the API could not answer
    // for is never edited. classify() already keeps errors out of these
    // buckets — this is the second lock on the same door, because the cost
    // of getting it wrong is an automated commit that breaks a live entry.
    if (finding.status !== 'ok') continue;

    const idx = finding.lineNo - 1;
    const parts = idx >= 0 && idx < lines.length ? lines[idx].match(ENTRY_PARTS_RE) : null;

    // The line numbers came from the same read as the findings, so a
    // mismatch means the file changed underneath the run. Refuse rather
    // than rewrite a line nobody looked at.
    if (!parts || parts[2].trim() !== finding.url) {
      skipped.push({
        kind,
        name: finding.name,
        lineNo: finding.lineNo,
        reason: 'the line no longer holds the entry this finding was raised on',
      });
      continue;
    }

    const before = lines[idx];
    let after = null;
    let note = null;

    if (kind === 'needsMarker') {
      const tokens = parts[4].trim().split(/\s+/).filter(Boolean);
      if (tokens.some((t) => t.includes(ARCHIVED_MARKER))) continue;
      // Appended, so it lands after a 💰 when one is already there, which is
      // the order contributing.md documents.
      tokens.push(ARCHIVED_MARKER_FULL);
      after = parts[1] + parts[2] + parts[3] + markerSegment(tokens) + parts[5];
      note = 'archived upstream — added the 🗄️ marker';
    } else if (kind === 'staleMarker') {
      const tokens = parts[4]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => !t.includes(ARCHIVED_MARKER));
      after = parts[1] + parts[2] + parts[3] + markerSegment(tokens) + parts[5];
      note = 'no longer archived upstream — removed the 🗄️ marker';
    } else {
      const target = renamedUrl(finding);
      if (!target) {
        skipped.push({
          kind,
          name: finding.name,
          lineNo: finding.lineNo,
          reason: 'the API did not return a usable canonical URL',
        });
        continue;
      }

      const key = normalizeUrl(target);
      const clash = urlLines.get(key);
      if (clash !== undefined && clash !== finding.lineNo) {
        skipped.push({
          kind,
          name: finding.name,
          lineNo: finding.lineNo,
          reason:
            `\`${target}\` is already listed at README.md:${clash}, so ` +
            'repointing this entry would duplicate it — one of the two ' +
            'entries has to go, and which one is a judgement call',
        });
        continue;
      }

      urlLines.delete(normalizeUrl(parts[2].trim()));
      urlLines.set(key, finding.lineNo);
      after = parts[1] + target + parts[3] + parts[4] + parts[5];
      note = `moved to \`${finding.fullName}\` — updated the link`;
    }

    if (after === before) continue;

    lines[idx] = after;
    edits.push({ kind, name: finding.name, lineNo: finding.lineNo, before, after, note });
  }

  return { content: lines.join('\n'), edits, skipped };
}

// Runs the real scripts/check-readme.js over the rewritten content before
// anything is committed. The fix logic knows about duplicate URLs, but the
// check also enforces alphabetical order and Table of Contents sync, and an
// automated commit that fails the check that gates every pull request would
// block the whole repository. The copy into a temporary directory is what
// lets the check run against content that is not on disk yet, without this
// script needing to know anything about how the check works.
function verifyReadme(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-health-'));
  try {
    const script = path.join(dir, 'scripts', 'check-readme.js');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(__dirname, 'check-readme.js'), script);
    fs.writeFileSync(path.join(dir, 'README.md'), content);

    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    return {
      ok: run.status === 0,
      output: `${run.stdout || ''}${run.stderr || ''}`.trim(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- File the report as an issue --------------------------------------
// One issue, rewritten in place. A new issue every month would bury the
// repository in near-identical reports, and the interesting question is
// always "what is wrong now", not "what was wrong in March". The marker
// below is how the run finds its own issue again; it is invisible when
// GitHub renders the body.

const ISSUE_MARKER = '<!-- entry-health-report -->';
const ISSUE_TITLE = 'Entry health report';

// Three outcomes, and they have to stay distinguishable: the report issue
// was found, the lookup succeeded and there is no report issue, or the
// lookup could not be done at all. A 5xx, a revoked token or a rate limit
// is the third, and collapsing it into the second sends the caller down the
// creation path — which opens a *second* report issue beside the one this
// whole design assumes is unique. Same rule as everywhere else in this
// script: an API error is never evidence about the thing being checked.
async function findExistingIssue(owner, repo) {
  let response;
  try {
    response = await fetch(
      `${API_ROOT}/repos/${owner}/${repo}/issues?state=open&per_page=100`,
      { headers: apiHeaders() }
    );
  } catch (err) {
    return { ok: false, reason: `cannot reach the GitHub API: ${err.message}` };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `the GitHub API returned HTTP ${response.status} when looking for it`,
    };
  }

  let issues;
  try {
    issues = await response.json();
  } catch (err) {
    return { ok: false, reason: `could not read the issue list: ${err.message}` };
  }

  // A 200 carrying an object rather than a list is how GitHub answers some
  // secondary rate limits and abuse-detection trips: `{"message": …}`, with
  // a 2xx status. It parses, so the catch above never fires, and calling
  // .find on it throws a TypeError out of here and kills the run — after
  // the fix step may already have force-pushed a branch and opened a pull
  // request. It is the same "I could not find out" as any other failure
  // and has to be answered the same way.
  if (!Array.isArray(issues)) {
    return {
      ok: false,
      reason:
        'the GitHub API returned a 200 that was not a list of issues ' +
        `(${JSON.stringify(issues).slice(0, 120)})`,
    };
  }

  return {
    ok: true,
    issue:
      issues.find(
        (issue) => issue && !issue.pull_request && (issue.body || '').includes(ISSUE_MARKER)
      ) || null,
  };
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

  const lookup = await findExistingIssue(owner, repo);

  // Not knowing whether the report is already open is not the same as
  // knowing it is not. Decline to post: a duplicate report issue is worse
  // than a month with no report, because from then on neither issue is the
  // one that gets rewritten. The non-zero exit code is deliberate — a run
  // that could not report should be visible, unlike a run that could not
  // open a pull request.
  if (!lookup.ok) {
    console.error(
      `Cannot tell whether a report issue is already open: ${lookup.reason}. ` +
        'Nothing filed, rather than risk opening a duplicate.'
    );
    process.exitCode = 1;
    return;
  }

  const existing = lookup.issue;

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
  // The issue exists by now; a body we cannot read changes nothing except
  // how precisely this line can be worded. Crashing here would report a
  // failure for a call that succeeded.
  let created = null;
  try {
    created = await response.json();
  } catch {
    created = null;
  }
  const number = created && typeof created === 'object' ? created.number : null;
  console.log(
    number
      ? `Opened issue #${number} with ${actionable} finding(s).`
      : `Opened the report issue with ${actionable} finding(s).`
  );
}

// --- Open the pull request --------------------------------------------
// Guards against the monthly rerun stacking a pull request on top of last
// month's: one branch name, reused, force-updated, and the open pull request
// on it edited in place. The alternative — a fresh branch each run — leaves
// a queue of near-identical pull requests that each need closing by hand,
// which is exactly the manual work this is supposed to remove.
//
// Driven through the `gh` CLI rather than a third-party action. Every action
// in this repository is pinned by SHA, and taking on a new dependency to
// save a dozen lines of shelling out is a bigger decision than this
// warrants; `gh` is already on every GitHub-hosted runner.

const PR_BRANCH = 'entry-health/automated-fixes';
const PR_MARKER = '<!-- entry-health-fixes -->';
const PR_TITLE = 'Entry health: apply the deterministic fixes';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || (result.error && result.error.message) || '').trim(),
  };
}

function prBody(edits, skipped, issueUrl) {
  const out = [
    PR_MARKER,
    `Opened by \`scripts/check-staleness.js --fix\`. Branch \`${PR_BRANCH}\` ` +
      'is reused and force-updated each month, so this pull request is ' +
      'rewritten in place rather than replaced — and closed, rather than ' +
      'left open proposing a stale edit, by the first run that finds ' +
      'nothing left to fix.',
    '',
    'Only the three findings with exactly one correct edit are applied here: ' +
      'a missing 🗄️ marker, a 🗄️ marker left behind after an unarchive, and ' +
      'a link to a repository that has since moved. A repository that has ' +
      'gone (404) or fallen quiet is never touched — deleting an entry is a ' +
      'judgement call. Entry labels are left alone for the same reason.',
    '',
    `The result was checked with \`node scripts/check-readme.js\` before this ` +
      'branch was pushed.',
    '',
    '## What changed',
    '',
  ];

  for (const e of edits) {
    out.push(`- \`README.md:${e.lineNo}\` **${e.name}** — ${e.note}.`);
  }

  if (skipped.length > 0) {
    out.push('');
    out.push('## Left for a human');
    out.push('');
    for (const s of skipped) {
      out.push(`- \`README.md:${s.lineNo}\` **${s.name}** — ${s.reason}.`);
    }
  }

  if (issueUrl) {
    out.push('');
    out.push(`Findings that still need a decision stay in ${issueUrl}.`);
  }

  return out.join('\n');
}

// What is open on the generated branch, if anything, and whether it is ours.
// Three outcomes again, for the same reason findExistingIssue has three: a
// lookup that failed is not a branch with no pull request on it. Treating it
// as one opens a second pull request proposing the same edit as the first.
//
// The marker is what makes a pull request ours. Only this script pushes the
// branch, but a human can open a pull request from anything, and rewriting
// or closing someone else's work is not a call an advisory job gets to make.
function findGeneratedPullRequest(exec, env) {
  const found = exec(
    'gh',
    ['pr', 'list', '--head', PR_BRANCH, '--state', 'open', '--json', 'url,baseRefName,body'],
    { env }
  );

  if (!found.ok) {
    return { ok: false, reason: `gh pr list failed: ${found.stderr || found.stdout}` };
  }

  let list;
  try {
    list = JSON.parse(found.stdout || '[]');
  } catch (err) {
    return { ok: false, reason: `could not read the gh pr list output: ${err.message}` };
  }
  // Parseable but not a list — the same trap as the issue lookup, and the
  // same answer: not knowing is never reported as "there is none".
  if (!Array.isArray(list)) {
    return { ok: false, reason: 'gh pr list returned something that was not a list' };
  }

  const mine = list.find((pr) => pr && (pr.body || '').includes(PR_MARKER));
  return { ok: true, pr: mine || null, foreign: list.length > 0 && !mine };
}

// Writes the file, pushes the branch, and opens or updates the pull request.
// Returns { ok, url } and never throws: the caller has a report to file that
// a failure here must not take down with it.
//
// `deps` is a test seam. Every branch below either shells out or writes to
// README.md, so without it none of this could be covered offline — and an
// untested `gh` argument list is how a pull request ends up pointing at the
// wrong base for a month.
function openPullRequest(content, edits, skipped, issueUrl, deps = {}) {
  const exec = deps.run || run;
  const write = deps.write || ((text) => fs.writeFileSync(README_PATH, text));

  if (!token()) {
    return { ok: false, reason: 'no GITHUB_TOKEN; cannot push a branch or open a pull request' };
  }

  const base = process.env.GITHUB_REF_NAME || exec('git', ['branch', '--show-current']).stdout;
  if (!base) {
    return { ok: false, reason: 'cannot determine the base branch' };
  }

  const env = { ...process.env, GH_TOKEN: token() };

  // Looked up before anything is written or pushed, so a lookup this run
  // cannot do costs nothing: it stops here having touched neither the
  // working tree nor the remote, and next month tries again.
  const existing = findGeneratedPullRequest(exec, env);
  if (!existing.ok) {
    return { ok: false, reason: existing.reason };
  }
  if (existing.foreign) {
    return {
      ok: false,
      reason:
        `a pull request is open on \`${PR_BRANCH}\` that this script did not ` +
        'write. Leaving it alone rather than force-pushing over it',
    };
  }

  write(content);

  // Only ever this one path. The runner's checkout is clean, but a local
  // run is not, and a fix run must not sweep up whatever else is in the
  // working tree.
  const steps = [
    ['git', ['config', 'user.name', 'github-actions[bot]']],
    ['git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']],
    ['git', ['checkout', '-B', PR_BRANCH]],
    ['git', ['add', '--', 'README.md']],
    ['git', ['commit', '-m', `${PR_TITLE}\n\n${edits.length} entry-health fix(es) applied automatically.`, '--', 'README.md']],
    // Force: the branch is generated, holds nothing but this commit, and is
    // rebuilt from the base branch on every run.
    ['git', ['push', '--force', 'origin', PR_BRANCH]],
  ];

  for (const [command, args] of steps) {
    const result = exec(command, args);
    if (!result.ok) {
      return { ok: false, reason: `${command} ${args[0]} failed: ${result.stderr || result.stdout}` };
    }
  }

  const bodyFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'entry-health-pr-')),
    'body.md'
  );
  fs.writeFileSync(bodyFile, prBody(edits, skipped, issueUrl));

  if (existing.pr) {
    // --base on every update, not only when it differs. The head branch is
    // rebuilt from whatever base this run checked out, so the pull request's
    // base has to follow it: a workflow_dispatch from a topic branch opens
    // the pull request against that branch, and the next scheduled run
    // force-pushes the same branch built from the default branch. Without
    // this, the pull request keeps comparing against a base its head was
    // never built from, and shows a diff nobody should act on. Retargeting
    // is right rather than refusing to reuse, because the alternative
    // leaves the stale pull request open — which is the problem, not the
    // fix.
    const edited = exec(
      'gh',
      ['pr', 'edit', existing.pr.url, '--base', base, '--title', PR_TITLE, '--body-file', bodyFile],
      { env }
    );
    if (!edited.ok) {
      return { ok: false, reason: `gh pr edit failed: ${edited.stderr}` };
    }
    return {
      ok: true,
      url: existing.pr.url,
      updated: true,
      retargetedFrom: existing.pr.baseRefName !== base ? existing.pr.baseRefName : null,
    };
  }

  const created = exec(
    'gh',
    ['pr', 'create', '--base', base, '--head', PR_BRANCH, '--title', PR_TITLE, '--body-file', bodyFile],
    { env }
  );

  return created.ok
    ? { ok: true, url: created.stdout.split('\n').pop(), updated: false }
    : { ok: false, reason: `gh pr create failed: ${created.stderr}` };
}

// Closes the generated pull request when a sweep finds nothing left to fix.
//
// The promise is one pull request, rewritten each month. A month where the
// findings were resolved by hand on the base branch breaks it: the sweep
// finds nothing, returns early, and last month's pull request stays open
// proposing an edit that may now be wrong against contents nobody will
// force-push again. An automation that leaves stale proposals lying around
// is one people learn to ignore, which costs more than it ever saved.
function retireStalePullRequest(deps = {}) {
  const exec = deps.run || run;

  if (!token()) {
    return { ok: false, reason: 'no GITHUB_TOKEN; cannot look for an open pull request' };
  }

  const env = { ...process.env, GH_TOKEN: token() };
  const existing = findGeneratedPullRequest(exec, env);
  if (!existing.ok) {
    return { ok: false, reason: existing.reason };
  }
  if (!existing.pr) {
    return { ok: true, closed: null };
  }

  // --delete-branch as well: the branch exists only to carry this pull
  // request, its contents are stale by definition here, and the next sweep
  // that finds something recreates it from the base branch.
  const closed = exec(
    'gh',
    [
      'pr', 'close', existing.pr.url,
      '--comment',
      'Closing: this run found nothing left to fix, so every edit this pull ' +
        'request proposed has either landed or is no longer the right one. ' +
        'The next monthly sweep opens a fresh pull request if the list decays ' +
        'again — see the entry health report issue for anything still waiting ' +
        'on a human.',
      '--delete-branch',
    ],
    { env }
  );

  return closed.ok
    ? { ok: true, closed: existing.pr.url }
    : { ok: false, reason: `gh pr close failed: ${closed.stderr}` };
}

// The report issue, so the pull request can point back at what is left. A
// failure to find it is not a failure to fix anything, so it degrades to no
// link rather than aborting.
async function reportIssueUrl() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo || !token()) return null;
  try {
    const lookup = await findExistingIssue(owner, repo);
    return lookup.ok && lookup.issue ? lookup.issue.html_url : null;
  } catch {
    return null;
  }
}

// --- Main -------------------------------------------------------------

// Returns what render() needs to drop the handled findings, or null if
// nothing landed — a dry run, nothing to fix, a rewrite that failed the
// README check, or a pull request that could not be opened. Null means the
// report keeps every finding, which is the safe direction to fail in: a
// finding reported twice costs someone a minute, a finding silently dropped
// because a pull request was assumed to exist costs the list an entry.
//
// Nothing in here sets process.exitCode. A pull request that could not be
// opened is logged and left for next month; the findings are all still in
// the report, which is where they were before any of this existed. Only a
// failure to file that report is worth a red run.
async function runFixMode(findings, openPr, deps = {}) {
  const original = fs.readFileSync(README_PATH, 'utf8');
  const { content, edits, skipped } = applyFixes(original, findings);

  for (const s of skipped) {
    console.log(`Not fixing ${s.name} (README.md:${s.lineNo}): ${s.reason}`);
  }

  if (edits.length === 0) {
    console.log('No finding had an edit that could be applied automatically.');

    // Nothing to propose is exactly when a pull request left over from a
    // month when there was something becomes misleading, so this is where
    // it gets closed rather than where the run quietly ends.
    if (openPr) {
      const retired = retireStalePullRequest(deps);
      if (!retired.ok) {
        console.error(`Could not retire the open pull request: ${retired.reason}`);
      } else if (retired.closed) {
        console.log(`Closed ${retired.closed}: nothing left for it to propose.`);
      }
    }
    return null;
  }

  for (const e of edits) {
    console.log(`README.md:${e.lineNo} — ${e.note}`);
    console.log(`  - ${e.before}`);
    console.log(`  + ${e.after}`);
  }

  const check = verifyReadme(content);
  if (!check.ok) {
    console.error(
      'The rewritten README.md does not pass scripts/check-readme.js, so ' +
        'nothing was written:'
    );
    console.error(check.output);
    return null;
  }

  if (!openPr) {
    console.log(
      `\n${edits.length} edit(s) would be applied. --fix does not write; ` +
        'add --open-pr to commit them and open a pull request.'
    );
    return null;
  }

  const issueUrl = await reportIssueUrl();
  const pr = openPullRequest(content, edits, skipped, issueUrl, deps);
  if (!pr.ok) {
    console.error(`Could not open the pull request: ${pr.reason}`);
    return null;
  }

  console.log(`\n${pr.updated ? 'Updated' : 'Opened'} ${pr.url} with ${edits.length} edit(s).`);
  if (pr.retargetedFrom) {
    console.log(`Retargeted it from ${pr.retargetedFrom}, which its head is no longer built from.`);
  }
  return { edits, skipped, prUrl: pr.url };
}

// One sweep, three steps, in this order — the order is the safety property.
// The fix is attempted first so the report can point at the pull request it
// opened, and the report is filed last from whatever the fix actually
// achieved. If the fix crashed, refused, or could not push, `applied` is
// null, render() produces precisely the report it would have produced had
// the fix never run, and that report is still filed. That is what lets CI
// run this as a single step without ignoring its exit status: the fix path
// cannot throw out of here, and cannot take the report down with it.
//
// `deps` exists for the test that pins exactly that: it is the only way to
// drive a failing pull request offline.
async function checkAndReport(findings, checked, argv, deps = {}) {
  const fix = deps.runFixMode || runFixMode;
  const file = deps.reportIssue || reportIssue;

  const openPr = argv.includes('--open-pr');
  let applied = null;

  if (openPr || argv.includes('--fix')) {
    console.log('');
    try {
      applied = await fix(findings, openPr, deps);
    } catch (err) {
      // A throw from the fix path is a bug in it, not a reason to lose the
      // report that the rest of this run has already earned.
      console.error(`Fix mode failed: ${err.message}`);
    }
    console.log('');
  }

  const { body, actionable } = render(findings, checked, applied);

  console.log(body);

  if (argv.includes('--report-issue')) {
    console.log('');
    await file(body, actionable);
  }

  return { body, actionable, applied };
}

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

  // The one sweep. Every path below works from these results; a second
  // invocation to fix what this one found would double an already
  // preflighted 150-request budget for nothing.
  const results = await lookupAll(entries);
  const findings = classify(results);

  await checkAndReport(findings, entries.length, process.argv);
}

// Exported for scripts/check-staleness.test.js. The live API path cannot be
// exercised offline, so the parsing, classification and rendering that
// decide what a maintainer is told are tested against synthetic responses
// instead.
module.exports = {
  readEntries,
  parseEntries,
  classify,
  render,
  lookup,
  preflight,
  reportIssue,
  applyFixes,
  verifyReadme,
  checkAndReport,
  runFixMode,
  openPullRequest,
  retireStalePullRequest,
  PR_MARKER,
  prBody,
  ARCHIVED_MARKER_FULL,
  PR_BRANCH,
  QUIET_MONTHS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
