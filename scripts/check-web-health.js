#!/usr/bin/env node
// Checks the entries check-staleness.js cannot see. That script asks GitHub
// about the 152 entries hosted there; the rest of the list — vendor product
// pages, standards bodies, GitLab projects, documentation portals, personal
// sites — has no health signal at all beyond "the URL returned 200". That
// is how a discontinued product stays on the list forever: the marketing
// page still resolves, so the link check stays green, and the entry quietly
// becomes a lie.
//
// Two signals, neither of which needs a vendor to cooperate:
//
//   GitLab-hosted entries get the same facts the GitHub checker gets —
//   archived, renamed, last activity — from the GitLab API.
//
//   Everything else gets a change-detection snapshot: where the URL finally
//   lands after redirects, and a hash of the response body with the
//   volatile parts normalized out. Successive runs diff against
//   scripts/web-health-snapshot.json. A product page that collapses to a
//   generic homepage, or to a "this product is discontinued" notice, is
//   exactly the decay this is for.
//
// A difference has to hold still across two runs before it is called a
// finding, and a finding then stays until it is resolved. Both halves of
// that matter, and both are about the same trap: archived and renamed, the
// things check-staleness.js reports, are *state* — ask again and the answer
// is still true. A redirect and a content change are *events*, and an event
// that is only ever compared against the last thing seen erases itself.
//
// So the snapshot records two things it must not conflate: what the web
// looks like right now, and what this repository has *accepted* as correct.
// Only the accepted baseline is what a finding is measured against, and it
// does not advance while a finding is outstanding — see reconcile(). A
// report that moved its own baseline forward would announce a retired
// product once and then close its own issue the following month with nobody
// having looked, which is worse than no signal: it looks like coverage.
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
const ACK_PATH = path.join(__dirname, 'web-health-acknowledged.json');
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
// standards PDF untouched for three years is doing its job. So these are
// printed under their own heading, phrased as "no action implied", and are
// never mixed in with the findings that need a decision.
const QUIET_MONTHS = 24;

// A content change is only worth mentioning if the page had settled first.
// Sites that churn every month say nothing by churning again; a page that
// held still for a year and then changed is worth reading, usually because
// the project renamed itself, changed licence, or shipped a successor. Even
// then it is phrased as "recheck the description", not as an error.
const STABLE_MONTHS = 12;

// Matches "* [Name](url) 🗄️ - Description", capturing the marker segment
// between the closing paren and the dash so an entry that already carries
// 🗄️ is not reported as newly archived.
//
// Known duplication: this pattern, ARCHIVED_MARKER, the Table of Contents
// skip in readEntries, monthsBetween, and the findExistingIssue/reportIssue
// pair are all copies of check-staleness.js — and the entry pattern is a
// third copy of one in check-readme.js. Three scripts now parse the same
// list the same way, which is one too many to keep in step by hand: the
// `if (!response.ok) return null` bug in findExistingIssue was copied here
// verbatim along with everything else. Worth lifting into scripts/lib/ once
// the checkers currently in flight have landed, rather than now, when
// touching them would entangle several independent reviews.
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

function ymd(date) {
  return date.toISOString().slice(0, 10);
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

  if (head.ok && (head.etag || head.lastModified)) {
    return snapshotOf(entry, head, null);
  }

  const get = await request(entry.url, 'GET', fetchImpl);
  if (!get.ok) {
    // The GET failure is the one worth reading, in both branches. A 405 on
    // HEAD is expected and harmless — plenty of hosts refuse it — so
    // reporting "HEAD returned HTTP 405" when the GET actually timed out
    // names the wrong problem.
    return { ...entry, status: 'unchecked', detail: get.detail };
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
    const reason =
      err && (err.name === 'TimeoutError' || err.name === 'AbortError')
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
// request, so every page looks changed on every run and a maintainer learns
// to ignore the report. What survives normalization is roughly the prose
// and the structure — which is what an entry's description is about.

function normalizeBody(text) {
  if (typeof text !== 'string') return '';

  return (
    text
      // Script and style blocks carry inline state, build ids and analytics
      // payloads, and none of it is content.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Per-response tokens, in attribute and in JSON form. Every quantifier
      // here is bounded and the keyword leads, because the readable version
      // of this pattern — a leading `[\w-]*` before the alternation — is
      // quadratic: it backtracks from every offset of a contiguous
      // [A-Za-z0-9_-] run, and a base64url data: URI in an <img src> is
      // exactly that with no separator to break it up. Measured on this
      // file before the pattern was anchored: 32 KB of blob took 1.7s and
      // 128 KB took 27.8s, against ≤0.2ms for every other rule in the
      // chain. hashBody is synchronous, so one such page stalls all eight
      // workers. Dropping the prefix costs nothing: matching from "csrf" in
      // "x-csrf-token" leaves "x-", which is the same on every request.
      .replace(/\bnonce\s*=\s*(["'])[^"']{0,4096}\1/gi, ' ')
      .replace(
        /(?:csrf|xsrf|session|sessid|authenticity|request)[\w-]{0,64}["']?\s*[:=]\s*(["'])[^"']{0,4096}\1/gi,
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
  'Written by scripts/check-web-health.js. Hand edits are overwritten. To ' +
  'sign off an outstanding finding, add the entry to ' +
  'scripts/web-health-acknowledged.json instead — this file is not the ' +
  'place to do it.';

// A missing snapshot is a legitimate first run: every entry becomes a
// baseline and nothing is reported. A snapshot that exists but cannot be
// parsed is a different thing entirely, and silently treating it as a first
// run would discard every outstanding finding and close the report issue on
// the next run. So that case refuses to proceed rather than rebaselining.
function loadSnapshot(snapshotPath = SNAPSHOT_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, version: 1, entries: {} };
    return { ok: false, reason: `cannot read ${snapshotPath}: ${err.message}`, entries: {} };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `${snapshotPath} is not valid JSON: ${err.message}`, entries: {} };
  }

  if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) {
    return { ok: false, reason: `${snapshotPath} has no "entries" object`, entries: {} };
  }

  return { ok: true, version: 1, entries: parsed.entries };
}

function writeSnapshot(snapshot, snapshotPath = SNAPSHOT_PATH) {
  const entries = {};
  for (const key of Object.keys(snapshot.entries).sort()) entries[key] = snapshot.entries[key];
  const out = { version: 1, note: SNAPSHOT_NOTE, entries };
  fs.writeFileSync(snapshotPath, `${JSON.stringify(out, null, 2)}\n`);
}

// --- Acknowledgements -------------------------------------------------
// The snapshot answers "what does the web look like"; this file answers
// "what has a human accepted". They were one thing until a finding was
// found to erase itself, and they have to stay apart: the moment a run can
// advance its own accepted baseline, it can close its own issue.
//
// It is a separate, hand-maintained file for two reasons. A maintainer
// should never have to hand-edit a machine-written blob of hashes to say "I
// looked at this, it's fine" — the script would overwrite it on the next
// run — and an acknowledgement is a judgement that belongs in a pull
// request where someone else can read it. This script never writes here.
//
// One shape covers both kinds of finding, because both resolve the same
// way: a human opened the link and decided the entry still describes what
// is there.
//
//   "https://vendor.example/products/widget": {
//     "reviewed": "2026-10-15",
//     "note": "Renamed product line; the description still reads true."
//   }
//
// An acknowledgement applies to a finding it is at least as recent as, so
// it signs off what was outstanding when it was written and not whatever
// happens next year. A date in the future is ignored rather than trusted: a
// typo in the year would otherwise mute an entry indefinitely.

const ACK_NOTE =
  'Hand-maintained. Each key is a README URL whose web health finding a ' +
  'maintainer has reviewed and accepted; "reviewed" is the date they looked. ' +
  'scripts/check-web-health.js reads this file and never writes it, and ' +
  'prints the exact block to paste when it reports a finding.';

function loadAcknowledgements(ackPath = ACK_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(ackPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, acks: {} };
    return { ok: false, reason: `cannot read ${ackPath}: ${err.message}`, acks: {} };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Refusing to run on a typo would be worse than running without the
    // sign-offs: the findings come back, which is the noisy direction, not
    // the dangerous one. But say so loudly.
    return { ok: false, reason: `${ackPath} is not valid JSON: ${err.message}`, acks: {} };
  }

  const acks = parsed && typeof parsed.acknowledged === 'object' && parsed.acknowledged
    ? parsed.acknowledged
    : {};
  return { ok: true, acks };
}

// YYYY-MM-DD compares correctly as a string, which keeps this readable and
// sidesteps a timezone argument nobody needs to have.
function acknowledges(ack, pendingSince, now) {
  if (!ack || typeof ack.reviewed !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ack.reviewed)) return false;
  if (ack.reviewed > ymd(now)) return false;
  return ack.reviewed >= pendingSince;
}

// --- Comparing --------------------------------------------------------

// Compare whatever the two records have in common, strongest first. When
// they have nothing in common — a host that stopped sending ETag, say — the
// answer is "unknown", never "different". An unknown is not a finding.
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

// Query parameters that identify the reader rather than the page. A CDN
// appending utm_source is not a product being discontinued, and the
// original version of sameDestination used that to justify ignoring the
// query string entirely. That was too blunt: both EUR-Lex entries in this
// list share a host and a path and differ *only* in
// `?uri=CELEX%3A42021X0387`, so a redirect from one legal act to another
// read as "same destination" and the finding could never fire. Only the
// keys below are dropped; everything else is part of the address.
const TRACKING_PARAMS =
  /^(?:utm_|_ga|_gl|mc_|pk_|hsa_|at_)|^(?:gclid|dclid|fbclid|msclkid|yclid|igshid|twclid|ref|referrer|source|cmpid|campaign)$/i;

// Two URLs point at the same page if they agree on host, path and the part
// of the query that addresses content. Scheme upgrades, www and trailing
// slashes change without the destination changing.
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
  // A per-visit parameter this list does not know about would flip this and
  // look like a redirect. It cannot produce a finding on its own, because a
  // finding has to hold still across two runs and a session id never does.
  const query = (u) => {
    const kept = [];
    for (const [key, value] of u.searchParams) {
      if (!TRACKING_PARAMS.test(key)) kept.push(`${key}=${value}`);
    }
    return kept.sort().join('&');
  };

  return (
    host(left) === host(right) &&
    route(left) === route(right) &&
    query(left) === query(right)
  );
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

function monthsBetween(iso, now = new Date()) {
  if (!iso) return 0;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 0;
  return Math.floor((now - then) / (1000 * 60 * 60 * 24 * 30.44));
}

// --- Reconciling one entry --------------------------------------------
// The single place that decides both what is reported and what is recorded,
// so the two cannot disagree. They used to be separate functions, and the
// bug that produced was subtle and total: classify() reported a redirect and
// updateSnapshot() then wrote the new destination in as the accepted one, so
// the next run compared the new destination against itself, found nothing,
// and reportIssue() closed the issue. The finding deleted its own evidence.
//
// The rule that prevents it: **the accepted baseline does not advance while
// a finding is outstanding.** A pending block records what was observed so
// the report can say how long this has been sitting there, but the values a
// finding is measured against stay put until the finding is resolved —
// which happens in exactly three ways:
//
//   the README entry is edited, so its URL is a new key and a fresh baseline;
//   the difference goes away on its own (a vendor undoes a redirect);
//   a maintainer acknowledges it in web-health-acknowledged.json.
//
// A difference also has to hold still before it counts. A vendor host that
// sends /product to /en-us/product or /en-gb/product depending on which
// region the runner egressed from flip-flops every month, and without this
// it would file a fresh finding every month forever. So the first sighting
// is recorded and listed as "watching", and only a second run that sees the
// same thing makes it actionable. That costs one month of latency on a
// check that runs monthly, and it buys immunity to every flavour of
// per-request variation at once — geo, A/B, session — rather than to the
// one flavour a list of locale prefixes would cover.
const CONFIRM_RUNS = 2;

function reconcile(result, prior, ack, now = new Date()) {
  const stamp = ymd(now);

  if (!prior) {
    return { outcome: 'baseline', record: accept(null, result, stamp, stamp, 'unknown') };
  }

  const destinationMoved =
    Boolean(prior.finalUrl) && !sameDestination(prior.finalUrl, result.finalUrl);
  const verdict = compare(prior, result);
  const contentChanged = verdict === 'different';

  // How long the accepted content had held still before this run. Frozen
  // while a finding is outstanding, so it keeps growing rather than
  // resetting and dropping the entry below the threshold.
  const stableFor = monthsBetween(prior.lastChanged || prior.firstSeen, now);
  const reportableChange = contentChanged && stableFor >= STABLE_MONTHS;

  if (!destinationMoved && !reportableChange) {
    // Nothing outstanding. Advance the accepted baseline, and drop any
    // pending block: a redirect the vendor has undone, or a locale that
    // flipped back, resolves itself.
    const lastChanged = contentChanged ? stamp : prior.lastChanged || stamp;
    return {
      outcome: contentChanged ? 'churn' : verdict === 'same' ? 'unchanged' : 'indeterminate',
      record: accept(prior, result, stamp, lastChanged, verdict),
      settledFor: stableFor,
    };
  }

  const kind = destinationMoved ? 'redirected' : 'changed';
  const pending = extend(prior.pending, kind, result, stamp);

  if (acknowledges(ack, pending.since, now)) {
    // Signed off. Adopt what is there now as the new accepted baseline, and
    // restart the stability clock — if this page changes again it is a new
    // finding, not this one coming back.
    return {
      outcome: 'acknowledged',
      record: accept(prior, result, stamp, stamp, verdict),
      since: pending.since,
      reviewed: ack.reviewed,
    };
  }

  return {
    outcome: pending.seen >= CONFIRM_RUNS ? kind : 'watching',
    kind,
    record: hold(prior, pending, stamp),
    since: pending.since,
    seen: pending.seen,
    stableFor,
    previousUrl: prior.finalUrl,
    collapsed: destinationMoved && collapsedToHomepage(prior.finalUrl, result.finalUrl),
  };
}

// A sighting counts toward confirmation only if it agrees with the last one
// on the axis that produced it. Comparing both axes would let an ordinary
// live page — whose body moves a little every month — keep resetting a
// perfectly stable redirect.
function extend(pending, kind, result, stamp) {
  const same =
    pending &&
    pending.kind === kind &&
    (kind === 'redirected'
      ? sameDestination(pending.finalUrl, result.finalUrl)
      : (pending.hash || null) === (result.hash || null));

  return {
    kind,
    since: same ? pending.since : stamp,
    seen: same ? (pending.seen || 1) + 1 : 1,
    finalUrl: result.finalUrl,
    hash: result.hash || null,
  };
}

// `verdict` decides whether a body hash that the current probe did not
// collect is still worth keeping. A host that puts a CDN in front starts
// answering HEAD with an ETag, so probe() stops fetching the body and
// returns hash: null — and writing that null in would throw the recorded
// hash away permanently, leaving nothing to compare on either axis if the
// ETag later disappears. Carry it, unless the ETag has already told us the
// page moved on, in which case the old hash is stale and misleading.
function accept(prior, result, stamp, lastChanged, verdict) {
  return {
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    hash: result.hash || (verdict !== 'different' && prior ? prior.hash || null : null),
    etag: result.etag || null,
    lastModified: result.lastModified || null,
    firstSeen: (prior && prior.firstSeen) || stamp,
    lastChanged,
    lastChecked: stamp,
  };
}

// Everything the finding is measured against is copied through untouched.
// Only lastChecked and the pending observation move.
function hold(prior, pending, stamp) {
  return {
    finalUrl: prior.finalUrl,
    httpStatus: prior.httpStatus,
    hash: prior.hash || null,
    etag: prior.etag || null,
    lastModified: prior.lastModified || null,
    firstSeen: prior.firstSeen || stamp,
    lastChanged: prior.lastChanged || stamp,
    lastChecked: stamp,
    pending,
  };
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

function classify(results, snapshot = { entries: {} }, acks = {}, now = new Date()) {
  const findings = {
    missing: [],
    renamed: [],
    needsMarker: [],
    staleMarker: [],
    redirected: [],
    changed: [],
    watching: [],
    acknowledged: [],
    staleAcks: [],
    quiet: [],
    baseline: [],
    unchecked: [],
  };

  const prior = (snapshot && snapshot.entries) || {};
  const ackUsed = new Set();
  const ackUndecided = new Set();
  const seen = new Set();

  for (const result of results) {
    seen.add(result.url);

    if (result.status === 'unchecked') {
      findings.unchecked.push(result);

      // An entry that could not be reached this run keeps whatever was
      // outstanding against it. Dropping the finding for a month would let
      // one bad morning at one host close the report issue.
      const record = prior[result.url];
      if (record && record.pending && (record.pending.seen || 0) >= CONFIRM_RUNS) {
        carryPending(result, record, findings);
        ackUndecided.add(result.url);
      } else if (record && record.pending) {
        ackUndecided.add(result.url);
      }
      continue;
    }

    if (result.kind === 'gitlab') {
      classifyGitLab(result, findings, now);
      continue;
    }

    const outcome = reconcile(result, prior[result.url], acks[result.url], now);

    switch (outcome.outcome) {
      case 'baseline':
        findings.baseline.push(result);
        break;
      case 'redirected':
        findings.redirected.push({
          ...result,
          previousUrl: outcome.previousUrl,
          collapsed: outcome.collapsed,
          since: outcome.since,
        });
        break;
      case 'changed':
        findings.changed.push({
          ...result,
          since: outcome.since,
          stableFor: outcome.stableFor,
        });
        break;
      case 'watching':
        findings.watching.push({
          ...result,
          kind: outcome.kind,
          previousUrl: outcome.previousUrl,
          since: outcome.since,
        });
        break;
      case 'acknowledged':
        ackUsed.add(result.url);
        findings.acknowledged.push({ ...result, since: outcome.since, reviewed: outcome.reviewed });
        break;
      case 'unchanged':
        // Only a verified match earns this. When the fingerprints could not
        // be compared at all the honest answer is nothing, not a claim that
        // the page has sat still for two years.
        if (outcome.settledFor >= QUIET_MONTHS) {
          const record = prior[result.url];
          findings.quiet.push({
            ...result,
            quietSince: record.lastChanged || record.firstSeen,
          });
        }
        break;
      default: // 'churn' — changed, but this page changes all the time
        break;
    }
  }

  // An acknowledgement that signed nothing off this run has done its job
  // and is now just a line nobody will dare delete later. Say so, but only
  // for entries this run could actually see: a host that was down is not
  // evidence that a sign-off is spent.
  for (const [url, ack] of Object.entries(acks)) {
    if (ackUsed.has(url) || ackUndecided.has(url)) continue;
    findings.staleAcks.push({
      url,
      reviewed: ack && ack.reviewed,
      reason: seen.has(url) ? 'nothing outstanding against it' : 'no longer in README.md',
    });
  }

  return findings;
}

// Re-report what was outstanding the last time this entry could be read.
function carryPending(result, record, findings) {
  const moved = record.pending.kind === 'redirected';

  if (moved) {
    findings.redirected.push({
      ...result,
      finalUrl: record.pending.finalUrl,
      previousUrl: record.finalUrl,
      collapsed: collapsedToHomepage(record.finalUrl, record.pending.finalUrl),
      since: record.pending.since,
      carried: true,
    });
    return;
  }

  findings.changed.push({
    ...result,
    since: record.pending.since,
    stableFor: monthsBetween(record.lastChanged || record.firstSeen),
    carried: true,
  });
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

// The snapshot for the next run. Built from the same reconcile() the report
// was built from, so a finding and the record it is measured against can
// never drift apart.
//
// Only entries this run could read are rewritten. An unchecked entry keeps
// the record it already had — dropping it would silently reset its baseline
// and, now that findings persist, would throw away an outstanding one.
// Entries no longer in the README are pruned, which is also how editing an
// entry resolves a finding against it.
function updateSnapshot(snapshot, results, acks = {}, now = new Date()) {
  const prior = (snapshot && snapshot.entries) || {};
  const entries = {};

  for (const result of results) {
    if (result.kind === 'gitlab') continue; // nothing to snapshot; the API is the record

    if (result.status !== 'ok') {
      if (prior[result.url]) entries[result.url] = prior[result.url];
      continue;
    }

    entries[result.url] = reconcile(result, prior[result.url], acks[result.url], now).record;
  }

  return { version: 1, entries };
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

  const checked = (counts.gitlab || 0) + (counts.web || 0);
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
          `${age(f)}(README.md:${f.lineNo})`
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
        'still reads true, acknowledge it below and this stops being ' +
        'reported.'
    );
    out.push('');
    for (const f of findings.changed) {
      out.push(
        `- **${f.name}** — held still for ${f.stableFor} months, now differs ` +
          `${age(f)}(README.md:${f.lineNo})`
      );
    }
    out.push('');
  }

  // The instructions live next to the findings they resolve, because a
  // maintainer reading this in a GitHub issue should not have to go and
  // find out how the acknowledgement file works.
  if (findings.redirected.length > 0 || findings.changed.length > 0) {
    out.push('### Signing one of these off');
    out.push('');
    out.push(
      'These stay in this report until the entry is edited, the page goes ' +
        'back to what it was, or someone says the entry is still correct. ' +
        'They do **not** disappear on their own next month — a check that ' +
        'cleared its own findings would be telling you it had coverage it ' +
        'did not have. To sign one off, add it to ' +
        '`scripts/web-health-acknowledged.json` in a pull request:'
    );
    out.push('');
    out.push('```json');
    const sample = findings.redirected[0] || findings.changed[0];
    out.push(`"${sample.url}": {`);
    out.push(`  "reviewed": "${ymd(new Date())}",`);
    out.push('  "note": "Looked at it; the description still reads true."');
    out.push('}');
    out.push('```');
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

  if (findings.watching.length > 0) {
    out.push('## Seen once, watching');
    out.push('');
    out.push(
      '**No action implied.** Something looked different this run, but only ' +
        'this run. Hosts that pick a locale or an A/B variant per request ' +
        'differ every time they are asked, and reporting the first sighting ' +
        'would file a fresh finding every month forever. If the same thing ' +
        'is still true next month it moves up into the list above. Nothing ' +
        'here is worth opening a link over yet.'
    );
    out.push('');
    for (const f of findings.watching) {
      out.push(
        f.kind === 'redirected'
          ? `- **${f.name}** — \`${f.previousUrl}\` → \`${f.finalUrl}\``
          : `- **${f.name}** — content differs from the recorded page`
      );
    }
    out.push('');
  }

  if (findings.acknowledged.length > 0) {
    out.push('## Signed off since the last run');
    out.push('');
    out.push(
      '**No action implied.** A maintainer reviewed these and accepted what ' +
        'the page says now, so they have been taken as the new baseline. ' +
        'Their entries in `scripts/web-health-acknowledged.json` have done ' +
        'their job and can be deleted.'
    );
    out.push('');
    for (const f of findings.acknowledged) {
      out.push(`- **${f.name}** — reviewed ${f.reviewed}, outstanding since ${f.since}`);
    }
    out.push('');
  }

  if (findings.staleAcks.length > 0) {
    out.push('## Acknowledgements that can be removed');
    out.push('');
    out.push(
      '**No action implied.** These lines in ' +
        '`scripts/web-health-acknowledged.json` are not suppressing anything ' +
        'any more. Left in place they will quietly sign off a future finding ' +
        'nobody looked at, so they are better deleted.'
    );
    out.push('');
    for (const f of findings.staleAcks) {
      out.push(`- \`${f.url}\` — ${f.reason}`);
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

// "outstanding since" is the whole point of the pending record: a finding
// that has been sitting in the report for four months reads very
// differently from one found this morning.
function age(finding) {
  const parts = [];
  if (finding.since) parts.push(`outstanding since ${finding.since}`);
  if (finding.carried) parts.push('could not be rechecked this run');
  return parts.length > 0 ? `(${parts.join('; ')}) ` : '';
}

// --- File the report as an issue --------------------------------------
// One issue, rewritten in place, exactly as check-staleness.js does. The
// marker and title are deliberately distinct from that script's so the two
// monthly runs never fight over the same issue body.

const ISSUE_MARKER = '<!-- web-health-report -->';
const ISSUE_TITLE = 'Web entry health report';

// Three answers, not two. "I looked and there is no open report" and "I
// could not find out" lead to opposite actions, and collapsing them — as
// `if (!response.ok) return null` does — turns a 500 or a rate limit into
// proof that no issue exists, which sends the run down the creation path
// and opens a duplicate beside the report already there.
//
// state=all rather than state=open, because this report can close itself
// and later have something to say again. Searching only the open issues
// would leave the closed one behind and open a second, scattering the
// comment thread a maintainer wrote across two issues.
async function findExistingIssue(owner, repo, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(
      `${GITHUB_API_ROOT}/repos/${owner}/${repo}/issues` +
        '?state=all&per_page=100&sort=updated&direction=desc',
      { headers: githubHeaders() }
    );
  } catch (err) {
    return { state: 'unknown', detail: err.message };
  }

  if (!response.ok) {
    return { state: 'unknown', detail: `the GitHub API returned HTTP ${response.status}` };
  }

  let issues;
  try {
    issues = await response.json();
  } catch (err) {
    return { state: 'unknown', detail: `unreadable issue list: ${err.message}` };
  }
  if (!Array.isArray(issues)) {
    return { state: 'unknown', detail: 'the GitHub API returned an unexpected issue list' };
  }

  const found = issues.find(
    (issue) => !issue.pull_request && (issue.body || '').includes(ISSUE_MARKER)
  );
  return found ? { state: 'found', issue: found } : { state: 'none' };
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

  const stamp = ymd(new Date());
  const fullBody = [
    ISSUE_MARKER,
    `_Last checked ${stamp}. This issue is rewritten in place by ` +
      '`scripts/check-web-health.js`; edits to the body will be overwritten, ' +
      'so leave notes as comments — those survive._',
    '',
    body,
  ].join('\n');

  const existing = await findExistingIssue(owner, repo, fetchImpl);

  if (existing.state === 'unknown') {
    console.error(
      `Could not list the open issues (${existing.detail}); filing nothing. ` +
        'Posting anyway risks opening a duplicate beside the report already open.'
    );
    process.exitCode = 1;
    return;
  }

  // Nothing to do and no report to update: stay quiet rather than opening
  // an issue that says everything is fine, or rewriting a closed one just
  // to tell it that it is still closed.
  if (actionable === 0 && (existing.state === 'none' || existing.issue.state === 'closed')) {
    console.log('No findings and no open report issue; nothing filed.');
    return;
  }

  if (existing.state === 'found') {
    const number = existing.issue.number;
    const response = await fetchImpl(
      `${GITHUB_API_ROOT}/repos/${owner}/${repo}/issues/${number}`,
      {
        method: 'PATCH',
        headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: fullBody,
          // Close it only once the list is genuinely clean again. Because
          // findings persist until they are resolved, an open report always
          // means there is still something to decide.
          state: actionable === 0 ? 'closed' : 'open',
        }),
      }
    );
    if (!response.ok) {
      console.error(`Failed to update issue #${number}: ${response.status}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      actionable === 0
        ? `Closed issue #${number}; nothing left to act on.`
        : existing.issue.state === 'closed'
          ? `Reopened issue #${number} with ${actionable} finding(s).`
          : `Updated issue #${number} with ${actionable} finding(s).`
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

  const snapshot = loadSnapshot();
  if (!snapshot.ok) {
    // Rebaselining on an unreadable snapshot would discard every
    // outstanding finding and close the report issue on the next run.
    console.error(`Cannot run the check: ${snapshot.reason}`);
    console.error(
      'Restore it from git rather than deleting it; deleting it rebaselines ' +
        'every entry and throws away anything still outstanding.'
    );
    process.exitCode = 1;
    return;
  }

  const acknowledgements = loadAcknowledgements();
  if (!acknowledgements.ok) {
    console.error(`Ignoring the acknowledgements: ${acknowledgements.reason}`);
    console.error('Findings signed off there will be reported again until it parses.');
  }

  const counts = {
    github: all.filter((e) => e.kind === 'github').length,
    gitlab: all.filter((e) => e.kind === 'gitlab').length,
    web: all.filter((e) => e.kind === 'web').length,
    ignored: all.filter((e) => e.kind === 'ignored').length,
  };

  const results = await checkAll(checkable);
  const findings = classify(results, snapshot, acknowledgements.acks);
  const { body, actionable } = render(findings, counts);

  console.log(body);

  if (!process.argv.includes('--no-write')) {
    writeSnapshot(updateSnapshot(snapshot, results, acknowledgements.acks));
    console.log('');
    console.log(`Snapshot written to ${path.relative(process.cwd(), SNAPSHOT_PATH)}.`);
  }

  if (process.argv.includes('--report-issue')) {
    console.log('');
    await reportIssue(body, actionable);
  }
}

// Exported for scripts/check-web-health.test.js. The live network path
// cannot be exercised offline, so the parsing, normalization, reconciliation
// and rendering that decide what a maintainer is told are tested against
// synthetic responses instead.
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
  writeSnapshot,
  loadAcknowledgements,
  acknowledges,
  reconcile,
  updateSnapshot,
  compare,
  sameDestination,
  collapsedToHomepage,
  checkAll,
  classify,
  render,
  findExistingIssue,
  reportIssue,
  QUIET_MONTHS,
  STABLE_MONTHS,
  CONFIRM_RUNS,
  SNAPSHOT_PATH,
  ACK_PATH,
  ACK_NOTE,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
