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
