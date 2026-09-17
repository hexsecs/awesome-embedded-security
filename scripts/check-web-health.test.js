#!/usr/bin/env node
// Tests for check-web-health.js, using node:test so nothing new is added to
// package.json. Run with `npm run test:web-health`.
//
// Everything here is offline: synthetic responses and fixture snapshots, no
// network at all. What is tested is everything that decides what a
// maintainer is told — and, above all, the two ways this script could do
// real damage.
//
// The first is noise. If body normalization does not strip the volatile
// parts of a page, every entry looks changed every month, the report
// becomes unreadable, and the signal is worth nothing. The second is a
// false positive: a timeout or a bot wall rendered as "this entry has
// moved" would send someone rewriting or deleting a live entry. A failure
// must always degrade to "unchecked".

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
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
  checkAll,
  classify,
  render,
  reportIssue,
  QUIET_MONTHS,
  STABLE_MONTHS,
} = require('./check-web-health.js');

const NOW = new Date('2026-09-17T00:00:00Z');
const MONTH = 1000 * 60 * 60 * 24 * 30.44;
const monthsAgo = (n) => new Date(NOW.getTime() - n * MONTH).toISOString().slice(0, 10);

// --- Helpers ----------------------------------------------------------

function webEntry(overrides = {}) {
  return {
    name: 'Example Vendor Tool',
    url: 'https://vendor.example/products/widget',
    host: 'vendor.example',
    kind: 'web',
    hasArchivedMarker: false,
    lineNo: 42,
    status: 'ok',
    method: 'GET',
    httpStatus: 200,
    finalUrl: 'https://vendor.example/products/widget',
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
  return { version: 1, entries: { [url]: record } };
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
  assert.ok(!isIgnored('https://vendor.example/products/widget', matchers));

  const entries = readEntries();
  const ignored = entries.filter((e) => e.kind === 'ignored');

  assert.ok(ignored.length > 0, 'the README has entries on those hosts');
  assert.ok(
    ignored.every((e) => e.kind !== 'web' && e.kind !== 'gitlab'),
    'an ignored host must never reach the network layer'
  );

  // And the skip must survive into the run: a blocked host that got probed
  // anyway would come back as a bot wall and read as a problem.
  const findings = classify(
    entries.filter((e) => e.kind === 'ignored').map((e) => ({ ...e, status: 'ok' })),
    { entries: {} },
    NOW
  );
  assert.strictEqual(findings.unchecked.length, 0);
});

test('a missing link config skips nothing rather than throwing', () => {
  const matchers = ignoreMatchers(path.join(os.tmpdir(), 'definitely-not-here.json'));
  assert.deepStrictEqual(matchers, []);
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

test('normalization still notices the content actually changing', () => {
  const before = '<html><body><p>Actively maintained JTAG probe.</p></body></html>';
  const after =
    '<html><body><p>This product has been discontinued.</p></body></html>';

  assert.notStrictEqual(hashBody(before), hashBody(after));
});

test('whitespace and reformatting alone are not a change', () => {
  assert.strictEqual(
    hashBody('<p>Hello</p>\n<p>World</p>'),
    hashBody('  <p>Hello</p>      <p>World</p>  ')
  );
});

// --- A first run ------------------------------------------------------

test('a first run with no prior snapshot is a baseline with zero findings', () => {
  const results = [webEntry(), webEntry({ name: 'Other', url: 'https://other.example/x' })];
  const findings = classify(results, { entries: {} }, NOW);
  const { body, actionable } = render(findings, { web: 2 });

  assert.strictEqual(actionable, 0, 'nothing can have changed on the first run');
  assert.strictEqual(findings.baseline.length, 2);
  assert.strictEqual(findings.redirected.length, 0);
  assert.strictEqual(findings.changed.length, 0);
  assert.ok(body.includes('Newly recorded'));
  assert.ok(body.includes('No action implied'));
  assert.ok(body.includes('Nothing needs doing'));
});

test('a first run records every checked entry in the snapshot', () => {
  const results = [webEntry(), webEntry({ name: 'Other', url: 'https://other.example/x' })];
  const next = updateSnapshot({ entries: {} }, results, NOW);

  assert.strictEqual(Object.keys(next.entries).length, 2);
  const record = next.entries['https://vendor.example/products/widget'];
  assert.strictEqual(record.hash, 'aaaa');
  assert.strictEqual(record.firstSeen, '2026-09-17');
  assert.strictEqual(record.lastChanged, '2026-09-17');
});

test('a missing or unreadable snapshot file loads as an empty baseline', () => {
  const empty = loadSnapshot(path.join(os.tmpdir(), 'no-such-snapshot.json'));
  assert.deepStrictEqual(empty.entries, {});

  const junk = path.join(os.tmpdir(), `web-health-junk-${process.pid}.json`);
  fs.writeFileSync(junk, 'not json at all');
  try {
    assert.deepStrictEqual(loadSnapshot(junk).entries, {});
  } finally {
    fs.unlinkSync(junk);
  }
});

// --- Redirects --------------------------------------------------------

test('a redirect to a different page is reported', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'aaaa',
    firstSeen: monthsAgo(30),
    lastChanged: monthsAgo(30),
  });

  const findings = classify(
    [webEntry({ finalUrl: 'https://vendor.example/' })],
    snapshot,
    NOW
  );

  assert.strictEqual(findings.redirected.length, 1);
  assert.strictEqual(findings.redirected[0].collapsed, true, 'collapsed to the homepage');

  const { body, actionable } = render(findings, { web: 1 });
  assert.strictEqual(actionable, 1);
  assert.ok(body.includes('Now redirects somewhere else'));
  assert.ok(body.includes('now the site homepage'));
  assert.ok(body.includes('README.md:42'), 'a finding should be locatable');
});

test('a redirect to a different host is reported', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'aaaa',
    firstSeen: monthsAgo(6),
    lastChanged: monthsAgo(6),
  });

  const findings = classify(
    [webEntry({ finalUrl: 'https://acquirer.example/legacy/widget' })],
    snapshot,
    NOW
  );

  assert.strictEqual(findings.redirected.length, 1);
  assert.strictEqual(findings.redirected[0].collapsed, false);
  assert.strictEqual(
    findings.redirected[0].previousUrl,
    'https://vendor.example/products/widget'
  );
});

test('a redirect to the same page is not reported', () => {
  const cases = [
    ['http://vendor.example/products/widget', 'https://vendor.example/products/widget'],
    ['https://vendor.example/products/widget', 'https://www.vendor.example/products/widget'],
    ['https://vendor.example/products/widget', 'https://vendor.example/products/widget/'],
    [
      'https://vendor.example/products/widget',
      'https://vendor.example/products/widget?utm_source=cdn',
    ],
    [
      'https://vendor.example/products/widget',
      'https://vendor.example/products/widget#overview',
    ],
  ];

  for (const [before, after] of cases) {
    assert.ok(
      sameDestination(before, after),
      `${before} → ${after} is the same destination, not decay`
    );

    const findings = classify(
      [webEntry({ finalUrl: after })],
      snapshotWith('https://vendor.example/products/widget', {
        finalUrl: before,
        hash: 'aaaa',
        firstSeen: monthsAgo(6),
        lastChanged: monthsAgo(6),
      }),
      NOW
    );
    assert.strictEqual(findings.redirected.length, 0, `${before} → ${after}`);
  }
});

// --- Content change ---------------------------------------------------

test('a change after a long stretch of stability is flagged for a recheck', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'old',
    firstSeen: monthsAgo(40),
    lastChanged: monthsAgo(STABLE_MONTHS + 6),
  });

  const findings = classify([webEntry({ hash: 'new' })], snapshot, NOW);

  assert.strictEqual(findings.changed.length, 1);
  assert.strictEqual(findings.quiet.length, 0, 'it changed, so it is not quiet');

  const { body } = render(findings, { web: 1 });
  assert.ok(body.includes('Changed after a long stretch of stability'));
  assert.ok(body.includes('**Not an error.**'));
  assert.ok(body.includes('Recheck the description'));
});

test('a change on a page that churns anyway is not reported', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'old',
    firstSeen: monthsAgo(40),
    lastChanged: monthsAgo(2),
  });

  const findings = classify([webEntry({ hash: 'new' })], snapshot, NOW);
  assert.strictEqual(findings.changed.length, 0);
});

test('an unchanged page updates lastChecked but keeps lastChanged', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'aaaa',
    firstSeen: monthsAgo(30),
    lastChanged: monthsAgo(30),
    lastChecked: monthsAgo(1),
  });

  const next = updateSnapshot(snapshot, [webEntry()], NOW);
  const record = next.entries['https://vendor.example/products/widget'];

  assert.strictEqual(record.lastChanged, monthsAgo(30));
  assert.strictEqual(record.lastChecked, '2026-09-17');
  assert.strictEqual(record.firstSeen, monthsAgo(30));
});

test('a changed page moves lastChanged forward', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'old',
    firstSeen: monthsAgo(30),
    lastChanged: monthsAgo(30),
  });

  const next = updateSnapshot(snapshot, [webEntry({ hash: 'new' })], NOW);
  assert.strictEqual(
    next.entries['https://vendor.example/products/widget'].lastChanged,
    '2026-09-17'
  );
});

test('an entry dropped from the README is pruned from the snapshot', () => {
  const snapshot = {
    entries: {
      'https://vendor.example/products/widget': { hash: 'aaaa', lastChanged: monthsAgo(1) },
      'https://removed.example/gone': { hash: 'bbbb', lastChanged: monthsAgo(1) },
    },
  };

  const next = updateSnapshot(snapshot, [webEntry()], NOW);
  assert.deepStrictEqual(Object.keys(next.entries), [
    'https://vendor.example/products/widget',
  ]);
});

test('the snapshot is written with sorted keys so its diffs stay readable', () => {
  const results = [
    webEntry({ url: 'https://z.example/one' }),
    webEntry({ url: 'https://a.example/two' }),
  ];
  const next = updateSnapshot({ entries: {} }, results, NOW);
  assert.deepStrictEqual(Object.keys(next.entries), [
    'https://a.example/two',
    'https://z.example/one',
  ]);

  const file = path.join(os.tmpdir(), `web-health-write-${process.pid}.json`);
  try {
    writeSnapshot(next, file);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.endsWith('\n'), 'files end with a newline');
    assert.deepStrictEqual(JSON.parse(raw).entries, next.entries);
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
    snapshotWith('https://vendor.example/products/widget', {
      finalUrl: 'https://vendor.example/products/widget',
      etag: 'W/"abc"',
      firstSeen: monthsAgo(30),
      lastChanged: monthsAgo(30),
    }),
    NOW
  );
  assert.strictEqual(findings.changed.length, 0);
  assert.strictEqual(findings.quiet.length, 0);
});

// --- Quiet, and the restraint it demands ------------------------------

test('a page that has not moved in years is context, never a finding', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'aaaa',
    firstSeen: monthsAgo(QUIET_MONTHS + 12),
    lastChanged: monthsAgo(QUIET_MONTHS + 12),
  });

  const findings = classify([webEntry()], snapshot, NOW);
  assert.strictEqual(findings.quiet.length, 1);

  const { body, actionable } = render(findings, { web: 1 });
  assert.strictEqual(actionable, 0, 'quiet must never count as needing a decision');
  assert.ok(body.includes('**No action implied.**'));
  assert.ok(body.includes('Quiet is not unmaintained.'));
  assert.ok(!body.includes('Now redirects somewhere else'));
});

// --- GitLab -----------------------------------------------------------

test('an archived GitLab project without the marker needs one', () => {
  const findings = classify([gitlabEntry({ archived: true })], { entries: {} }, NOW);
  assert.strictEqual(findings.needsMarker.length, 1);
  assert.strictEqual(findings.staleMarker.length, 0);
});

test('an archived GitLab project that already has the marker is not reported', () => {
  const findings = classify(
    [gitlabEntry({ archived: true, hasArchivedMarker: true })],
    { entries: {} },
    NOW
  );
  assert.strictEqual(findings.needsMarker.length, 0);
  assert.strictEqual(findings.staleMarker.length, 0);
});

test('an unarchived GitLab project still carrying the marker is reported', () => {
  const findings = classify(
    [gitlabEntry({ hasArchivedMarker: true })],
    { entries: {} },
    NOW
  );
  assert.strictEqual(findings.staleMarker.length, 1);
});

test('a renamed GitLab project is reported as moved', () => {
  const findings = classify(
    [gitlabEntry({ fullName: 'peachtech/peach-fuzzer' })],
    { entries: {} },
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
    NOW
  );
  assert.strictEqual(findings.renamed.length, 0);
});

test('a long-dormant GitLab project is quiet, not a problem', () => {
  const findings = classify(
    [gitlabEntry({ pushedAt: new Date(NOW.getTime() - (QUIET_MONTHS + 6) * MONTH).toISOString() })],
    { entries: {} },
    NOW
  );
  assert.strictEqual(findings.quiet.length, 1);
  assert.strictEqual(render(findings, { gitlab: 1 }).actionable, 0);
});

test('a GitLab 404 is only "gone" once the link itself has stopped resolving', async (t) => {
  const seen = [];
  const fakeFetch = async (url, opts = {}) => {
    seen.push({ url, method: opts.method || 'GET' });
    if (url.includes('/api/v4/')) return response({ status: 404 });
    return response({ status: 404, url });
  };

  const result = await lookupGitLab(gitlabEntry(), fakeFetch);
  assert.strictEqual(result.status, 'missing');
  assert.strictEqual(seen.length, 2, 'the API 404 is confirmed against the link');

  t.diagnostic('and the same 404 with a live link must not be a finding');
});

test('a GitLab 404 on a link that still resolves is unchecked, not a finding', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/api/v4/')) return response({ status: 404 });
    return response({ status: 200, url });
  };

  const result = await lookupGitLab(gitlabEntry(), fakeFetch);
  assert.strictEqual(result.status, 'unchecked');
  assert.match(result.detail, /still resolves/);

  const findings = classify([result], { entries: {} }, NOW);
  assert.strictEqual(findings.missing.length, 0, 'a guess about URL shape is not a 404');
  assert.strictEqual(findings.unchecked.length, 1);
});

test('GitLab auth and rate-limit responses become unchecked, not findings', async () => {
  for (const status of [401, 403, 429, 500, 502]) {
    const result = await lookupGitLab(gitlabEntry(), async () => response({ status }));
    assert.strictEqual(result.status, 'unchecked', `HTTP ${status} must be unchecked`);

    const findings = classify([result], { entries: {} }, NOW);
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
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });

  const result = await probe(webEntry(), async () => {
    throw timeout;
  });

  assert.strictEqual(result.status, 'unchecked');
  assert.match(result.detail, /timed out/);

  const findings = classify(
    [result],
    snapshotWith('https://vendor.example/products/widget', {
      finalUrl: 'https://vendor.example/products/widget',
      hash: 'aaaa',
      firstSeen: monthsAgo(30),
      lastChanged: monthsAgo(30),
    }),
    NOW
  );

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

    const findings = classify([result], { entries: {} }, NOW);
    assert.strictEqual(findings.baseline.length, 0, 'and it is not a baseline either');
    assert.strictEqual(findings.unchecked.length, 1);
  }
});

test('an unchecked entry keeps the snapshot record it already had', () => {
  const prior = {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'aaaa',
    firstSeen: monthsAgo(30),
    lastChanged: monthsAgo(30),
    lastChecked: monthsAgo(1),
  };

  const next = updateSnapshot(
    snapshotWith('https://vendor.example/products/widget', prior),
    [webEntry({ status: 'unchecked', detail: 'HEAD timed out after 20s' })],
    NOW
  );

  assert.deepStrictEqual(
    next.entries['https://vendor.example/products/widget'],
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

  const findings = classify(results, { entries: {} }, NOW);
  assert.strictEqual(findings.unchecked.length, 1);
  assert.strictEqual(findings.missing.length, 0);
});

// --- Rendering --------------------------------------------------------

test('a clean list renders as nothing to do', () => {
  const snapshot = snapshotWith('https://vendor.example/products/widget', {
    finalUrl: 'https://vendor.example/products/widget',
    hash: 'aaaa',
    firstSeen: monthsAgo(3),
    lastChanged: monthsAgo(3),
  });

  const { body, actionable } = render(classify([webEntry()], snapshot, NOW), { web: 1 });
  assert.strictEqual(actionable, 0);
  assert.ok(body.includes('Nothing needs doing'));
});

test('the summary line says what was checked and what was left to the other checker', () => {
  const { body } = render(classify([], { entries: {} }, NOW), {
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
    snapshotWith('https://vendor.example/products/widget', {
      finalUrl: 'https://vendor.example/products/widget',
      hash: 'aaaa',
      firstSeen: monthsAgo(6),
      lastChanged: monthsAgo(6),
    }),
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

function issueHarness(t, { existingIssue }) {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const calls = [];

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });

    if (method === 'GET') {
      return {
        status: 200,
        ok: true,
        json: async () =>
          existingIssue
            ? [
                { number: 7, body: '<!-- entry-health-report -->\nthe other check' },
                { number: 99, body: '<!-- web-health-report -->\nprevious' },
              ]
            : [{ number: 7, body: '<!-- entry-health-report -->\nthe other check' }],
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
