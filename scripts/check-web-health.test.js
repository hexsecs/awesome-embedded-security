#!/usr/bin/env node
// Tests for check-web-health.js, using node:test so nothing new is added to
// package.json. Run with `npm run test:web-health`.
//
// Everything here is offline: synthetic responses and fixture snapshots, no
// network at all. What is tested is everything that decides what a
// maintainer is told — and, above all, the three ways this script could do
// real damage.
//
// The first is noise. If body normalization does not strip the volatile
// parts of a page, every entry looks changed every month, the report becomes
// unreadable, and the signal is worth nothing.
//
// The second is a false positive: a timeout or a bot wall rendered as "this
// entry has moved" would send someone rewriting or deleting a live entry. A
// failure must always degrade to "unchecked".
//
// The third is the subtlest and was a real bug. A finding that advances the
// baseline it is measured against reports itself once and then closes its
// own issue the following month with nobody having looked at it. Everything
// under "Findings have to survive the run that found them" exists to keep
// that from coming back, because the failure is invisible: the report says
// all clear, and it is wrong.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readEntries,
  CONFIRM_RUNS,
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
  checkAll,
  classify,
  render,
  findExistingIssue,
  reportIssue,
  QUIET_MONTHS,
  STABLE_MONTHS,
} = require('./check-web-health.js');

const NOW = new Date('2026-09-17T00:00:00Z');
const MONTH = 1000 * 60 * 60 * 24 * 30.44;
const ymd = (d) => d.toISOString().slice(0, 10);
const monthsAgo = (n) => ymd(new Date(NOW.getTime() - n * MONTH));
const later = (months) => new Date(NOW.getTime() + months * MONTH);

const URL_A = 'https://vendor.example/products/widget';

// --- Helpers ----------------------------------------------------------

function webEntry(overrides = {}) {
  return {
    name: 'Example Vendor Tool',
    url: URL_A,
    host: 'vendor.example',
    kind: 'web',
    hasArchivedMarker: false,
    lineNo: 42,
    status: 'ok',
    method: 'GET',
    httpStatus: 200,
    finalUrl: URL_A,
    etag: null,
    lastModified: null,
    hash: 'aaaa',
    ...overrides,
  };
}

function gitlabEntry(overrides = {}) {
  return {
    name: 'Peach',
    url: 'https://gitlab.com/peachtech/peach-fuzzer-community',
    host: 'gitlab.com',
    kind: 'gitlab',
    project: 'peachtech/peach-fuzzer-community',
    hasArchivedMarker: false,
    lineNo: 136,
    status: 'ok',
    archived: false,
    fullName: 'peachtech/peach-fuzzer-community',
    pushedAt: new Date(NOW.getTime() - 2 * MONTH).toISOString(),
    ...overrides,
  };
}

function snapshotWith(url, record) {
  return { ok: true, version: 1, entries: { [url]: record } };
}

// A settled baseline: recorded long ago, nothing outstanding against it.
function settled(overrides = {}) {
  return {
    finalUrl: URL_A,
    httpStatus: 200,
    hash: 'aaaa',
    etag: null,
    lastModified: null,
    firstSeen: monthsAgo(30),
    lastChanged: monthsAgo(30),
    lastChecked: monthsAgo(1),
    ...overrides,
  };
}

// A pending block as the run before this one would have left it: seen once,
// not yet confirmed. Most tests want a finding to look at rather than the
// month of watching that precedes one, and this is how they skip it.
function watched(kind, { finalUrl = URL_A, hash = 'aaaa', since = monthsAgo(1) } = {}) {
  return { kind, since, seen: 1, finalUrl, hash };
}

// One monthly run, wired the way main() wires it: the same results feed the
// report and the snapshot, and the snapshot feeds the next run.
function run(snapshot, results, acks = {}, now = NOW) {
  const findings = classify(results, snapshot, acks, now);
  const rendered = render(findings, { web: results.length });
  return {
    findings,
    body: rendered.body,
    actionable: rendered.actionable,
    snapshot: { ok: true, ...updateSnapshot(snapshot, results, acks, now) },
  };
}

// A response object shaped like the bits of the fetch Response this script
// touches.
function response({ status = 200, url = 'https://vendor.example/', headers = {}, body = '' } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body || '{}'),
  };
}

// --- Reading the real README -----------------------------------------

test('splits the real README into the entries each checker owns', () => {
  const entries = readEntries();

  assert.ok(entries.length > 200, 'expected the list to yield many entries');

  const kinds = new Set(entries.map((e) => e.kind));
  assert.ok(kinds.has('github'), 'GitHub entries are recognised and left alone');
  assert.ok(kinds.has('web'), 'there are non-GitHub entries to snapshot');

  assert.ok(
    entries.every((e) => !/^#/.test(e.url)),
    'Table of Contents anchors must not be treated as entries'
  );
  assert.ok(
    entries.filter((e) => e.kind === 'github').length > 100,
    'the GitHub entries stay with check-staleness.js'
  );
  assert.ok(
    entries.filter((e) => e.kind === 'web').length > 50,
    'and the rest, which nothing else checks, are what this script is for'
  );
});

test('the README GitLab entry resolves to a project path', () => {
  const entries = readEntries().filter((e) => e.kind === 'gitlab');

  assert.ok(entries.length > 0, 'the README has a GitLab-hosted entry');
  for (const e of entries) {
    assert.ok(e.project.includes('/'), 'a project path is namespace/project');
  }
});

test('a GitLab URL pointing inside a project still names the project', () => {
  assert.strictEqual(
    gitlabProjectPath(new URL('https://gitlab.com/group/project/-/issues/7')),
    'group/project'
  );
  assert.strictEqual(
    gitlabProjectPath(new URL('https://gitlab.com/group/sub/project')),
    'group/sub/project',
    'subgroups mean the path can be deeper than two segments'
  );
  assert.strictEqual(
    gitlabProjectPath(new URL('https://gitlab.com/group/project.git')),
    'group/project'
  );
  assert.strictEqual(
    gitlabProjectPath(new URL('https://gitlab.com/explore')),
    null,
    'a single segment is not a project'
  );
});

// --- Hosts the link config already skips ------------------------------

test('hosts known to block automated clients are skipped, not checked', () => {
  const matchers = ignoreMatchers();
  assert.ok(matchers.length > 0, 'markdown.links.config.json lists ignore patterns');

  assert.ok(isIgnored('https://www.analog.com/en/resources/thing.html', matchers));
  assert.ok(isIgnored('https://trustedcomputinggroup.org/resource-library/', matchers));
  assert.ok(!isIgnored(URL_A, matchers));

  const ignored = readEntries().filter((e) => e.kind === 'ignored');
  assert.ok(ignored.length > 0, 'the README has entries on those hosts');

  // And the skip must survive into the run: a blocked host that got probed
  // anyway would come back as a bot wall and read as a problem.
  const findings = classify(
    ignored.map((e) => ({ ...e, status: 'ok' })),
    { entries: {} },
    {},
    NOW
  );
  assert.strictEqual(findings.unchecked.length, 0);
});

test('a missing link config skips nothing rather than throwing', () => {
  assert.deepStrictEqual(
    ignoreMatchers(path.join(os.tmpdir(), 'definitely-not-here.json')),
    []
  );
});

// --- Normalization: the thing that makes the signal worth having ------

test('normalization suppresses the parts of a page that change every request', () => {
  const page = (n) => `
    <!doctype html>
    <!-- build ${n} generated at 2026-0${n}-01T04:2${n}:00Z -->
    <html>
      <head>
        <title>Widget Debug Probe</title>
        <style>.a { color: #${n}${n}${n} }</style>
        <script nonce="r4nd0mNonce${n}">window.__BOOT__ = ${1700000000 + n};</script>
        <link rel="stylesheet" href="/assets/app.9f3ab21c7d4e55${n}.css?v=${n}.0.${n}">
        <meta name="csrf-token" content="deadbeefcafebabe000${n}">
      </head>
      <body>
        <h1>Widget Debug Probe</h1>
        <p>A JTAG probe for the Widget family.</p>
        <footer>Page generated ${n === 1 ? 'Mon, 01 Jan 2026 04:21:00 GMT' : 'Tue, 02 Feb 2026 05:22:00 GMT'}</footer>
        <span>session_id: "abc${n}def${n}"</span>
      </body>
    </html>`;

  assert.strictEqual(
    hashBody(page(1)),
    hashBody(page(2)),
    'nonces, tokens, timestamps, build hashes and cache-busters must not ' +
      'change the hash, or every page looks changed every run'
  );

  const normalized = normalizeBody(page(1));
  assert.ok(normalized.includes('A JTAG probe for the Widget family.'));
  assert.ok(!normalized.includes('__BOOT__'), 'script bodies are dropped');
  assert.ok(!normalized.includes('r4nd0mNonce'), 'nonces are dropped');
  assert.ok(!/2026-\d{2}-\d{2}/.test(normalized), 'ISO dates are dropped');
});

test('normalization is not quadratic on a page with one long unbroken token', () => {
  // A base64url data: URI in an <img src> is a single contiguous
  // [A-Za-z0-9_-] run with nothing to break it up. The readable form of the
  // CSRF rule — a leading [\w-]* before the alternation — backtracks from
  // every offset of it: measured at 1.7s for 32 KB and 27.8s for 128 KB,
  // against 0.2ms for every other rule in the chain. hashBody is
  // synchronous, so one such page stalls all eight workers.
  const page = (kb) =>
    `<html><body><img src="data:image/png;base64,${'A'.repeat(kb * 1024)}"><p>hi</p></body></html>`;

  const started = Date.now();
  normalizeBody(page(128));
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `128 KB of blob took ${elapsed}ms; it used to take 27800ms`);
});

test('normalization still notices the content actually changing', () => {
  assert.notStrictEqual(
    hashBody('<html><body><p>Actively maintained JTAG probe.</p></body></html>'),
    hashBody('<html><body><p>This product has been discontinued.</p></body></html>')
  );
});

test('whitespace and reformatting alone are not a change', () => {
  assert.strictEqual(
    hashBody('<p>Hello</p>\n<p>World</p>'),
    hashBody('  <p>Hello</p>      <p>World</p>  ')
  );
});

// --- A first run ------------------------------------------------------

test('a first run with no prior snapshot is a baseline with zero findings', () => {
  const first = run({ entries: {} }, [
    webEntry(),
    webEntry({ name: 'Other', url: 'https://other.example/x' }),
  ]);

  assert.strictEqual(first.actionable, 0, 'nothing can have changed on the first run');
  assert.strictEqual(first.findings.baseline.length, 2);
  assert.strictEqual(first.findings.redirected.length, 0);
  assert.strictEqual(first.findings.changed.length, 0);
  assert.ok(first.body.includes('Newly recorded'));
  assert.ok(first.body.includes('Nothing needs doing'));

  assert.strictEqual(Object.keys(first.snapshot.entries).length, 2);
  const record = first.snapshot.entries[URL_A];
  assert.strictEqual(record.hash, 'aaaa');
  assert.strictEqual(record.firstSeen, '2026-09-17');
  assert.strictEqual(record.lastChanged, '2026-09-17');
  assert.strictEqual(record.pending, undefined, 'a baseline has nothing outstanding');
});

test('a missing snapshot file is a clean first run', () => {
  const missing = loadSnapshot(path.join(os.tmpdir(), 'no-such-snapshot.json'));
  assert.strictEqual(missing.ok, true);
  assert.deepStrictEqual(missing.entries, {});
});

test('an unreadable snapshot refuses rather than silently rebaselining', () => {
  // Treating a corrupt snapshot as a first run would throw away every
  // outstanding finding and close the report issue on the next run — the
  // same self-erasure, arriving by a different road.
  const junk = path.join(os.tmpdir(), `web-health-junk-${process.pid}.json`);
  fs.writeFileSync(junk, 'not json at all');
  try {
    const loaded = loadSnapshot(junk);
    assert.strictEqual(loaded.ok, false);
    assert.match(loaded.reason, /not valid JSON/);
  } finally {
    fs.unlinkSync(junk);
  }

  const shapeless = path.join(os.tmpdir(), `web-health-shapeless-${process.pid}.json`);
  fs.writeFileSync(shapeless, '{"version":1}');
  try {
    assert.strictEqual(loadSnapshot(shapeless).ok, false);
  } finally {
    fs.unlinkSync(shapeless);
  }
});

// --- Findings have to survive the run that found them -----------------
// The bug this section exists for: the check reported a redirect, wrote the
// new destination in as the accepted one, and the next run compared the new
// destination against itself, found nothing, and closed the issue. One
// month of visibility for the exact decay the whole check is for.

test('an unresolved redirect survives the next run and keeps the issue open', () => {
  const collapsed = () => webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' });

  // Sighting one: recorded, watched, not yet reported.
  const first = run(snapshotWith(URL_A, settled()), [collapsed()]);
  assert.strictEqual(first.findings.watching.length, 1);
  assert.strictEqual(first.actionable, 0, 'one sighting is not yet evidence');

  // Sighting two confirms it.
  const second = run(first.snapshot, [collapsed()], {}, later(1));
  assert.strictEqual(second.findings.redirected.length, 1);
  assert.strictEqual(second.actionable, 1);

  // A month later, nothing about the page has changed and nobody has
  // looked. It must still be reported.
  const third = run(second.snapshot, [collapsed()], {}, later(2));

  assert.strictEqual(
    third.findings.redirected.length,
    1,
    'the finding must not erase itself'
  );
  assert.strictEqual(
    third.actionable,
    1,
    'actionable drives whether reportIssue closes the issue; it must stay above zero'
  );
  assert.ok(
    third.body.includes('outstanding since 2026-09-17'),
    'and it should say how long it has been sitting there'
  );

  // A year of neglect does not make it go away either.
  let snapshot = third.snapshot;
  for (let month = 3; month <= 14; month += 1) {
    snapshot = run(snapshot, [collapsed()], {}, later(month)).snapshot;
  }
  const last = run(snapshot, [collapsed()], {}, later(15));
  assert.strictEqual(last.actionable, 1);
  assert.ok(last.body.includes('outstanding since 2026-09-17'));
});

test('the accepted baseline does not advance while a finding is outstanding', () => {
  const collapsed = () => webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' });
  const first = run(snapshotWith(URL_A, settled()), [collapsed()]);

  const record = first.snapshot.entries[URL_A];
  assert.strictEqual(record.finalUrl, URL_A, 'the accepted destination is held');
  assert.strictEqual(record.hash, 'aaaa', 'and so is the accepted fingerprint');
  assert.strictEqual(record.lastChanged, monthsAgo(30), 'the stability clock is frozen');
  assert.strictEqual(record.lastChecked, '2026-09-17', 'only the check date moves');
  assert.deepStrictEqual(record.pending, {
    kind: 'redirected',
    since: '2026-09-17',
    seen: 1,
    finalUrl: 'https://vendor.example/',
    hash: 'bbbb',
  });

  // Confirming it must not advance the baseline either — that is the whole
  // point. Only the sighting count moves.
  const second = run(first.snapshot, [collapsed()], {}, later(1));
  const held = second.snapshot.entries[URL_A];
  assert.strictEqual(held.finalUrl, URL_A);
  assert.strictEqual(held.hash, 'aaaa');
  assert.strictEqual(held.lastChanged, monthsAgo(30));
  assert.strictEqual(held.pending.seen, 2);
  assert.strictEqual(held.pending.since, '2026-09-17');
});

test('a content change persists across runs the same way a redirect does', () => {
  const stable = settled({ lastChanged: monthsAgo(STABLE_MONTHS + 6) });
  const first = run(snapshotWith(URL_A, stable), [webEntry({ hash: 'bbbb' })]);
  assert.strictEqual(first.findings.watching.length, 1);

  const second = run(first.snapshot, [webEntry({ hash: 'bbbb' })], {}, later(1));
  assert.strictEqual(second.findings.changed.length, 1);
  assert.strictEqual(second.actionable, 1);

  const third = run(second.snapshot, [webEntry({ hash: 'bbbb' })], {}, later(2));
  assert.strictEqual(
    third.findings.changed.length,
    1,
    'Codex named the redirect case; the content case had the same defect'
  );
  assert.strictEqual(third.actionable, 1);
  assert.strictEqual(
    third.findings.quiet.length,
    0,
    'and it must not drift into the quiet bucket while outstanding'
  );
});

test('a redirect the vendor undoes resolves itself', () => {
  const first = run(
    snapshotWith(
      URL_A,
      settled({ pending: watched('redirected', { finalUrl: 'https://vendor.example/', hash: 'bbbb' }) })
    ),
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })]
  );
  assert.strictEqual(first.actionable, 1);

  const second = run(first.snapshot, [webEntry()], {}, later(1));
  assert.strictEqual(second.actionable, 0, 'the page is back where it was');
  assert.strictEqual(second.snapshot.entries[URL_A].pending, undefined);
  assert.strictEqual(second.snapshot.entries[URL_A].finalUrl, URL_A);
});

test('editing the README entry resolves the finding against it', () => {
  const first = run(
    snapshotWith(
      URL_A,
      settled({
        pending: watched('redirected', {
          finalUrl: 'https://vendor.example/widgets-v2',
          hash: 'bbbb',
        }),
      })
    ),
    [webEntry({ finalUrl: 'https://vendor.example/widgets-v2', hash: 'bbbb' })]
  );
  assert.strictEqual(first.actionable, 1);

  // A maintainer repoints the entry at the new page. New URL, new key.
  const second = run(
    first.snapshot,
    [webEntry({ url: 'https://vendor.example/widgets-v2', finalUrl: 'https://vendor.example/widgets-v2', hash: 'bbbb' })],
    {},
    later(1)
  );

  assert.strictEqual(second.actionable, 0);
  assert.strictEqual(second.findings.baseline.length, 1, 'the new URL starts fresh');
  assert.deepStrictEqual(
    Object.keys(second.snapshot.entries),
    ['https://vendor.example/widgets-v2'],
    'and the old key is pruned'
  );
});

test('an outstanding finding survives a run that could not reach the host', () => {
  const first = run(
    snapshotWith(
      URL_A,
      settled({ pending: watched('redirected', { finalUrl: 'https://vendor.example/', hash: 'bbbb' }) })
    ),
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })]
  );
  assert.strictEqual(first.actionable, 1, 'confirmed before the host went down');

  const outage = run(
    first.snapshot,
    [webEntry({ status: 'unchecked', detail: 'HEAD timed out after 20s' })],
    {},
    later(1)
  );

  assert.strictEqual(outage.findings.unchecked.length, 1, 'the outage is reported as one');
  assert.strictEqual(
    outage.actionable,
    1,
    'one bad morning at one host must not close the report issue'
  );
  assert.ok(outage.body.includes('could not be rechecked this run'));
  assert.deepStrictEqual(
    outage.snapshot.entries[URL_A],
    first.snapshot.entries[URL_A],
    'and the held record, pending block included, is untouched'
  );
});

// --- A difference has to hold still to count --------------------------
// Vendor hosts answer differently depending on where the runner egressed
// from: /product becomes /en-us/product one month and /en-gb/product the
// next. Reporting the first sighting would file a fresh finding every month
// forever and teach everyone to skim past this report.

test('a first sighting is watched, not reported', () => {
  const first = run(snapshotWith(URL_A, settled()), [
    webEntry({ finalUrl: 'https://vendor.example/en-us/products/widget' }),
  ]);

  assert.strictEqual(first.findings.watching.length, 1);
  assert.strictEqual(first.findings.redirected.length, 0);
  assert.strictEqual(first.actionable, 0, 'one sighting must not open an issue');
  assert.ok(first.body.includes('Seen once, watching'));
  assert.ok(first.body.includes('**No action implied.**'));
  assert.strictEqual(first.snapshot.entries[URL_A].pending.seen, 1);
});

test('a destination that flip-flops never becomes a finding', () => {
  // The locale the runner gets differs run to run. Twelve months of it must
  // produce nothing actionable, ever.
  const locales = ['en-us', 'en-gb', 'de-de'];
  let snapshot = snapshotWith(URL_A, settled());

  for (let month = 0; month < 12; month += 1) {
    const result = run(
      snapshot,
      [webEntry({ finalUrl: `https://vendor.example/${locales[month % 3]}/products/widget` })],
      {},
      later(month)
    );
    assert.strictEqual(result.actionable, 0, `month ${month} must stay quiet`);
    assert.strictEqual(result.findings.redirected.length, 0);
    assert.strictEqual(snapshot.entries[URL_A].pending?.seen ?? 1, 1);
    snapshot = result.snapshot;
  }
});

test('a stable redirect is confirmed even while the page body moves', () => {
  // Confirmation looks at the axis that produced the finding. Comparing
  // both would let an ordinary live page, whose body shifts a little each
  // month, keep resetting a redirect that has not moved at all.
  const first = run(snapshotWith(URL_A, settled()), [
    webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' }),
  ]);
  const second = run(
    first.snapshot,
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'cccc' })],
    {},
    later(1)
  );

  assert.strictEqual(second.findings.redirected.length, 1);
  assert.strictEqual(second.actionable, 1);
});

test('confirmation takes exactly the documented number of runs', () => {
  let snapshot = snapshotWith(URL_A, settled());
  for (let sighting = 1; sighting < CONFIRM_RUNS; sighting += 1) {
    const result = run(
      snapshot,
      [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })],
      {},
      later(sighting)
    );
    assert.strictEqual(result.actionable, 0);
    snapshot = result.snapshot;
  }

  const confirmed = run(
    snapshot,
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })],
    {},
    later(CONFIRM_RUNS)
  );
  assert.strictEqual(confirmed.actionable, 1);
});

test('an unconfirmed sighting does not hold the report issue open', () => {
  // Only confirmed findings survive a host outage. A single anomalous
  // reading is not something to keep an issue open over.
  const first = run(snapshotWith(URL_A, settled()), [
    webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' }),
  ]);

  const outage = run(
    first.snapshot,
    [webEntry({ status: 'unchecked', detail: 'HEAD timed out after 20s' })],
    {},
    later(1)
  );
  assert.strictEqual(outage.actionable, 0);
});

// --- Acknowledging ----------------------------------------------------

test('an acknowledgement clears the finding and adopts the new baseline', () => {
  const first = run(
    snapshotWith(
      URL_A,
      settled({
        pending: watched('redirected', {
          finalUrl: 'https://vendor.example/widgets-v2',
          hash: 'bbbb',
          since: '2026-09-17',
        }),
      })
    ),
    [webEntry({ finalUrl: 'https://vendor.example/widgets-v2', hash: 'bbbb' })]
  );
  assert.strictEqual(first.actionable, 1);

  const acks = { [URL_A]: { reviewed: '2026-09-20', note: 'Renamed line; still accurate.' } };
  const second = run(
    first.snapshot,
    [webEntry({ finalUrl: 'https://vendor.example/widgets-v2', hash: 'bbbb' })],
    acks,
    later(1)
  );

  assert.strictEqual(second.actionable, 0);
  assert.strictEqual(second.findings.acknowledged.length, 1);
  assert.ok(second.body.includes('Signed off since the last run'));

  const record = second.snapshot.entries[URL_A];
  assert.strictEqual(record.finalUrl, 'https://vendor.example/widgets-v2');
  assert.strictEqual(record.hash, 'bbbb');
  assert.strictEqual(record.pending, undefined);
  assert.strictEqual(
    record.lastChanged,
    ymd(later(1)),
    'the stability clock restarts, so a later change is a new finding'
  );
});

test('a page that changes again after being signed off is reported again', () => {
  const acks = { [URL_A]: { reviewed: '2026-09-17' } };
  const signedOff = run(
    snapshotWith(URL_A, settled({ pending: watched('changed', { hash: 'bbbb' }) })),
    [webEntry({ hash: 'bbbb' })],
    acks
  );
  assert.strictEqual(signedOff.actionable, 0);
  assert.strictEqual(signedOff.findings.acknowledged.length, 1);

  // Two years on, with the sign-off still sitting in the file, the page
  // changes again. The old date must not cover the new finding.
  const watching = run(
    signedOff.snapshot,
    [webEntry({ hash: 'cccc' })],
    acks,
    later(STABLE_MONTHS + 2)
  );
  assert.strictEqual(watching.findings.watching.length, 1, 'a new sighting, watched first');

  const again = run(
    watching.snapshot,
    [webEntry({ hash: 'cccc' })],
    acks,
    later(STABLE_MONTHS + 3)
  );
  assert.strictEqual(again.findings.changed.length, 1);
  assert.strictEqual(again.actionable, 1, 'the spent sign-off must not cover it');
});

test('an acknowledgement older than the finding does not apply', () => {
  assert.strictEqual(acknowledges({ reviewed: '2026-01-01' }, '2026-06-01', NOW), false);
  assert.strictEqual(acknowledges({ reviewed: '2026-06-01' }, '2026-06-01', NOW), true);
  assert.strictEqual(acknowledges({ reviewed: '2026-08-01' }, '2026-06-01', NOW), true);
});

test('a future-dated acknowledgement is ignored', () => {
  // A typo in the year would otherwise mute an entry until that year
  // arrives, and nobody would ever notice it had.
  assert.strictEqual(acknowledges({ reviewed: '2027-01-01' }, '2026-06-01', NOW), false);

  const findings = classify(
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })],
    snapshotWith(
      URL_A,
      settled({ pending: watched('redirected', { finalUrl: 'https://vendor.example/', hash: 'bbbb' }) })
    ),
    { [URL_A]: { reviewed: '2126-01-01' } },
    NOW
  );
  assert.strictEqual(findings.redirected.length, 1);
  assert.strictEqual(findings.acknowledged.length, 0);
});

test('a malformed acknowledgement is ignored rather than trusted', () => {
  for (const ack of [null, {}, { reviewed: 'last tuesday' }, { reviewed: 20260917 }]) {
    assert.strictEqual(acknowledges(ack, '2026-06-01', NOW), false);
  }
});

test('a spent acknowledgement is reported so it can be deleted', () => {
  const findings = classify(
    [webEntry()],
    snapshotWith(URL_A, settled({ lastChanged: monthsAgo(3) })),
    {
      [URL_A]: { reviewed: '2026-09-01' },
      'https://removed.example/gone': { reviewed: '2026-09-01' },
    },
    NOW
  );

  assert.strictEqual(findings.staleAcks.length, 2);
  assert.ok(findings.staleAcks.some((a) => /no longer in README/.test(a.reason)));
  assert.ok(findings.staleAcks.some((a) => /nothing outstanding/.test(a.reason)));

  const { body, actionable } = render(findings, { web: 1 });
  assert.strictEqual(actionable, 0, 'housekeeping is not a finding');
  assert.ok(body.includes('Acknowledgements that can be removed'));
});

test('a sign-off is not called spent just because the host was down', () => {
  const held = settled({ pending: { since: '2026-09-01', finalUrl: 'https://vendor.example/', hash: 'bbbb' } });
  const findings = classify(
    [webEntry({ status: 'unchecked', detail: 'HEAD timed out after 20s' })],
    snapshotWith(URL_A, held),
    { [URL_A]: { reviewed: '2026-09-15' } },
    NOW
  );

  assert.strictEqual(findings.staleAcks.length, 0);
});

test('the report tells a maintainer exactly how to sign a finding off', () => {
  const findings = classify(
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })],
    snapshotWith(
      URL_A,
      settled({ pending: watched('redirected', { finalUrl: 'https://vendor.example/', hash: 'bbbb' }) })
    ),
    {},
    NOW
  );
  const { body } = render(findings, { web: 1 });

  assert.ok(body.includes('web-health-acknowledged.json'));
  assert.ok(body.includes('"reviewed"'));
  assert.ok(body.includes(`"${URL_A}"`), 'and names the entry, so it can be pasted');
  assert.ok(
    body.includes('do **not** disappear on their own'),
    'the persistence is the point, and it should be stated'
  );
});

test('the acknowledgement file is read, never written', () => {
  const missing = loadAcknowledgements(path.join(os.tmpdir(), 'no-acks-here.json'));
  assert.strictEqual(missing.ok, true);
  assert.deepStrictEqual(missing.acks, {});

  const file = path.join(os.tmpdir(), `web-health-acks-${process.pid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ acknowledged: { [URL_A]: { reviewed: '2026-09-01' } } })
  );
  try {
    const before = fs.readFileSync(file, 'utf8');
    const loaded = loadAcknowledgements(file);
    assert.strictEqual(loaded.acks[URL_A].reviewed, '2026-09-01');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.unlinkSync(file);
  }
});

test('an unparseable acknowledgement file reports findings rather than hiding them', () => {
  const file = path.join(os.tmpdir(), `web-health-bad-acks-${process.pid}.json`);
  fs.writeFileSync(file, '{ oops');
  try {
    const loaded = loadAcknowledgements(file);
    assert.strictEqual(loaded.ok, false);
    assert.deepStrictEqual(loaded.acks, {}, 'noisy is the safe direction here');
  } finally {
    fs.unlinkSync(file);
  }
});

test('the committed acknowledgement file starts empty and parses', () => {
  const loaded = loadAcknowledgements();
  assert.strictEqual(loaded.ok, true);
  assert.deepStrictEqual(loaded.acks, {}, 'nothing is signed off out of the box');
});

// --- Redirects --------------------------------------------------------

test('a redirect to the site homepage is called out as one', () => {
  const findings = classify(
    [webEntry({ finalUrl: 'https://vendor.example/' })],
    snapshotWith(
      URL_A,
      settled({ pending: watched('redirected', { finalUrl: 'https://vendor.example/' }) })
    ),
    {},
    NOW
  );

  assert.strictEqual(findings.redirected.length, 1);
  assert.strictEqual(findings.redirected[0].collapsed, true);

  const { body, actionable } = render(findings, { web: 1 });
  assert.strictEqual(actionable, 1);
  assert.ok(body.includes('Now redirects somewhere else'));
  assert.ok(body.includes('now the site homepage'));
  assert.ok(body.includes('README.md:42'), 'a finding should be locatable');
});

test('a redirect to a different host is reported', () => {
  const findings = classify(
    [webEntry({ finalUrl: 'https://acquirer.example/legacy/widget' })],
    snapshotWith(
      URL_A,
      settled({
        lastChanged: monthsAgo(6),
        firstSeen: monthsAgo(6),
        pending: watched('redirected', { finalUrl: 'https://acquirer.example/legacy/widget' }),
      })
    ),
    {},
    NOW
  );

  assert.strictEqual(findings.redirected.length, 1);
  assert.strictEqual(findings.redirected[0].collapsed, false);
  assert.strictEqual(findings.redirected[0].previousUrl, URL_A);
});

test('a redirect and a content change on one entry is one finding, not two', () => {
  // A page that has moved has almost always changed as well. Counting both
  // double-reports the entry and inflates the number the issue is opened on.
  const findings = classify(
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })],
    snapshotWith(
      URL_A,
      settled({ pending: watched('redirected', { finalUrl: 'https://vendor.example/', hash: 'bbbb' }) })
    ),
    {},
    NOW
  );

  assert.strictEqual(findings.redirected.length, 1);
  assert.strictEqual(findings.changed.length, 0);
  assert.strictEqual(render(findings, { web: 1 }).actionable, 1);
});

test('two pages that differ only in the query are different destinations', () => {
  // Both EUR-Lex entries in this list share a host and a path and differ
  // only in ?uri=CELEX%3A..., so ignoring the query entirely — which the
  // first version of sameDestination did, to absorb tracking parameters —
  // made a redirect from one legal act to another invisible.
  const celex = (id) => `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A${id}`;
  assert.strictEqual(sameDestination(celex('42021X0387'), celex('42021X0388')), false);

  const findings = classify(
    [webEntry({ url: celex('42021X0387'), finalUrl: celex('42021X0388') })],
    snapshotWith(
      celex('42021X0387'),
      settled({
        finalUrl: celex('42021X0387'),
        pending: watched('redirected', { finalUrl: celex('42021X0388') }),
      })
    ),
    {},
    NOW
  );
  assert.strictEqual(findings.redirected.length, 1);
});

test('a tracking parameter is still not a redirect', () => {
  // The reason the query was being ignored in the first place. Dropping
  // only the keys that identify the reader keeps both cases right.
  for (const junk of [
    'utm_source=cdn&utm_campaign=q3',
    'gclid=abc123',
    'fbclid=xyz',
    'ref=newsletter',
    '_ga=GA1.2.3',
  ]) {
    assert.ok(
      sameDestination(URL_A, `${URL_A}?${junk}`),
      `${junk} identifies the reader, not the page`
    );
  }

  // Order and additions on the content-bearing side still count.
  assert.ok(sameDestination(`${URL_A}?a=1&b=2`, `${URL_A}?b=2&a=1`));
  assert.strictEqual(sameDestination(`${URL_A}?a=1`, `${URL_A}?a=2`), false);
});

test('a redirect to the same page is not reported', () => {
  const cases = [
    ['http://vendor.example/products/widget', URL_A],
    [URL_A, 'https://www.vendor.example/products/widget'],
    [URL_A, 'https://vendor.example/products/widget/'],
    [URL_A, 'https://vendor.example/products/widget?utm_source=cdn'],
    [URL_A, 'https://vendor.example/products/widget#overview'],
  ];

  for (const [before, after] of cases) {
    assert.ok(
      sameDestination(before, after),
      `${before} → ${after} is the same destination, not decay`
    );

    const findings = classify(
      [webEntry({ finalUrl: after })],
      snapshotWith(URL_A, settled({ finalUrl: before, lastChanged: monthsAgo(6) })),
      {},
      NOW
    );
    assert.strictEqual(findings.redirected.length, 0, `${before} → ${after}`);
  }
});

// --- Content change ---------------------------------------------------

test('a change after a long stretch of stability is flagged for a recheck', () => {
  const findings = classify(
    [webEntry({ hash: 'bbbb' })],
    snapshotWith(
      URL_A,
      settled({
        lastChanged: monthsAgo(STABLE_MONTHS + 6),
        pending: watched('changed', { hash: 'bbbb' }),
      })
    ),
    {},
    NOW
  );

  assert.strictEqual(findings.changed.length, 1);
  assert.strictEqual(findings.quiet.length, 0, 'it changed, so it is not quiet');

  const { body } = render(findings, { web: 1 });
  assert.ok(body.includes('Changed after a long stretch of stability'));
  assert.ok(body.includes('**Not an error.**'));
  assert.ok(body.includes('Recheck the description'));
});

test('a change on a page that churns anyway is not reported', () => {
  const churny = settled({ lastChanged: monthsAgo(2) });
  const { findings, snapshot, actionable } = run(snapshotWith(URL_A, churny), [
    webEntry({ hash: 'bbbb' }),
  ]);

  assert.strictEqual(findings.changed.length, 0);
  assert.strictEqual(actionable, 0);
  assert.strictEqual(
    snapshot.entries[URL_A].hash,
    'bbbb',
    'and with nothing outstanding the baseline does advance'
  );
  assert.strictEqual(snapshot.entries[URL_A].lastChanged, '2026-09-17');
});

test('an unchanged page updates lastChecked but keeps lastChanged', () => {
  const { snapshot } = run(snapshotWith(URL_A, settled()), [webEntry()]);
  const record = snapshot.entries[URL_A];

  assert.strictEqual(record.lastChanged, monthsAgo(30));
  assert.strictEqual(record.lastChecked, '2026-09-17');
  assert.strictEqual(record.firstSeen, monthsAgo(30));
});

test('an entry dropped from the README is pruned from the snapshot', () => {
  const snapshot = {
    entries: {
      [URL_A]: settled({ lastChanged: monthsAgo(1) }),
      'https://removed.example/gone': { hash: 'bbbb', lastChanged: monthsAgo(1) },
    },
  };

  const next = updateSnapshot(snapshot, [webEntry()], {}, NOW);
  assert.deepStrictEqual(Object.keys(next.entries), [URL_A]);
});

test('the snapshot is written with sorted keys so its diffs stay readable', () => {
  const next = updateSnapshot(
    { entries: {} },
    [webEntry({ url: 'https://z.example/one' }), webEntry({ url: 'https://a.example/two' })],
    {},
    NOW
  );

  const file = path.join(os.tmpdir(), `web-health-write-${process.pid}.json`);
  try {
    writeSnapshot(next, file);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'), 'files end with a newline');
    assert.deepStrictEqual(Object.keys(JSON.parse(raw).entries), [
      'https://a.example/two',
      'https://z.example/one',
    ]);
    assert.match(
      JSON.parse(raw).note,
      /web-health-acknowledged\.json/,
      'the file should say where a human is supposed to write instead'
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// --- Comparing when there is nothing to compare -----------------------

test('a fingerprint that cannot be compared is never a change', () => {
  assert.strictEqual(compare({ hash: 'a' }, { hash: 'a' }), 'same');
  assert.strictEqual(compare({ hash: 'a' }, { hash: 'b' }), 'different');
  assert.strictEqual(compare({ etag: 'W/"1"' }, { etag: 'W/"1"' }), 'same');
  assert.strictEqual(compare({ hash: 'a' }, { etag: 'W/"1"' }), 'unknown');
  assert.strictEqual(compare(null, { hash: 'a' }), 'unknown');

  // A host that stops offering ETag must not read as a rewritten page.
  const findings = classify(
    [webEntry({ hash: null, etag: null, lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' })],
    snapshotWith(URL_A, settled({ hash: null, etag: 'W/"abc"' })),
    {},
    NOW
  );
  assert.strictEqual(findings.changed.length, 0);
  assert.strictEqual(
    findings.quiet.length,
    0,
    'and "I could not compare" must not be rendered as "unchanged for two years"'
  );
});

// --- Quiet, and the restraint it demands ------------------------------

test('a page that has not moved in years is context, never a finding', () => {
  const findings = classify(
    [webEntry()],
    snapshotWith(URL_A, settled({ lastChanged: monthsAgo(QUIET_MONTHS + 12) })),
    {},
    NOW
  );
  assert.strictEqual(findings.quiet.length, 1);

  const { body, actionable } = render(findings, { web: 1 });
  assert.strictEqual(actionable, 0, 'quiet must never count as needing a decision');
  assert.ok(body.includes('**No action implied.**'));
  assert.ok(body.includes('Quiet is not unmaintained.'));
  assert.ok(!body.includes('Now redirects somewhere else'));
});

// --- GitLab -----------------------------------------------------------

test('an archived GitLab project without the marker needs one', () => {
  const findings = classify([gitlabEntry({ archived: true })], { entries: {} }, {}, NOW);
  assert.strictEqual(findings.needsMarker.length, 1);
  assert.strictEqual(findings.staleMarker.length, 0);
});

test('an archived GitLab project that already has the marker is not reported', () => {
  const findings = classify(
    [gitlabEntry({ archived: true, hasArchivedMarker: true })],
    { entries: {} },
    {},
    NOW
  );
  assert.strictEqual(findings.needsMarker.length, 0);
  assert.strictEqual(findings.staleMarker.length, 0);
});

test('an unarchived GitLab project still carrying the marker is reported', () => {
  const findings = classify([gitlabEntry({ hasArchivedMarker: true })], { entries: {} }, {}, NOW);
  assert.strictEqual(findings.staleMarker.length, 1);
});

test('a renamed GitLab project is reported as moved', () => {
  const findings = classify(
    [gitlabEntry({ fullName: 'peachtech/peach-fuzzer' })],
    { entries: {} },
    {},
    NOW
  );
  assert.strictEqual(findings.renamed.length, 1);

  const { body } = render(findings, { gitlab: 1 });
  assert.ok(body.includes('## Moved'));
  assert.ok(body.includes('peachtech/peach-fuzzer'));
});

test('a rename differing only in case is not a finding', () => {
  const findings = classify(
    [gitlabEntry({ fullName: 'PeachTech/Peach-Fuzzer-Community' })],
    { entries: {} },
    {},
    NOW
  );
  assert.strictEqual(findings.renamed.length, 0);
});

test('a long-dormant GitLab project is quiet, not a problem', () => {
  const findings = classify(
    [gitlabEntry({ pushedAt: new Date(NOW.getTime() - (QUIET_MONTHS + 6) * MONTH).toISOString() })],
    { entries: {} },
    {},
    NOW
  );
  assert.strictEqual(findings.quiet.length, 1);
  assert.strictEqual(render(findings, { gitlab: 1 }).actionable, 0);
});

test('a GitLab entry is not written into the page snapshot', () => {
  // The API is the record for those; a half-filled snapshot row would only
  // give reconcile() something meaningless to compare next month.
  const next = updateSnapshot({ entries: {} }, [gitlabEntry()], {}, NOW);
  assert.deepStrictEqual(next.entries, {});
});

test('a GitLab 404 is only "gone" once the link itself has stopped resolving', async () => {
  const seen = [];
  const result = await lookupGitLab(gitlabEntry(), async (url, opts = {}) => {
    seen.push({ url, method: opts.method || 'GET' });
    return response({ status: 404, url });
  });

  assert.strictEqual(result.status, 'missing');
  assert.strictEqual(seen.length, 2, 'the API 404 is confirmed against the link');
});

test('a GitLab 404 on a link that still resolves is unchecked, not a finding', async () => {
  const result = await lookupGitLab(gitlabEntry(), async (url) =>
    response({ status: url.includes('/api/v4/') ? 404 : 200, url })
  );

  assert.strictEqual(result.status, 'unchecked');
  assert.match(result.detail, /still resolves/);

  const findings = classify([result], { entries: {} }, {}, NOW);
  assert.strictEqual(findings.missing.length, 0, 'a guess about URL shape is not a 404');
  assert.strictEqual(findings.unchecked.length, 1);
});

test('GitLab auth and rate-limit responses become unchecked, not findings', async () => {
  for (const status of [401, 403, 429, 500, 502]) {
    const result = await lookupGitLab(gitlabEntry(), async () => response({ status }));
    assert.strictEqual(result.status, 'unchecked', `HTTP ${status} must be unchecked`);

    const findings = classify([result], { entries: {} }, {}, NOW);
    assert.strictEqual(findings.missing.length, 0, `HTTP ${status} is not a 404`);
    assert.strictEqual(findings.unchecked.length, 1);
  }
});

test('a GitLab network exception is unchecked, not a missing project', async () => {
  const result = await lookupGitLab(gitlabEntry(), async () => {
    throw new Error('ECONNRESET');
  });
  assert.strictEqual(result.status, 'unchecked');
  assert.match(result.detail, /ECONNRESET/);
});

test('a GitLab project reads archived, name and activity off the API', async () => {
  const result = await lookupGitLab(gitlabEntry(), async () =>
    response({
      status: 200,
      body: JSON.stringify({
        archived: true,
        path_with_namespace: 'peachtech/peach-fuzzer',
        last_activity_at: '2021-04-02T10:00:00.000Z',
      }),
    })
  );

  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.archived, true);
  assert.strictEqual(result.fullName, 'peachtech/peach-fuzzer');
  assert.strictEqual(result.pushedAt, '2021-04-02T10:00:00.000Z');
});

// --- The failure that matters ----------------------------------------

test('a timeout is recorded as unchecked, not as a finding', async () => {
  const result = await probe(webEntry(), async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
  });

  assert.strictEqual(result.status, 'unchecked');
  assert.match(result.detail, /timed out/);

  const findings = classify([result], snapshotWith(URL_A, settled()), {}, NOW);

  assert.strictEqual(findings.redirected.length, 0);
  assert.strictEqual(findings.changed.length, 0);
  assert.strictEqual(findings.unchecked.length, 1);

  const { body, actionable } = render(findings, { web: 1 });
  assert.strictEqual(actionable, 0);
  assert.ok(body.includes('Could not be checked'));
  assert.ok(!body.includes('Now redirects somewhere else'));
});

test('a 5xx, a bot wall and a 404 are all unchecked rather than findings', async () => {
  for (const status of [403, 404, 410, 429, 500, 503]) {
    const result = await probe(webEntry(), async (url) => response({ status, url }));
    assert.strictEqual(result.status, 'unchecked', `HTTP ${status} must be unchecked`);
    assert.match(result.detail, new RegExp(String(status)));

    const findings = classify([result], { entries: {} }, {}, NOW);
    assert.strictEqual(findings.baseline.length, 0, 'and it is not a baseline either');
    assert.strictEqual(findings.unchecked.length, 1);
  }
});

test('an unchecked entry keeps the snapshot record it already had', () => {
  const prior = settled();
  const next = updateSnapshot(
    snapshotWith(URL_A, prior),
    [webEntry({ status: 'unchecked', detail: 'HEAD timed out after 20s' })],
    {},
    NOW
  );

  assert.deepStrictEqual(
    next.entries[URL_A],
    prior,
    'dropping it would reset the baseline and hide a real change'
  );
});

// --- HEAD, and the GET fallback ---------------------------------------

test('HEAD alone is enough when the server offers a validator', async () => {
  const calls = [];
  const result = await probe(webEntry(), async (url, opts) => {
    calls.push(opts.method);
    return response({
      status: 200,
      url,
      headers: { ETag: 'W/"abc123"', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    });
  });

  assert.deepStrictEqual(calls, ['HEAD'], 'no body is fetched when one is not needed');
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.etag, 'W/"abc123"');
  assert.strictEqual(result.hash, null);
});

test('a host that rejects HEAD falls back to GET', async () => {
  const calls = [];
  const result = await probe(webEntry(), async (url, opts) => {
    calls.push(opts.method);
    if (opts.method === 'HEAD') return response({ status: 405, url });
    return response({ status: 200, url, body: '<p>Still here.</p>' });
  });

  assert.deepStrictEqual(calls, ['HEAD', 'GET']);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.hash, hashBody('<p>Still here.</p>'));
});

test('a HEAD with no validator falls back to GET so there is something to compare', async () => {
  const calls = [];
  const result = await probe(webEntry(), async (url, opts) => {
    calls.push(opts.method);
    return response({ status: 200, url, body: '<p>Still here.</p>' });
  });

  assert.deepStrictEqual(calls, ['HEAD', 'GET']);
  assert.ok(result.hash, 'without a hash the next run would have nothing to diff');
});

test('a recorded body hash survives a host that starts answering HEAD with an ETag', async () => {
  // probe() stops fetching the body once a validator is on offer, so it
  // returns hash: null. Writing that null in would throw the recorded hash
  // away for good, and if the ETag later disappeared there would be nothing
  // left to compare on either axis — the entry would be silently unchecked
  // from then on.
  const prior = settled({ hash: 'HHH', etag: null });
  const behindCdn = webEntry({ hash: null, etag: '"E1"' });

  const next = updateSnapshot(snapshotWith(URL_A, prior), [behindCdn], {}, NOW);
  assert.strictEqual(next.entries[URL_A].hash, 'HHH', 'the baseline is kept, not erased');
  assert.strictEqual(next.entries[URL_A].etag, '"E1"');

  // And when the ETag says the page has moved on, the old hash is stale.
  // On the path that accepts a new baseline it must be dropped, or it would
  // fire a spurious change the next time a body is actually fetched. (While
  // a finding is outstanding nothing is accepted, so the whole record —
  // stale hash included — is held as it was; that is covered above.)
  const moved = updateSnapshot(
    snapshotWith(URL_A, settled({ hash: 'HHH', etag: '"E0"', lastChanged: monthsAgo(2) })),
    [webEntry({ hash: null, etag: '"E1"' })],
    {},
    NOW
  );
  assert.strictEqual(moved.entries[URL_A].hash, null);
  assert.strictEqual(moved.entries[URL_A].etag, '"E1"');
});

test('the GET failure is what gets reported, not a harmless HEAD refusal', async () => {
  // Plenty of hosts refuse HEAD; that is expected and says nothing. Naming
  // "HEAD returned HTTP 405" when the GET actually timed out points a
  // maintainer at the wrong problem.
  const result = await probe(webEntry(), async (url, opts) => {
    if (opts.method === 'HEAD') return response({ status: 405, url });
    throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  });

  assert.strictEqual(result.status, 'unchecked');
  assert.match(result.detail, /GET timed out/);
  assert.doesNotMatch(result.detail, /405/);
});

test('the final URL after redirects is what gets recorded', async () => {
  const result = await probe(webEntry(), async () =>
    response({ status: 200, url: 'https://vendor.example/', body: '<p>Home</p>' })
  );

  assert.strictEqual(result.finalUrl, 'https://vendor.example/');
  assert.notStrictEqual(result.finalUrl, result.url);
});

test('the run sends a descriptive User-Agent on every request', async () => {
  const agents = [];
  await probe(webEntry(), async (url, opts) => {
    agents.push(opts.headers['User-Agent']);
    return response({ status: 200, url, body: 'x' });
  });

  assert.ok(agents.length > 0);
  for (const agent of agents) {
    assert.match(agent, /awesome-embedded-security-web-health/);
  }
});

test('a run mixing successes and failures keeps them apart', async () => {
  const entries = [
    webEntry({ url: 'https://ok.example/a', status: undefined }),
    webEntry({ url: 'https://dead.example/b', status: undefined }),
    gitlabEntry({ status: undefined }),
  ];

  const results = await checkAll(entries, async (url) => {
    if (url.includes('dead.example')) throw new Error('ENOTFOUND');
    if (url.includes('/api/v4/')) {
      return response({
        status: 200,
        body: JSON.stringify({
          archived: false,
          path_with_namespace: 'peachtech/peach-fuzzer-community',
          last_activity_at: new Date(NOW.getTime() - MONTH).toISOString(),
        }),
      });
    }
    return response({ status: 200, url, body: '<p>Fine</p>' });
  });

  assert.strictEqual(results.length, 3);
  assert.strictEqual(results.filter((r) => r.status === 'ok').length, 2);
  assert.strictEqual(results.filter((r) => r.status === 'unchecked').length, 1);

  const findings = classify(results, { entries: {} }, {}, NOW);
  assert.strictEqual(findings.unchecked.length, 1);
  assert.strictEqual(findings.missing.length, 0);
});

// --- Rendering --------------------------------------------------------

test('a clean list renders as nothing to do', () => {
  const findings = classify(
    [webEntry()],
    snapshotWith(URL_A, settled({ lastChanged: monthsAgo(3), firstSeen: monthsAgo(3) })),
    {},
    NOW
  );
  const { body, actionable } = render(findings, { web: 1 });

  assert.strictEqual(actionable, 0);
  assert.ok(body.includes('Nothing needs doing'));
});

test('the summary line says what was checked and what was left to the other checker', () => {
  const { body } = render(classify([], { entries: {} }, {}, NOW), {
    github: 152,
    gitlab: 1,
    web: 88,
    ignored: 4,
  });

  assert.ok(body.includes('89 non-GitHub entries'));
  assert.ok(body.includes('152 GitHub-hosted entries'));
  assert.ok(body.includes('4 are on hosts'));
});

test('actionable findings are counted and rendered under their headings', () => {
  const findings = classify(
    [
      gitlabEntry({ name: 'Moved', fullName: 'other/place' }),
      gitlabEntry({ name: 'Archived', archived: true }),
      webEntry({ name: 'Redirected', finalUrl: 'https://elsewhere.example/' }),
    ],
    snapshotWith(
      URL_A,
      settled({
        lastChanged: monthsAgo(6),
        firstSeen: monthsAgo(6),
        pending: watched('redirected', { finalUrl: 'https://elsewhere.example/' }),
      })
    ),
    {},
    NOW
  );

  const { body, actionable } = render(findings, { gitlab: 2, web: 1 });
  assert.strictEqual(actionable, 3);
  assert.ok(body.includes('## Moved'));
  assert.ok(body.includes('missing the 🗄️ marker'));
  assert.ok(body.includes('## Now redirects somewhere else'));
  assert.ok(!body.includes('Nothing needs doing'));
});

// --- Filing the issue -------------------------------------------------
// The only part that writes to the repository. Each branch is pinned, and
// in particular the issue this script owns must be distinct from the one
// check-staleness.js owns — two monthly runs overwriting one body would
// erase each other's findings.

function issueHarness(t, { existingIssue, listStatus = 200, issueState = 'open' }) {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const realExitCode = process.exitCode;
  const calls = [];

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });

    if (method === 'GET') {
      return {
        status: listStatus,
        ok: listStatus >= 200 && listStatus < 300,
        json: async () =>
          existingIssue
            ? [
                { number: 7, state: 'open', body: '<!-- entry-health-report -->\nthe other check' },
                { number: 99, state: issueState, body: '<!-- web-health-report -->\nprevious' },
              ]
            : [{ number: 7, state: 'open', body: '<!-- entry-health-report -->\nthe other check' }],
      };
    }
    return {
      status: method === 'POST' ? 201 : 200,
      ok: true,
      json: async () => ({ number: 123 }),
    };
  };

  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';

  t.after(() => {
    global.fetch = realFetch;
    process.env = realEnv;
    process.exitCode = realExitCode;
  });

  return calls;
}

test('an all-clear with no open report files nothing at all', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Nothing needs doing', 0);

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'a clean list must not open an issue'
  );
});

test('an all-clear closes the report that was already open', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Nothing needs doing', 0);

  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write, 'the open report should be updated');
  assert.strictEqual(write.body.state, 'closed');
  assert.ok(write.url.endsWith('/issues/99'));
});

test('an unresolved finding keeps the issue open on the following run', async (t) => {
  // The end of the chain the persistence tests above start: findings that
  // survive produce a non-zero count, and a non-zero count is what stops
  // reportIssue closing the report nobody has read.
  const first = run(snapshotWith(URL_A, settled()), [
    webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' }),
  ]);
  const second = run(
    first.snapshot,
    [webEntry({ finalUrl: 'https://vendor.example/', hash: 'bbbb' })],
    {},
    later(1)
  );

  const calls = issueHarness(t, { existingIssue: true });
  await reportIssue(second.body, second.actionable);

  const write = calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(write.body.state, 'open', 'nobody has looked at it yet');
  assert.ok(write.body.body.includes('Now redirects somewhere else'));
});

test('findings with no open report open one under this check’s own title', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Now redirects somewhere else\n\n- **Widget**', 1);

  const write = calls.find((c) => c.method === 'POST');
  assert.ok(write, 'a new report should be opened');
  assert.strictEqual(write.body.title, 'Web entry health report');
  assert.ok(write.body.body.includes('<!-- web-health-report -->'));
});

test('the entry health report is never mistaken for this one', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Now redirects somewhere else', 1);

  // The harness always returns check-staleness.js's open issue. Patching it
  // would wipe that report and leave both checks fighting over one body.
  assert.strictEqual(
    calls.filter((c) => c.method === 'PATCH').length,
    0,
    'the other check’s issue must be left alone'
  );
});

test('findings rewrite the open report rather than opening a second', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Now redirects somewhere else', 1);

  assert.strictEqual(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'a monthly run must not pile up issues'
  );

  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write);
  assert.strictEqual(write.body.state, 'open');
  assert.ok(write.body.body.includes('Now redirects somewhere else'));
});

test('the marker the run uses to find its own issue is always written', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Now redirects somewhere else', 1);

  const write = calls.find((c) => c.method === 'POST');
  assert.ok(
    write.body.body.startsWith('<!-- web-health-report -->'),
    'without the marker the next run cannot find this issue and would open another'
  );
});

test('a report that closed itself is reopened rather than duplicated', async (t) => {
  // This report can close itself and later have something to say again.
  // Looking only at the open issues would leave the closed one behind and
  // open a second, scattering across two issues the comment thread a
  // maintainer wrote — the one part of an issue this script never rewrites.
  const calls = issueHarness(t, { existingIssue: true, issueState: 'closed' });

  await reportIssue('## Now redirects somewhere else', 1);

  assert.strictEqual(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'a closed report is not a reason to open a new one'
  );
  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write.url.endsWith('/issues/99'));
  assert.strictEqual(write.body.state, 'open');

  const list = calls.find((c) => c.method === 'GET');
  assert.match(list.url, /state=all/, 'closed reports have to be visible to be found');
});

test('an all-clear does not rewrite a report that is already closed', async (t) => {
  const calls = issueHarness(t, { existingIssue: true, issueState: 'closed' });

  await reportIssue('## Nothing needs doing', 0);

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'telling a closed issue that it is still closed is just noise'
  );
});

test('a failed issue listing is not read as proof that no issue exists', async (t) => {
  // Inherited from check-staleness.js, which does `if (!response.ok) return
  // null`. A 500 or a rate limit then looks identical to "no open report",
  // and the run opens a duplicate beside the one already there.
  for (const status of [403, 429, 500, 502]) {
    const found = await findExistingIssue('owner', 'repo', async () =>
      response({ status })
    );
    assert.strictEqual(found.state, 'unknown', `HTTP ${status} is not an answer`);
  }

  const calls = issueHarness(t, { existingIssue: false, listStatus: 500 });
  await reportIssue('## Now redirects somewhere else', 1);

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'not knowing means posting nothing, not posting a duplicate'
  );
  assert.strictEqual(process.exitCode, 1, 'and it should be visible in CI');
});

test('a network failure listing issues is also not an answer', async () => {
  const found = await findExistingIssue('owner', 'repo', async () => {
    throw new Error('ECONNRESET');
  });
  assert.strictEqual(found.state, 'unknown');
  assert.match(found.detail, /ECONNRESET/);
});

test('an empty issue list really does mean no open report', async () => {
  const found = await findExistingIssue('owner', 'repo', async () =>
    response({ status: 200, body: '[]' })
  );
  assert.strictEqual(found.state, 'none');
});
