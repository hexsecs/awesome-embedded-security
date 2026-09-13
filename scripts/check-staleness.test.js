#!/usr/bin/env node
// Tests for check-staleness.js, using node:test so nothing new is added to
// package.json. Run with `npm run test:staleness`.
//
// The live GitHub API path cannot be exercised here, so what is tested is
// everything that decides what a maintainer is told: how a repository's
// metadata is turned into a finding, and — most importantly — that an API
// failure is never turned into one. A false "this repository is gone" would
// send someone deleting a live entry, which is the one mistake this script
// must not make.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  readEntries,
  classify,
  render,
  lookup,
  preflight,
  reportIssue,
  QUIET_MONTHS,
} = require('./check-staleness.js');

const NOW = Date.now();
const MONTH = 1000 * 60 * 60 * 24 * 30.44;
const recent = new Date(NOW - 2 * MONTH).toISOString();
const ancient = new Date(NOW - (QUIET_MONTHS + 12) * MONTH).toISOString();

function entry(overrides) {
  return {
    name: 'Example',
    url: 'https://github.com/acme/example',
    owner: 'acme',
    repo: 'example',
    deepPath: false,
    hasArchivedMarker: false,
    lineNo: 1,
    status: 'ok',
    archived: false,
    fullName: 'acme/example',
    pushedAt: recent,
    ...overrides,
  };
}

// --- Reading the real README -----------------------------------------

test('reads GitHub entries out of the real README', () => {
  const entries = readEntries();

  assert.ok(entries.length > 100, 'expected the list to yield many entries');
  assert.ok(
    entries.every((e) => e.owner && e.repo),
    'every entry should resolve to an owner and repo'
  );
  assert.ok(
    entries.every((e) => !/^#/.test(e.url)),
    'Table of Contents anchors must not be treated as entries'
  );
});

test('detects the archived marker on entries that carry it', () => {
  const entries = readEntries();
  const marked = entries.filter((e) => e.hasArchivedMarker);

  assert.ok(marked.length > 0, 'the README has 🗄️-marked entries to find');
  assert.ok(
    entries.some((e) => !e.hasArchivedMarker),
    'and unmarked ones, so the flag is not always true'
  );
});

test('recognises a link pointing inside a repository', () => {
  const entries = readEntries();
  const deep = entries.filter((e) => e.deepPath);

  for (const e of deep) {
    assert.ok(
      e.owner && e.repo,
      'a deep link still resolves to the repository it lives in'
    );
  }
});

// --- Classification ---------------------------------------------------

test('a 404 is reported as missing', () => {
  const findings = classify([entry({ status: 'missing' })]);
  assert.strictEqual(findings.missing.length, 1);
  assert.strictEqual(findings.errors.length, 0);
});

test('a renamed repository is reported as moved', () => {
  const findings = classify([entry({ fullName: 'acme/example-ng' })]);
  assert.strictEqual(findings.renamed.length, 1);
  assert.strictEqual(findings.renamed[0].fullName, 'acme/example-ng');
});

test('a rename differing only in case is not a finding', () => {
  const findings = classify([entry({ fullName: 'ACME/Example' })]);
  assert.strictEqual(findings.renamed.length, 0);
});

test('an archived repository without the marker needs one', () => {
  const findings = classify([entry({ archived: true })]);
  assert.strictEqual(findings.needsMarker.length, 1);
  assert.strictEqual(findings.staleMarker.length, 0);
});

test('an archived repository that already has the marker is not reported', () => {
  const findings = classify([entry({ archived: true, hasArchivedMarker: true })]);
  assert.strictEqual(findings.needsMarker.length, 0);
  assert.strictEqual(findings.staleMarker.length, 0);
});

test('an unarchived repository still carrying the marker is reported', () => {
  const findings = classify([entry({ archived: false, hasArchivedMarker: true })]);
  assert.strictEqual(findings.staleMarker.length, 1);
});

test('a long-dormant repository is reported as quiet, not as a problem', () => {
  const findings = classify([entry({ pushedAt: ancient })]);

  assert.strictEqual(findings.quiet.length, 1);
  assert.strictEqual(findings.missing.length, 0);
  assert.strictEqual(findings.needsMarker.length, 0);

  const { actionable } = render(findings, 1);
  assert.strictEqual(
    actionable,
    0,
    'quiet must never count as something needing a decision'
  );
});

// --- The failure that matters ----------------------------------------

test('an API failure is never classified as a missing repository', () => {
  const findings = classify([
    entry({ status: 'error', detail: 'GitHub API rate limit exhausted' }),
    entry({ status: 'error', detail: 'GitHub API rejected the credentials' }),
  ]);

  assert.strictEqual(findings.missing.length, 0, 'an error is not a 404');
  assert.strictEqual(findings.errors.length, 2);

  const { body } = render(findings, 2);
  assert.ok(body.includes('Could not be checked'));
  assert.ok(!body.includes('## Gone (404)'));
});

test('auth and rate-limit responses become errors, not findings', async (t) => {
  const cases = [
    { status: 401, expect: /credentials/ },
    { status: 403, expect: /rate limit|HTTP 403/ },
    { status: 429, expect: /rate limit|HTTP 429/ },
    { status: 500, expect: /HTTP 500/ },
  ];

  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  for (const { status, expect } of cases) {
    global.fetch = async () => ({
      status,
      ok: false,
      headers: { get: () => '0' },
    });

    const result = await lookup(entry());
    assert.strictEqual(result.status, 'error', `HTTP ${status} must be an error`);
    assert.match(result.detail, expect);
  }
});

test('a 404 from the API really does mean missing', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({ status: 404, ok: false, headers: { get: () => null } });

  const result = await lookup(entry());
  assert.strictEqual(result.status, 'missing');
});

test('a network exception is an error, not a missing repository', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => {
    throw new Error('ECONNRESET');
  };

  const result = await lookup(entry());
  assert.strictEqual(result.status, 'error');
  assert.match(result.detail, /ECONNRESET/);
});

// --- Rendering --------------------------------------------------------

test('a clean list renders as nothing to do', () => {
  const findings = classify([entry(), entry({ name: 'Other' })]);
  const { body, actionable } = render(findings, 2);

  assert.strictEqual(actionable, 0);
  assert.ok(body.includes('Nothing needs doing'));
});

test('actionable findings are counted and rendered under their headings', () => {
  const findings = classify([
    entry({ name: 'Dead', status: 'missing' }),
    entry({ name: 'Moved', fullName: 'acme/renamed' }),
    entry({ name: 'Archived', archived: true }),
    entry({ name: 'Unarchived', hasArchivedMarker: true }),
  ]);
  const { body, actionable } = render(findings, 4);

  assert.strictEqual(actionable, 4);
  assert.ok(body.includes('## Gone (404)'));
  assert.ok(body.includes('## Moved'));
  assert.ok(body.includes('missing the 🗄️ marker'));
  assert.ok(body.includes('no longer archived'));
  assert.ok(!body.includes('Nothing needs doing'));
});

test('the report names the file and line of each finding', () => {
  const findings = classify([entry({ name: 'Dead', status: 'missing', lineNo: 62 })]);
  const { body } = render(findings, 1);

  assert.ok(body.includes('README.md:62'), 'a finding should be locatable');
});

// --- The preflight ----------------------------------------------------

test('preflight refuses a rejected token before looking anything up', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({ status: 401, ok: false });

  const result = await preflight(150);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /credentials/);
});

test('preflight refuses when the remaining quota is short of the run', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      resources: { core: { remaining: 10, reset: Math.floor(Date.now() / 1000) + 60 } },
    }),
  });

  const result = await preflight(150);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /only 10 API requests remain/);
});

test('preflight passes when the quota covers the run', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ resources: { core: { remaining: 5000, reset: 0 } } }),
  });

  assert.strictEqual((await preflight(150)).ok, true);
});

// --- Filing the issue -------------------------------------------------
// This is the only part that writes to the repository, so each branch is
// pinned: an all-clear must not open an issue, and a monthly run must not
// pile up a new one beside the report already open.

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
            ? [{ number: 99, body: '<!-- entry-health-report -->\nprevious' }]
            : [],
      };
    }
    return { status: method === 'POST' ? 201 : 200, ok: true, json: async () => ({ number: 123 }) };
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

test('findings with no open report open one', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  const write = calls.find((c) => c.method === 'POST');
  assert.ok(write, 'a new report should be opened');
  assert.strictEqual(write.body.title, 'Entry health report');
  assert.ok(write.body.body.includes('<!-- entry-health-report -->'));
});

test('findings rewrite the open report rather than opening a second', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  assert.strictEqual(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'a monthly run must not pile up issues'
  );

  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write);
  assert.strictEqual(write.body.state, 'open');
  assert.ok(write.body.body.includes('Gone (404)'));
});

test('the marker the run uses to find its own issue is always written', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Gone (404)', 1);

  const write = calls.find((c) => c.method === 'POST');
  assert.ok(
    write.body.body.startsWith('<!-- entry-health-report -->'),
    'without the marker the next run cannot find this issue and would open another'
  );
});
