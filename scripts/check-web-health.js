#!/usr/bin/env node
// Checks the entries that check-staleness.js cannot see. That script asks
// GitHub about the 152 entries hosted there; the rest of the list — vendor
// product pages, standards bodies, GitLab projects, documentation portals,
// personal sites — has no health signal at all beyond "the URL returned
// 200". That is how a discontinued product stays on the list forever: the
// marketing page still resolves, so the link check stays green, and the
// entry quietly becomes a lie.
//
// Two signals, neither of which needs a vendor to cooperate:
//
//   GitLab-hosted entries get the same facts the GitHub checker gets —
//   archived, renamed, last activity — from the GitLab API.
//
//   Everything else gets a change-detection snapshot: where the URL
//   finally lands after redirects, and a hash of the response body with
//   the volatile parts normalized out. Successive runs diff against
//   scripts/web-health-snapshot.json. A product page that collapses to a
//   generic homepage, or to a "this product is discontinued" notice, is
//   exactly the decay this is for.
//
// Run locally with `npm run check:web-health`. In CI it runs monthly and,
// with --report-issue, files its findings as a single GitHub issue that it
// rewrites in place rather than opening a new one every month.
//
// Exits 0 even when it finds problems: this reports, it does not gate. The
// link check in markdown-lint.yml is what fails a build, and it remains the
// authority on whether a URL is dead — a non-2xx response here is recorded
// as unchecked, never as a finding.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, '..', 'README.md');
const SNAPSHOT_PATH = path.join(__dirname, 'web-health-snapshot.json');
const LINKS_CONFIG_PATH = path.join(
  __dirname,
  '..',
  '.github',
  'workflows',
  'markdown.links.config.json'
);

// A page whose content has not moved in this long is mentioned, but only as
// context. contributing.md is explicit that quiet is not the same as
// unmaintained — paper artifacts, frozen specifications and
// vulnerable-by-design teaching targets are supposed to sit still, and a
// standards PDF that has not been touched in three years is doing its job.
// So these are printed under their own heading, phrased as "no action
// implied", and are never mixed in with the findings that need a decision.
const QUIET_MONTHS = 24;

// A content change is only worth mentioning if the page had settled first.
// Sites that churn every month say nothing by churning again; a page that
// held still for a year and then changed is worth reading, usually because
// the project renamed itself, changed licence, or shipped a successor. Even
// then it is phrased as "recheck the description", not as an error.
const STABLE_MONTHS = 12;

// Matches "* [Name](url) 🗄️ - Description", capturing the marker segment
// between the closing paren and the dash so an entry that already carries
// 🗄️ is not reported as newly archived. Same shape as check-staleness.js.
const ENTRY_RE = /^\s*\*\s+\[([^\]]+)\]\(([^)]+)\)([^-]*)-\s*(.*)$/;

const ARCHIVED_MARKER = '\u{1F5C4}'; // 🗄 — the entries add U+FE0F after it

const GITHUB_API_ROOT = 'https://api.github.com';
const GITLAB_API_ROOT = 'https://gitlab.com/api/v4';

// Matches check-staleness.js. Eight parallel requests is polite against the
// GitLab API and, because the web entries are spread across ~90 different
// hosts, amounts to roughly one request per host at a time.
const CONCURRENCY = 8;

// Long enough for a slow standards-body PDF portal, short enough that one
// hung host cannot stall the run. A timeout is an unchecked entry, not a
// finding.
const REQUEST_TIMEOUT_MS = 20000;

// Named, with a contact path. A host that wants to block this should be
// able to identify it rather than guess.
const USER_AGENT =
  'awesome-embedded-security-web-health (+https://github.com/topics/awesome-list; monthly entry-health check)';

function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

// Public GitLab projects need no token at all. One is supported anyway
// because the unauthenticated quota is per-IP, and a busy CI runner shares
// that IP with everything else on it.
function gitlabHeaders() {
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (process.env.GITLAB_TOKEN) {
    headers['PRIVATE-TOKEN'] = process.env.GITLAB_TOKEN;
  }
  return headers;
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  };
  const t = githubToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  return headers;
}

// --- Hosts that are known to block automated clients ------------------
// markdown.links.config.json already lists these, because the link checker
// could not read them either. Re-deriving that list here would guarantee
// the two drift apart, and a host that blocks us is not a broken entry:
// reporting it as one is exactly the false "this is gone" that sends
// someone deleting a live entry.

function ignoreMatchers(configPath = LINKS_CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // Missing or malformed config is not fatal. Nothing gets skipped, and
    // the blocked hosts land in "could not be checked" — noisier, but not
    // wrong in a direction that costs anyone an entry.
    return [];
  }

  const patterns = Array.isArray(raw.ignorePatterns) ? raw.ignorePatterns : [];
  const matchers = [];
  for (const item of patterns) {
    if (!item || typeof item.pattern !== 'string') continue;
    try {
      matchers.push(new RegExp(item.pattern));
    } catch {
      // A pattern this script cannot compile is one the link checker owns.
    }
  }
  return matchers;
}

function isIgnored(url, matchers) {
  return matchers.some((re) => re.test(url));
}

// --- Read the entries -------------------------------------------------
// The Table of Contents is skipped for the same reason check-readme.js
// skips it: its items are markdown links too, and they point at anchors
// rather than projects.

function readEntries(readmePath = README_PATH, matchers = ignoreMatchers()) {
  const lines = fs.readFileSync(readmePath, 'utf8').split('\n');

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
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    const entry = {
      name: name.trim(),
      url,
      host,
      hasArchivedMarker: markers.includes(ARCHIVED_MARKER),
      lineNo: idx + 1,
    };

    // check-staleness.js owns these; checking them twice would double the
    // API spend and let the two scripts disagree in a report.
    if (host === 'github.com') {
      entry.kind = 'github';
    } else if (isIgnored(url, matchers)) {
      entry.kind = 'ignored';
    } else if (host === 'gitlab.com') {
      const project = gitlabProjectPath(parsed);
      if (project) {
        entry.kind = 'gitlab';
        entry.project = project;
      } else {
        // A gitlab.com URL that is not a project — a group page, a snippet.
        // Nothing for the projects API to say, so treat it as a web page.
        entry.kind = 'web';
      }
    } else {
      entry.kind = 'web';
    }

    entries.push(entry);
  });

  return entries;
}

// GitLab puts everything that is not the project itself behind a "/-/"
// segment (/group/project/-/issues), so the project path is whatever comes
// first. Subgroups mean the path can be arbitrarily deep, which is why this
// keeps every segment rather than taking the first two the way the GitHub
// checker can.
function gitlabProjectPath(parsed) {
  const head = parsed.pathname.split('/-/')[0];
  const segments = head.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, '');
  return segments.join('/');
}

// --- Ask GitLab about each project ------------------------------------

async function lookupGitLab(entry, fetchImpl = fetch) {
  const encoded = encodeURIComponent(entry.project);
  let response;
  try {
    response = await fetchImpl(`${GITLAB_API_ROOT}/projects/${encoded}`, {
      headers: gitlabHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ...entry, status: 'unchecked', detail: err.message };
  }

  if (response.status === 404) {
    // A 404 here is not proof the project is gone. GitLab also 404s a
    // private project, and this script's idea of where the project path
    // ends is a guess about URL shape. So before saying "gone" — the one
    // finding that gets a live entry deleted — confirm against the link
    // itself. If the page still loads, the API simply did not recognise
    // the path, and that is an unchecked entry.
    const stillThere = await resolves(entry.url, fetchImpl);
    if (stillThere) {
      return {
        ...entry,
        status: 'unchecked',
        detail:
          'the GitLab API does not recognise this project path, but the ' +
          'link itself still resolves',
      };
    }
    return { ...entry, status: 'missing' };
  }

  // 401, 403 and 429 mean unauthenticated, rate limited, or blocked — never
  // that the project is gone.
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    return {
      ...entry,
      status: 'unchecked',
      detail:
        response.status === 401
          ? 'the GitLab API rejected the credentials'
          : response.status === 429
            ? 'the GitLab API rate limit is exhausted'
            : `HTTP ${response.status} from the GitLab API`,
    };
  }

  if (!response.ok) {
    return { ...entry, status: 'unchecked', detail: `HTTP ${response.status}` };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { ...entry, status: 'unchecked', detail: `unreadable API response: ${err.message}` };
  }

  return {
    ...entry,
    status: 'ok',
    archived: Boolean(data.archived),
    fullName: data.path_with_namespace,
    pushedAt: data.last_activity_at,
  };
}

// Used only to talk a 404 out of becoming a "gone" finding. Any answer at
// all that is not a 404 counts as "still there"; the question is whether
// the link is dead, not whether the host is healthy.
async function resolves(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.status !== 404 && response.status !== 410;
  } catch {
    // Could not tell. Err toward "still there" so the entry stays.
    return true;
  }
}

// --- Snapshot the web entries -----------------------------------------

// HEAD first, because it is the cheap question and it answers most of what
// matters: where the URL lands, and whether the server offers a validator.
// GET is the fallback for the two cases HEAD cannot cover — a host that
// rejects HEAD outright, and a host that answers it with neither ETag nor
// Last-Modified, leaving nothing to compare next month unless the body is
// hashed.
async function probe(entry, fetchImpl = fetch) {
  const head = await request(entry.url, 'HEAD', fetchImpl);

  if (head.ok && head.etag) {
    return snapshotOf(entry, head, null);
  }
  if (head.ok && head.lastModified) {
    return snapshotOf(entry, head, null);
  }

  const get = await request(entry.url, 'GET', fetchImpl);
  if (!get.ok) {
    // Prefer whichever attempt got furthest, so the reason a maintainer
    // reads is the informative one.
    const failure = head.ok ? get : head;
    return { ...entry, status: 'unchecked', detail: failure.detail };
  }

  let body;
  try {
    body = await get.text();
  } catch (err) {
    return { ...entry, status: 'unchecked', detail: `unreadable body: ${err.message}` };
  }

  return snapshotOf(entry, get, hashBody(body));
}

async function request(url, method, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      ? `${method} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : `${method} failed: ${(err && err.message) || err}`;
    return { ok: false, detail: reason };
  }

  // Anything other than a 2xx is a question this script cannot answer. A
  // 404 belongs to the link check, a 403 is usually a bot wall, a 5xx is
  // the host having a bad morning. None of them are evidence about the
  // entry, so none of them become findings.
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, detail: `${method} returned HTTP ${response.status}` };
  }

  const headers = response.headers;
  return {
    ok: true,
    method,
    httpStatus: response.status,
    finalUrl: response.url || url,
    etag: (headers && headers.get('etag')) || null,
    lastModified: (headers && headers.get('last-modified')) || null,
    text: () => response.text(),
  };
}

function snapshotOf(entry, result, hash) {
  return {
    ...entry,
    status: 'ok',
    method: result.method,
    httpStatus: result.httpStatus,
    finalUrl: result.finalUrl,
    etag: result.etag,
    lastModified: result.lastModified,
    hash,
  };
}

// --- Normalizing a page down to the part that means something ---------
// Without this the whole signal is worthless: a CSRF nonce, a rendered
// "generated at" timestamp or a cache-busted asset URL changes on every
// request, so every page looks changed on every run and a maintainer
// learns to ignore the report. What survives normalization is roughly the
// prose and the structure — which is what an entry's description is about.

function normalizeBody(text) {
  if (typeof text !== 'string') return '';

  return (
    text
      // Script and style blocks carry inline state, build ids and analytics
      // payloads, and none of it is content.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Per-response tokens, in attribute and in JSON form.
      .replace(/\bnonce\s*=\s*(["'])[\s\S]*?\1/gi, ' ')
      .replace(
        /["']?[\w-]*(?:csrf|xsrf|session|sessid|authenticity|request)[\w-]*["']?\s*[:=]\s*(["'])[\s\S]*?\1/gi,
        ' '
      )
      // Timestamps, in the shapes pages actually render them.
      .replace(
        /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
        ' '
      )
      .replace(
        /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}(?:\s+\d{2}:\d{2}:\d{2}(?:\s+\w+)?)?/gi,
        ' '
      )
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|UTC|GMT)\b/gi, ' ')
      // Cache-busting query strings on assets and links.
      .replace(/[?&](?:v|ver|version|t|ts|cb|rev|_)=[A-Za-z0-9._%-]+/gi, ' ')
      // Epoch stamps and build hashes, including the ones baked into asset
      // filenames by every bundler in use.
      .replace(/\b\d{10,}\b/g, ' ')
      .replace(/\b[0-9a-f]{16,}\b/gi, ' ')
      .replace(/[.\-_][0-9a-f]{8,}(?=\.(?:js|css|mjs|png|jpe?g|svg|webp|woff2?)\b)/gi, ' ')
      // Whitespace differences are reformatting, not content.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function hashBody(text) {
  return crypto.createHash('sha256').update(normalizeBody(text)).digest('hex');
}

// --- The snapshot file ------------------------------------------------

const SNAPSHOT_NOTE =
  'Written by scripts/check-web-health.js. Hand edits are overwritten; ' +
  'delete an entry to reset its baseline.';

function loadSnapshot(snapshotPath = SNAPSHOT_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    // No snapshot, or an unreadable one. Treat this run as the baseline
    // rather than refusing to run: an empty prior state produces no
    // findings, which is the safe direction.
  }
  return { version: 1, entries: {} };
}

// Only successfully checked entries are updated. An unchecked entry keeps
// the record it already had — dropping it would silently reset its baseline
// and hide a change that happened while the host was down. Entries no
// longer in the README are pruned so the file cannot grow forever.
function updateSnapshot(snapshot, results, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  const next = {};

  for (const result of results) {
    const prior = snapshot.entries[result.url];

    if (result.status !== 'ok') {
      if (prior) next[result.url] = prior;
      continue;
    }

    const fingerprint = compare(prior, result);
    next[result.url] = {
      finalUrl: result.finalUrl,
      httpStatus: result.httpStatus,
      hash: result.hash || null,
      etag: result.etag || null,
      lastModified: result.lastModified || null,
      firstSeen: (prior && prior.firstSeen) || stamp,
      lastChanged:
        !prior || fingerprint === 'different' ? stamp : prior.lastChanged || stamp,
      lastChecked: stamp,
    };
  }

  const entries = {};
  for (const key of Object.keys(next).sort()) entries[key] = next[key];
  return { version: 1, note: SNAPSHOT_NOTE, entries };
}

function writeSnapshot(snapshot, snapshotPath = SNAPSHOT_PATH) {
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

// Compare whatever the two records have in common, strongest first. When
// they have nothing in common — a host that stopped sending ETag, say —
// the answer is "unknown", never "different". An unknown is not a finding.
function compare(prior, current) {
  if (!prior || !current) return 'unknown';
  if (prior.hash && current.hash) {
    return prior.hash === current.hash ? 'same' : 'different';
  }
  if (prior.etag && current.etag) {
    return prior.etag === current.etag ? 'same' : 'different';
  }
  if (prior.lastModified && current.lastModified) {
    return prior.lastModified === current.lastModified ? 'same' : 'different';
  }
  return 'unknown';
}

// Two URLs point at the same page if they agree on host and path. Scheme
// upgrades, www, trailing slashes and query strings all change without the
// destination changing — a tracking parameter appended by a CDN is not a
// product being discontinued.
function sameDestination(a, b) {
  if (!a || !b) return true;
  let left;
  let right;
  try {
    left = new URL(a);
    right = new URL(b);
  } catch {
    return a === b;
  }

  const host = (u) => u.hostname.toLowerCase().replace(/^www\./, '');
  const route = (u) => u.pathname.replace(/\/+$/, '') || '/';
  return host(left) === host(right) && route(left) === route(right);
}

// A deep product page that now lands on "/" is the signature case: the
// product was retired and the vendor redirected its URL to the homepage.
function collapsedToHomepage(from, to) {
  try {
    const before = new URL(from);
    const after = new URL(to);
    return (
      (before.pathname.replace(/\/+$/, '') || '/') !== '/' &&
      (after.pathname.replace(/\/+$/, '') || '/') === '/'
    );
  } catch {
    return false;
  }
}

// --- Run the checks ---------------------------------------------------

async function checkAll(entries, fetchImpl = fetch) {
  const results = [];
  let next = 0;

  async function worker() {
    while (next < entries.length) {
      const index = next++;
      const entry = entries[index];
      results[index] =
        entry.kind === 'gitlab'
          ? await lookupGitLab(entry, fetchImpl)
          : await probe(entry, fetchImpl);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker)
  );

  return results;
}

// --- Sort the results into what needs doing ---------------------------

function classify(results, snapshot = { entries: {} }, now = new Date()) {
  const findings = {
    missing: [],
    renamed: [],
    needsMarker: [],
    staleMarker: [],
    redirected: [],
    changed: [],
    quiet: [],
    baseline: [],
    unchecked: [],
  };

  const prior = (snapshot && snapshot.entries) || {};

  for (const result of results) {
    if (result.status === 'unchecked') {
      findings.unchecked.push(result);
      continue;
    }

    if (result.kind === 'gitlab') {
      classifyGitLab(result, findings, now);
      continue;
    }

    classifyWeb(result, prior[result.url], findings, now);
  }

  return findings;
}

function classifyGitLab(result, findings, now) {
  if (result.status === 'missing') {
    findings.missing.push(result);
    return;
  }

  // The API follows renames, so a path_with_namespace that disagrees with
  // the URL means the project moved and the link survives on a redirect.
  if (
    result.fullName &&
    result.fullName.toLowerCase() !== result.project.toLowerCase()
  ) {
    findings.renamed.push(result);
  }

  if (result.archived && !result.hasArchivedMarker) {
    findings.needsMarker.push(result);
  } else if (!result.archived && result.hasArchivedMarker) {
    findings.staleMarker.push(result);
  }

  if (result.pushedAt && monthsBetween(result.pushedAt, now) >= QUIET_MONTHS) {
    findings.quiet.push({ ...result, quietSince: result.pushedAt });
  }
}

function classifyWeb(result, prior, findings, now) {
  // Nothing recorded yet: this run is the baseline. A first run must
  // produce no findings at all, because there is nothing to have changed
  // from.
  if (!prior) {
    findings.baseline.push(result);
    return;
  }

  if (prior.finalUrl && !sameDestination(prior.finalUrl, result.finalUrl)) {
    findings.redirected.push({
      ...result,
      previousUrl: prior.finalUrl,
      collapsed: collapsedToHomepage(prior.finalUrl, result.finalUrl),
    });
  }

  const verdict = compare(prior, result);

  if (verdict === 'different') {
    const stableFor = monthsBetween(prior.lastChanged || prior.firstSeen, now);
    if (stableFor >= STABLE_MONTHS) {
      findings.changed.push({ ...result, stableFor, since: prior.lastChanged });
    }
    return;
  }

  if (verdict === 'same') {
    const settledFor = monthsBetween(prior.lastChanged || prior.firstSeen, now);
    if (settledFor >= QUIET_MONTHS) {
      findings.quiet.push({ ...result, quietSince: prior.lastChanged || prior.firstSeen });
    }
  }
}

function monthsBetween(iso, now = new Date()) {
  if (!iso) return 0;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 0;
  return Math.floor((now - then) / (1000 * 60 * 60 * 24 * 30.44));
}

// --- Render -----------------------------------------------------------

function render(findings, counts = {}) {
  const out = [];
  const actionable =
    findings.missing.length +
    findings.renamed.length +
    findings.needsMarker.length +
    findings.staleMarker.length +
    findings.redirected.length +
    findings.changed.length;

  const checked =
    (counts.gitlab || 0) + (counts.web || 0);
  out.push(
    `Checked ${checked} non-GitHub entries in README.md ` +
      `(${counts.gitlab || 0} on GitLab, ${counts.web || 0} by snapshot). ` +
      `${counts.github || 0} GitHub-hosted entries are covered by the entry ` +
      'health check instead' +
      (counts.ignored
        ? `, and ${counts.ignored} are on hosts that markdown.links.config.json ` +
          'already skips because they block automated clients.'
        : '.')
  );
  out.push('');

  if (findings.missing.length > 0) {
    out.push('## Gone (404)');
    out.push('');
    out.push(
      'The GitLab project no longer resolves, and neither does the link. ' +
        'Remove the entry, or repoint it if a successor exists.'
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
      'The link still works through a GitLab redirect, so the link check ' +
        'stays green, but the URL names a project that has been renamed or ' +
        'transferred. Worth updating before the redirect stops.'
    );
    out.push('');
    for (const f of findings.renamed) {
      out.push(
        `- **${f.name}** — \`${f.project}\` is now \`${f.fullName}\` ` +
          `(README.md:${f.lineNo})`
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

  if (findings.redirected.length > 0) {
    out.push('## Now redirects somewhere else');
    out.push('');
    out.push(
      'The URL used to land on one page and now lands on another. This is ' +
        'the decay a link check cannot see: a retired product whose page ' +
        'redirects to the vendor homepage, or to a notice saying it is ' +
        'discontinued, still answers 200. Open the link and decide whether ' +
        'the entry still describes what is there.'
    );
    out.push('');
    for (const f of findings.redirected) {
      const note = f.collapsed ? ' — now the site homepage' : '';
      out.push(
        `- **${f.name}** — \`${f.previousUrl}\` → \`${f.finalUrl}\`${note} ` +
          `(README.md:${f.lineNo})`
      );
    }
    out.push('');
  }

  if (findings.changed.length > 0) {
    out.push('## Changed after a long stretch of stability');
    out.push('');
    out.push(
      '**Not an error.** The page content changed after holding still for ' +
        `${STABLE_MONTHS}+ months, which usually means something worth ` +
        'reading: a rename, a licence change, a successor, or a project ' +
        'winding down. Recheck the description against the page; if it ' +
        'still reads true, nothing needs doing and this will not be ' +
        'reported again.'
    );
    out.push('');
    for (const f of findings.changed) {
      out.push(
        `- **${f.name}** — unchanged since ${String(f.since).slice(0, 10)} ` +
          `(${f.stableFor} months), now differs (README.md:${f.lineNo})`
      );
    }
    out.push('');
  }

  if (findings.unchecked.length > 0) {
    out.push('## Could not be checked');
    out.push('');
    out.push(
      'A timeout, a bot wall, or a host having a bad morning — not evidence ' +
        'of a problem with the entry. These were not classified either way, ' +
        'and their recorded snapshots were left untouched. Whether a URL is ' +
        'actually dead is the link check’s question, not this one’s.'
    );
    out.push('');
    for (const f of findings.unchecked) {
      out.push(`- **${f.name}** — \`${f.url}\`: ${f.detail}`);
    }
    out.push('');
  }

  if (findings.baseline.length > 0) {
    out.push('## Newly recorded');
    out.push('');
    out.push(
      '**No action implied.** Seen for the first time, so there is nothing ' +
        'to compare against yet. These become checkable from the next run.'
    );
    out.push('');
    for (const f of findings.baseline) {
      out.push(`- **${f.name}** — \`${f.url}\``);
    }
    out.push('');
  }

  if (findings.quiet.length > 0) {
    out.push(`## Unchanged for ${QUIET_MONTHS}+ months`);
    out.push('');
    out.push(
      '**No action implied.** Listed for awareness only. A page that sits ' +
        'still is usually a page that is finished: frozen specifications, ' +
        'paper artifacts and vulnerable-by-design teaching targets are ' +
        'supposed to stay exactly as they are, and several entries here ' +
        'were added knowing they were dormant, because they remain the best ' +
        'option in their niche. Quiet is not unmaintained.'
    );
    out.push('');
    const sorted = [...findings.quiet].sort(
      (a, b) => new Date(a.quietSince) - new Date(b.quietSince)
    );
    for (const f of sorted) {
      out.push(
        `- **${f.name}** — unchanged since ${String(f.quietSince).slice(0, 10)} ` +
          `(${monthsBetween(f.quietSince)} months)`
      );
    }
    out.push('');
  }

  if (actionable === 0 && findings.unchecked.length === 0) {
    out.push('## Nothing needs doing');
    out.push('');
    out.push(
      'No entry has moved, been archived, or started redirecting somewhere ' +
        'else. Anything listed above is informational.'
    );
    out.push('');
  }

  return { body: out.join('\n').trimEnd(), actionable };
}

// --- File the report as an issue --------------------------------------
// One issue, rewritten in place, exactly as check-staleness.js does. The
// marker and title are deliberately distinct from that script's so the two
// monthly runs never fight over the same issue body.

const ISSUE_MARKER = '<!-- web-health-report -->';
const ISSUE_TITLE = 'Web entry health report';

async function findExistingIssue(owner, repo, fetchImpl = fetch) {
  const response = await fetchImpl(
    `${GITHUB_API_ROOT}/repos/${owner}/${repo}/issues?state=open&per_page=100`,
    { headers: githubHeaders() }
  );
  if (!response.ok) return null;

  const issues = await response.json();
  return (
    issues.find(
      (issue) => !issue.pull_request && (issue.body || '').includes(ISSUE_MARKER)
    ) || null
  );
}

async function reportIssue(body, actionable, fetchImpl = fetch) {
  const slug = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    console.error('GITHUB_REPOSITORY is not set; cannot file an issue.');
    process.exitCode = 1;
    return;
  }
  if (!githubToken()) {
    console.error('No GITHUB_TOKEN; cannot file an issue.');
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const fullBody = [
    ISSUE_MARKER,
    `_Last checked ${stamp}. This issue is rewritten in place by ` +
      '`scripts/check-web-health.js`; edits to the body will be overwritten._',
    '',
    body,
  ].join('\n');

  const existing = await findExistingIssue(owner, repo, fetchImpl);

  // Nothing to do and no open report: stay quiet rather than opening an
  // issue that says everything is fine.
  if (!existing && actionable === 0) {
    console.log('No findings and no open report issue; nothing filed.');
    return;
  }

  if (existing) {
    const response = await fetchImpl(
      `${GITHUB_API_ROOT}/repos/${owner}/${repo}/issues/${existing.number}`,
      {
        method: 'PATCH',
        headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
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

  const response = await fetchImpl(`${GITHUB_API_ROOT}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
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
  const all = readEntries();
  const checkable = all.filter((e) => e.kind === 'gitlab' || e.kind === 'web');

  if (checkable.length === 0) {
    console.error('No non-GitHub entries found in README.md.');
    process.exitCode = 1;
    return;
  }

  const counts = {
    github: all.filter((e) => e.kind === 'github').length,
    gitlab: all.filter((e) => e.kind === 'gitlab').length,
    web: all.filter((e) => e.kind === 'web').length,
    ignored: all.filter((e) => e.kind === 'ignored').length,
  };

  const snapshot = loadSnapshot();
  const results = await checkAll(checkable);
  const findings = classify(results, snapshot);
  const { body, actionable } = render(findings, counts);

  console.log(body);

  if (!process.argv.includes('--no-write')) {
    writeSnapshot(updateSnapshot(snapshot, results));
    console.log('');
    console.log(`Snapshot written to ${path.relative(process.cwd(), SNAPSHOT_PATH)}.`);
  }

  if (process.argv.includes('--report-issue')) {
    console.log('');
    await reportIssue(body, actionable);
  }
}

// Exported for scripts/check-web-health.test.js. The live network path
// cannot be exercised offline, so the parsing, normalization,
// classification and rendering that decide what a maintainer is told are
// tested against synthetic responses instead.
module.exports = {
  readEntries,
  ignoreMatchers,
  isIgnored,
  gitlabProjectPath,
  lookupGitLab,
  probe,
  normalizeBody,
  hashBody,
  loadSnapshot,
  updateSnapshot,
  writeSnapshot,
  compare,
  sameDestination,
  collapsedToHomepage,
  checkAll,
  classify,
  render,
  reportIssue,
  QUIET_MONTHS,
  STABLE_MONTHS,
  SNAPSHOT_PATH,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
