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
const fs = require('node:fs');
const os = require('node:os');

const {
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

function issueHarness(t, { existingIssue, lookup = 'ok', issues = null }) {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const realExitCode = process.exitCode;
  const calls = [];

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });

    if (method === 'GET') {
      // `lookup` is how the tests below distinguish "there is no report
      // issue" from "I could not find out", which is the whole point of
      // that code path.
      if (lookup === 'throw') throw new Error('ECONNRESET');
      if (lookup === 'fail') return { status: 500, ok: false, json: async () => ({}) };
      // A 200 carrying an object, which is what a secondary rate limit or
      // an abuse-detection trip looks like.
      if (lookup === 'object') {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            message: 'You have exceeded a secondary rate limit',
            documentation_url: 'https://docs.github.com/…',
          }),
        };
      }
      if (lookup === 'unparseable') {
        return {
          status: 200,
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () =>
          issues ||
          (existingIssue
            ? [{ number: 99, body: '<!-- entry-health-report -->\nprevious' }]
            : []),
      };
    }
    return { status: method === 'POST' ? 201 : 200, ok: true, json: async () => ({ number: 123 }) };
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

// --- Applying the deterministic fixes ---------------------------------
// The fix mode is the only part of this script that rewrites the list, so
// every test below drives it with the fixture string underneath rather than
// the real README.md. A test that writes to README.md is a test that can
// corrupt the thing it is checking.
//
// What is pinned here: the exact bytes of an inserted marker, the spacing
// left behind by a removed one, that a rename keeps a deep path and leaves
// the display label alone, that a rename onto an entry already in the list
// is refused instead of applied, that every other line comes through
// untouched, and — the rule that outranks the rest — that an entry the API
// could not answer for never produces an edit.

const FIXTURE = [
  '# Awesome Fixture',
  '',
  '## Contents',
  '',
  '* [Tools](#tools)',
  '',
  '## Tools',
  '',
  '* [Alpha](https://github.com/acme/alpha) - Does a thing.',
  '* [Bravo](https://github.com/acme/bravo) 💰 - Sells another thing.',
  '* [Charlie](https://github.com/acme/charlie/tree/main/security) - Points inside a repository.',
  '* [Delta](https://github.com/acme/delta) 🗄️ - Was archived once.',
  '',
].join('\n');

const ALPHA_LINE = 9;
const BRAVO_LINE = 10;
const CHARLIE_LINE = 11;
const DELTA_LINE = 12;

// Builds a lookup result for one fixture entry, so the line numbers the fix
// is addressed by are the ones the parser actually found.
function fixtureEntry(name, overrides) {
  const parsed = parseEntries(FIXTURE).find((e) => e.name === name);
  assert.ok(parsed, `the fixture has no entry named ${name}`);
  return {
    status: 'ok',
    archived: false,
    pushedAt: recent,
    ...parsed,
    fullName: `${parsed.owner}/${parsed.repo}`,
    ...overrides,
  };
}

function linesOf(content) {
  return content.split('\n');
}

test('the fixture the fix tests run against is itself a valid list', () => {
  const check = verifyReadme(FIXTURE);
  assert.strictEqual(check.ok, true, check.output);
});

test('an archived entry with no markers gains the 🗄️ marker', () => {
  const findings = classify([fixtureEntry('Alpha', { archived: true })]);
  const { content, edits, skipped } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 1);
  assert.strictEqual(skipped.length, 0);
  assert.strictEqual(edits[0].kind, 'needsMarker');
  assert.strictEqual(edits[0].lineNo, ALPHA_LINE);
  assert.strictEqual(
    linesOf(content)[ALPHA_LINE - 1],
    `* [Alpha](https://github.com/acme/alpha) ${ARCHIVED_MARKER_FULL} - Does a thing.`
  );
});

test('the inserted marker is byte-identical to the one the list already uses', () => {
  const findings = classify([fixtureEntry('Alpha', { archived: true })]);
  const { content } = applyFixes(FIXTURE, findings);

  const inserted = linesOf(content)[ALPHA_LINE - 1].match(/\)\s+(\S+)\s+-/)[1];
  const existing = linesOf(FIXTURE)[DELTA_LINE - 1].match(/\)\s+(\S+)\s+-/)[1];

  assert.strictEqual(
    Buffer.from(inserted).toString('hex'),
    Buffer.from(existing).toString('hex'),
    'U+1F5C4 without the U+FE0F variation selector renders as a different glyph'
  );
  assert.strictEqual(Buffer.from(inserted).toString('hex'), 'f09f9784efb88f');
});

test('the marker goes after a 💰 that is already there', () => {
  const findings = classify([fixtureEntry('Bravo', { archived: true })]);
  const { content, edits } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 1);
  assert.strictEqual(
    linesOf(content)[BRAVO_LINE - 1],
    `* [Bravo](https://github.com/acme/bravo) 💰 ${ARCHIVED_MARKER_FULL} - Sells another thing.`
  );
});

test('an unarchived entry loses the marker, leaving one space before the dash', () => {
  const findings = classify([fixtureEntry('Delta', { archived: false })]);
  const { content, edits } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].kind, 'staleMarker');
  assert.strictEqual(
    linesOf(content)[DELTA_LINE - 1],
    '* [Delta](https://github.com/acme/delta) - Was archived once.'
  );
  assert.ok(
    !/\)\s{2,}-/.test(linesOf(content)[DELTA_LINE - 1]),
    'removing the marker must not leave its whitespace behind'
  );
});

test('a rename rewrites the URL and leaves the display label alone', () => {
  const findings = classify([
    fixtureEntry('Alpha', {
      fullName: 'acme/alpha-ng',
      htmlUrl: 'https://github.com/acme/alpha-ng',
    }),
  ]);
  const { content, edits } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].kind, 'renamed');
  assert.strictEqual(
    linesOf(content)[ALPHA_LINE - 1],
    '* [Alpha](https://github.com/acme/alpha-ng) - Does a thing.',
    'renaming the label is a judgement call and stays with the human'
  );
});

test('a rename of a link pointing inside a repository is left to a human', () => {
  // Splicing the old path onto the new repository is a guess about the new
  // repository's layout, and nothing downstream would catch a wrong one:
  // check-readme.js does not fetch, and the link check does not run on a
  // pull request this script authors. A dead link with no gate in front of
  // it is not an edit with exactly one correct answer.
  const findings = classify([
    fixtureEntry('Charlie', {
      fullName: 'acme/charlie-ng',
      htmlUrl: 'https://github.com/acme/charlie-ng',
    }),
  ]);
  const { content, edits, skipped } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 0, 'a deep-path rename is not auto-applied');
  assert.strictEqual(content, FIXTURE, 'the entry is left exactly as it was');
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].kind, 'renamed');
  assert.match(skipped[0].reason, /points inside the repository/);

  // And it still reaches the human, with the reason, in the report.
  const { body, actionable } = render(findings, 1, {
    edits,
    skipped,
    prUrl: 'https://github.com/owner/repo/pull/7',
  });
  assert.ok(body.includes('## Moved'));
  assert.match(body, /not fixed automatically: the link points inside/);
  assert.strictEqual(actionable, 1, 'it still needs a decision');
});

test('a shallow rename beside a deep one is still applied', () => {
  // The refusal is scoped to the deep-path entry, not to renames generally.
  const findings = classify([
    fixtureEntry('Alpha', {
      fullName: 'acme/alpha-ng',
      htmlUrl: 'https://github.com/acme/alpha-ng',
    }),
    fixtureEntry('Charlie', {
      fullName: 'acme/charlie-ng',
      htmlUrl: 'https://github.com/acme/charlie-ng',
    }),
  ]);
  const { content, edits, skipped } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].name, 'Alpha');
  assert.strictEqual(skipped.length, 1);
  assert.strictEqual(skipped[0].name, 'Charlie');
  assert.strictEqual(
    linesOf(content)[CHARLIE_LINE - 1],
    linesOf(FIXTURE)[CHARLIE_LINE - 1],
    'the refused line must be byte-identical'
  );
});

test('a rename onto a URL already in the list is refused, not applied', () => {
  const findings = classify([
    fixtureEntry('Alpha', {
      fullName: 'acme/delta',
      htmlUrl: 'https://github.com/acme/delta',
    }),
  ]);
  const { content, edits, skipped } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 0, 'the fix must not create a duplicate URL');
  assert.strictEqual(content, FIXTURE);
  assert.strictEqual(skipped.length, 1);
  assert.match(skipped[0].reason, new RegExp(`already listed at README.md:${DELTA_LINE}`));
  assert.strictEqual(verifyReadme(content).ok, true);
});

test('the check that gates pull requests would catch a duplicate that slipped through', () => {
  const broken = FIXTURE.replace(
    'https://github.com/acme/alpha',
    'https://github.com/acme/delta'
  );
  const check = verifyReadme(broken);

  assert.strictEqual(check.ok, false);
  assert.match(check.output, /duplicate URL/);
});

test('every line the findings do not name comes through byte-identical', () => {
  const findings = classify([
    fixtureEntry('Alpha', { archived: true }),
    fixtureEntry('Delta', { archived: false }),
  ]);
  const { content, edits } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 2);

  const before = linesOf(FIXTURE);
  const after = linesOf(content);
  const touched = new Set(edits.map((e) => e.lineNo));

  assert.strictEqual(after.length, before.length);
  before.forEach((line, idx) => {
    if (touched.has(idx + 1)) return;
    assert.strictEqual(after[idx], line, `line ${idx + 1} must not be rewritten`);
  });
  assert.ok(content.endsWith('\n'), 'the trailing newline must survive');
  assert.strictEqual(verifyReadme(content).ok, true);
});

test('nothing to fix leaves the content exactly as it was', () => {
  const findings = classify([fixtureEntry('Alpha'), fixtureEntry('Bravo')]);
  const { content, edits, skipped } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 0);
  assert.strictEqual(skipped.length, 0);
  assert.strictEqual(content, FIXTURE);
});

test('an entry the API could not be asked about never produces an edit', () => {
  const broken = fixtureEntry('Alpha', {
    status: 'error',
    detail: 'GitHub API rate limit exhausted',
    archived: true,
  });

  // Through classify, which is what the script does: an error lands in
  // errors and in no other bucket, so there is nothing to apply.
  const viaClassify = applyFixes(FIXTURE, classify([broken]));
  assert.strictEqual(viaClassify.edits.length, 0);
  assert.strictEqual(viaClassify.content, FIXTURE);

  // And directly, with the error smuggled into a fixable bucket, because a
  // false "this repository changed" committed to the list is the one
  // mistake this script must not make.
  const forced = applyFixes(FIXTURE, {
    missing: [],
    renamed: [{ ...broken, fullName: 'acme/gone', htmlUrl: 'https://github.com/acme/gone' }],
    needsMarker: [broken],
    staleMarker: [],
    quiet: [],
    errors: [],
  });
  assert.strictEqual(forced.edits.length, 0, 'an API error must never be edited into the list');
  assert.strictEqual(forced.content, FIXTURE);
});

test('a finding whose line has moved is refused rather than guessed at', () => {
  const findings = classify([
    fixtureEntry('Alpha', { archived: true, lineNo: BRAVO_LINE }),
  ]);
  const { content, edits, skipped } = applyFixes(FIXTURE, findings);

  assert.strictEqual(edits.length, 0);
  assert.strictEqual(content, FIXTURE);
  assert.match(skipped[0].reason, /no longer holds the entry/);
});

test('a 404 or a quiet repository is never edited', () => {
  const findings = classify([
    fixtureEntry('Alpha', { status: 'missing' }),
    fixtureEntry('Bravo', { pushedAt: ancient }),
  ]);
  const { content, edits } = applyFixes(FIXTURE, findings);

  assert.strictEqual(findings.missing.length, 1);
  assert.strictEqual(findings.quiet.length, 1);
  assert.strictEqual(edits.length, 0, 'deleting an entry is never automated');
  assert.strictEqual(content, FIXTURE);
});

// --- The report once the pull request exists --------------------------

test('the report stops listing the findings the pull request applied', () => {
  const findings = classify([
    entry({ name: 'Archived', archived: true, lineNo: 9 }),
    entry({ name: 'Dead', status: 'missing', lineNo: 20 }),
  ]);
  const applied = {
    edits: [{ kind: 'needsMarker', name: 'Archived', lineNo: 9, note: 'added the marker' }],
    skipped: [],
    prUrl: 'https://github.com/owner/repo/pull/7',
  };

  const { body, actionable } = render(findings, 2, applied);

  assert.ok(!body.includes('missing the 🗄️ marker'), 'the fixed finding is gone');
  assert.ok(body.includes('https://github.com/owner/repo/pull/7'));
  assert.ok(body.includes('## Gone (404)'), 'what still needs a human stays');
  assert.strictEqual(actionable, 1, 'only the unfixed finding still counts');
});

test('a finding the fix refused is still reported, with the reason', () => {
  const findings = classify([entry({ name: 'Moved', fullName: 'acme/taken', lineNo: 9 })]);
  const applied = {
    edits: [],
    skipped: [{ kind: 'renamed', name: 'Moved', lineNo: 9, reason: 'it would duplicate another entry' }],
    prUrl: null,
  };

  const { body, actionable } = render(findings, 1, applied);

  assert.ok(body.includes('## Moved'));
  assert.ok(body.includes('not fixed automatically: it would duplicate another entry'));
  assert.strictEqual(actionable, 1);
});

test('missing, quiet and unchecked entries report identically with a fix in flight', () => {
  const findings = classify([
    entry({ name: 'Dead', status: 'missing', lineNo: 20 }),
    entry({ name: 'Broken', status: 'error', detail: 'GitHub API rate limit exhausted', lineNo: 21 }),
    entry({ name: 'Dormant', pushedAt: ancient, lineNo: 22 }),
    entry({ name: 'Archived', archived: true, lineNo: 9 }),
  ]);
  const applied = {
    edits: [{ kind: 'needsMarker', name: 'Archived', lineNo: 9, note: 'added the marker' }],
    skipped: [],
    prUrl: 'https://github.com/owner/repo/pull/7',
  };

  const withFix = render(findings, 4, applied).body;
  const withoutFix = render(findings, 4).body;

  for (const section of ['## Gone (404)', '## Could not be checked', `## Quiet for ${QUIET_MONTHS}+ months`]) {
    assert.ok(withFix.includes(section), `${section} must survive the fix run`);
  }
  for (const line of withoutFix.split('\n')) {
    if (/^- \*\*(Dead|Broken|Dormant)\*\*/.test(line)) {
      assert.ok(withFix.includes(line), 'these findings must be rendered unchanged');
    }
  }
});

test('a report with nothing left for a human closes, and points at the pull request', () => {
  const findings = classify([entry({ name: 'Archived', archived: true, lineNo: 9 })]);
  const applied = {
    edits: [{ kind: 'needsMarker', name: 'Archived', lineNo: 9, note: 'added the marker' }],
    skipped: [],
    prUrl: 'https://github.com/owner/repo/pull/7',
  };

  const { body, actionable } = render(findings, 1, applied);

  assert.strictEqual(actionable, 0, 'an issue with nothing left in it should close');
  assert.ok(body.includes('Nothing needs doing'));
  assert.ok(body.includes('/pull/7'));
});

test('the report is unchanged when no fix ran', () => {
  const findings = classify([entry({ name: 'Archived', archived: true, lineNo: 9 })]);

  assert.strictEqual(render(findings, 1).body, render(findings, 1, null).body);
  assert.strictEqual(render(findings, 1).actionable, 1);
});

// --- The pull request body --------------------------------------------

test('the pull request body explains each edit on its own line', () => {
  const body = prBody(
    [
      { kind: 'needsMarker', name: 'Alpha', lineNo: 9, note: 'archived upstream — added the 🗄️ marker' },
      { kind: 'renamed', name: 'Charlie', lineNo: 11, note: 'moved to `acme/charlie-ng` — updated the link' },
    ],
    [{ kind: 'renamed', name: 'Bravo', lineNo: 10, reason: 'it would duplicate another entry' }],
    'https://github.com/owner/repo/issues/3'
  );

  assert.ok(body.startsWith('<!-- entry-health-fixes -->'));
  assert.ok(body.includes(PR_BRANCH), 'the reused branch should be named');
  assert.ok(body.includes('`README.md:9` **Alpha** — archived upstream'));
  assert.ok(body.includes('`README.md:11` **Charlie** — moved to `acme/charlie-ng`'));
  assert.ok(body.includes('## Left for a human'));
  assert.ok(body.includes('https://github.com/owner/repo/issues/3'));
});

// --- One sweep, and the report survives the fix ------------------------
// The whole run is a single invocation: the sweep costs an API request per
// entry, so checking in one process and fixing in another would spend that
// budget twice and rewrite the report issue twice. What makes that single
// invocation safe is the order inside it — fix first, report last, from
// whatever the fix actually achieved — and these tests pin exactly that.
// Without them, a future edit could reorder the two and silently lose the
// report on every month where the pull request fails to open.

function reportHarness(t, runFixModeImpl) {
  const filed = [];
  const exitCode = process.exitCode;
  t.after(() => {
    process.exitCode = exitCode;
  });
  return {
    filed,
    deps: {
      runFixMode: runFixModeImpl,
      reportIssue: async (body, actionable) => filed.push({ body, actionable }),
    },
  };
}

const FIX_ARGV = ['node', 'check-staleness.js', '--fix', '--open-pr', '--report-issue'];

test('the report is still filed when the pull request could not be opened', async (t) => {
  const findings = classify([
    entry({ name: 'Archived', archived: true, lineNo: 9 }),
    entry({ name: 'Dead', status: 'missing', lineNo: 20 }),
  ]);
  // What openPullRequest returns when `gh` or the push fails: runFixMode
  // logs it and yields nothing applied.
  const { filed, deps } = reportHarness(t, async () => null);

  const result = await checkAndReport(findings, 2, FIX_ARGV, deps);

  assert.strictEqual(filed.length, 1, 'a failed pull request must not cost the run its report');
  assert.strictEqual(filed[0].body, render(findings, 2).body);
  assert.strictEqual(filed[0].actionable, 2, 'nothing was fixed, so both findings still count');
  assert.strictEqual(result.applied, null);
  assert.ok(filed[0].body.includes('missing the 🗄️ marker'));
  assert.ok(filed[0].body.includes('## Gone (404)'));
});

test('a fix path that throws is swallowed and the report goes out unchanged', async (t) => {
  const findings = classify([entry({ name: 'Archived', archived: true, lineNo: 9 })]);
  const { filed, deps } = reportHarness(t, async () => {
    throw new Error('gh: command not found');
  });

  const result = await checkAndReport(findings, 1, FIX_ARGV, deps);

  assert.strictEqual(filed.length, 1);
  assert.strictEqual(filed[0].body, render(findings, 1).body);
  assert.strictEqual(result.applied, null);
});

test('a failed pull request does not fail the run, but a failed report does', async (t) => {
  const findings = classify([entry({ name: 'Archived', archived: true, lineNo: 9 })]);
  const { deps } = reportHarness(t, async () => null);

  process.exitCode = 0;
  await checkAndReport(findings, 1, FIX_ARGV, deps);
  assert.strictEqual(process.exitCode, 0, 'advisory automation must not turn the run red');

  // reportIssue is the part that sets a non-zero exit code, and it still
  // does: a report nobody notices is missing is the worse failure.
  await checkAndReport(findings, 1, FIX_ARGV, {
    runFixMode: async () => null,
    reportIssue: async () => {
      process.exitCode = 1;
    },
  });
  assert.strictEqual(process.exitCode, 1);
});

test('a pull request that opened is reported once, pointing at itself', async (t) => {
  const findings = classify([
    entry({ name: 'Archived', archived: true, lineNo: 9 }),
    entry({ name: 'Dead', status: 'missing', lineNo: 20 }),
  ]);
  const { filed, deps } = reportHarness(t, async () => ({
    edits: [{ kind: 'needsMarker', name: 'Archived', lineNo: 9, note: 'added the marker' }],
    skipped: [],
    prUrl: 'https://github.com/owner/repo/pull/7',
  }));

  await checkAndReport(findings, 2, FIX_ARGV, deps);

  assert.strictEqual(filed.length, 1, 'one invocation writes the issue exactly once');
  assert.ok(filed[0].body.includes('https://github.com/owner/repo/pull/7'));
  assert.ok(!filed[0].body.includes('missing the 🗄️ marker'));
  assert.ok(filed[0].body.includes('## Gone (404)'));
  assert.strictEqual(filed[0].actionable, 1);
});

test('the fix is not attempted at all without a fix flag', async (t) => {
  const findings = classify([entry({ name: 'Archived', archived: true, lineNo: 9 })]);
  let attempted = false;
  const { filed, deps } = reportHarness(t, async () => {
    attempted = true;
    return null;
  });

  await checkAndReport(findings, 1, ['node', 'check-staleness.js', '--report-issue'], deps);

  assert.strictEqual(attempted, false, '--report-issue alone must stay read-only');
  assert.strictEqual(filed.length, 1);
  assert.strictEqual(filed[0].body, render(findings, 1).body);
});

test('a dry run reports nothing and files nothing', async (t) => {
  const findings = classify([entry({ name: 'Archived', archived: true, lineNo: 9 })]);
  let sawOpenPr = null;
  const { filed, deps } = reportHarness(t, async (_findings, openPr) => {
    sawOpenPr = openPr;
    return null;
  });

  await checkAndReport(findings, 1, ['node', 'check-staleness.js', '--fix'], deps);

  assert.strictEqual(sawOpenPr, false, '--fix alone must not open a pull request');
  assert.strictEqual(filed.length, 0, 'and must not touch the issue either');
});

// --- Not knowing is not the same as knowing there is nothing -----------
// Both lookups this script does — "is the report issue already open?" and
// "is the generated pull request already open?" — used to answer a failed
// request with "no". That is how a monthly job ends up with two report
// issues, or two pull requests proposing the same edit, and from then on
// neither one is the one that gets rewritten. These pin the distinction.

test('a report-issue lookup that fails files nothing rather than risk a duplicate', async (t) => {
  const calls = issueHarness(t, { existingIssue: false, lookup: 'fail' });
  process.exitCode = 0;

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'an HTTP 500 is not evidence that no report issue exists'
  );
  assert.strictEqual(process.exitCode, 1, 'a failure to report must stay visible');
});

test('a network failure during the report-issue lookup files nothing either', async (t) => {
  const calls = issueHarness(t, { existingIssue: false, lookup: 'throw' });
  process.exitCode = 0;

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  assert.strictEqual(calls.filter((c) => c.method !== 'GET').length, 0);
  assert.strictEqual(process.exitCode, 1);
});

test('a lookup that succeeds and finds nothing still opens the report', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });
  process.exitCode = 0;

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  assert.ok(calls.find((c) => c.method === 'POST'), 'a real 200-with-no-match must still file');
  assert.strictEqual(process.exitCode, 0);
});

// --- The generated pull request ---------------------------------------
// Everything here shells out to git and gh, so it is driven through the
// dependency seam. README.md is never written: the write is stubbed, and
// each test asserts what was handed to it rather than letting it reach the
// real file.

const OUR_PR = {
  url: 'https://github.com/owner/repo/pull/12',
  baseRefName: 'main',
  body: `${PR_MARKER}\nlast month's edits`,
};

function prHarness(t, { overrides = {}, ref = 'main' } = {}) {
  const realEnv = { ...process.env };
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REF_NAME = ref;
  t.after(() => {
    process.env = realEnv;
  });

  const calls = [];
  const written = [];

  const exec = (command, args) => {
    calls.push({ command, args, line: [command, ...args].join(' ') });
    const key = `${command} ${args.slice(0, 2).join(' ')}`.trim();
    if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    if (key === 'gh pr list') return { ok: true, stdout: '[]', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };

  const called = (key) => calls.filter((c) => `${c.command} ${c.args.slice(0, 2).join(' ')}`.trim() === key);

  return { calls, written, called, deps: { run: exec, write: (c) => written.push(c) } };
}

const EDIT = { kind: 'needsMarker', name: 'Alpha', lineNo: 9, note: 'added the marker' };

test('the first run opens the pull request against the branch it ran from', (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr create': { ok: true, stdout: 'https://github.com/owner/repo/pull/1', stderr: '' } },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.url, 'https://github.com/owner/repo/pull/1');
  assert.deepStrictEqual(h.written, ['new content\n'], 'the rewritten list is what gets written');

  const create = h.called('gh pr create')[0];
  assert.ok(create.line.includes('--base main'));
  assert.ok(create.line.includes(`--head ${PR_BRANCH}`));
});

test('a rerun updates the open pull request instead of opening a second', (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: JSON.stringify([OUR_PR]), stderr: '' } },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.url, OUR_PR.url);
  assert.strictEqual(result.retargetedFrom, null, 'the base was already right');
  assert.strictEqual(h.called('gh pr create').length, 0, 'a monthly run must not stack pull requests');
  assert.strictEqual(h.called('gh pr edit').length, 1);
});

test('a pull request left targeting another base is retargeted, not left pointing at it', (t) => {
  // What a workflow_dispatch from a topic branch leaves behind: the pull
  // request was opened against that branch, and this scheduled run has just
  // force-pushed the same head built from the default branch.
  const h = prHarness(t, {
    ref: 'main',
    overrides: {
      'gh pr list': {
        ok: true,
        stdout: JSON.stringify([{ ...OUR_PR, baseRefName: 'feature/topic' }]),
        stderr: '',
      },
    },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.retargetedFrom, 'feature/topic');

  const edit = h.called('gh pr edit')[0];
  assert.ok(
    edit.line.includes('--base main'),
    'without --base the pull request compares against a base its head was never built from'
  );
});

test('a pull request on the branch that this script did not write is left alone', (t) => {
  const h = prHarness(t, {
    overrides: {
      'gh pr list': {
        ok: true,
        stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/5', baseRefName: 'main', body: 'opened by hand' }]),
        stderr: '',
      },
    },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /did not write/);
  assert.strictEqual(h.written.length, 0, 'nothing is written when the run refuses');
  assert.strictEqual(h.called('git push').length, 0, "and someone else's branch is not force-pushed");
  assert.strictEqual(h.called('gh pr edit').length, 0);
});

test('a pull-request lookup that fails pushes nothing and opens nothing', (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: false, stdout: '', stderr: 'HTTP 500' } },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /gh pr list failed/);
  assert.strictEqual(h.called('gh pr create').length, 0, 'a failed lookup must not open a second pull request');
  assert.strictEqual(h.called('git push').length, 0, 'and must cost the remote nothing');
  assert.strictEqual(h.written.length, 0, 'and must not touch README.md');
});

test('unreadable gh output is a failure, not an empty list', (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: 'not json', stderr: '' } },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(h.called('gh pr create').length, 0);
});

// --- Retiring the pull request when there is nothing left --------------
// The promise in the pull request body and in contributing.md is one pull
// request, rewritten each month. A month where a maintainer fixed the
// findings by hand used to break it silently: the sweep found nothing,
// returned early, and left last month's pull request open proposing an edit
// that no longer applied.

test('a sweep with nothing to fix closes the pull request it opened last month', async (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: JSON.stringify([OUR_PR]), stderr: '' } },
  });

  const applied = await runFixMode(classify([]), true, h.deps);

  assert.strictEqual(applied, null, 'nothing was applied, so nothing is marked as handled');
  const close = h.called('gh pr close')[0];
  assert.ok(close, 'the stale pull request should be closed');
  assert.strictEqual(close.args[2], OUR_PR.url);
  assert.ok(close.args.includes('--delete-branch'));
  assert.ok(
    close.args.some((a) => a.includes('nothing left to fix')),
    'closing it silently would read as the automation giving up'
  );
});

test('a sweep with nothing to fix and no pull request open touches nothing', async (t) => {
  const h = prHarness(t);

  await runFixMode(classify([]), true, h.deps);

  assert.strictEqual(h.called('gh pr close').length, 0);
  assert.strictEqual(h.written.length, 0);
});

test('a sweep with nothing to fix leaves a pull request it did not write open', (t) => {
  const h = prHarness(t, {
    overrides: {
      'gh pr list': {
        ok: true,
        stdout: JSON.stringify([{ url: 'https://github.com/owner/repo/pull/5', baseRefName: 'main', body: 'opened by hand' }]),
        stderr: '',
      },
    },
  });

  const result = retireStalePullRequest(h.deps);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.closed, null);
  assert.strictEqual(h.called('gh pr close').length, 0);
});

test('a lookup failure closes nothing and is reported, not thrown', (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: false, stdout: '', stderr: 'HTTP 502' } },
  });

  const result = retireStalePullRequest(h.deps);

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /gh pr list failed/);
  assert.strictEqual(h.called('gh pr close').length, 0);
});

test('a dry run never reaches gh at all', async (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: JSON.stringify([OUR_PR]), stderr: '' } },
  });

  await runFixMode(classify([]), false, h.deps);

  assert.strictEqual(h.calls.length, 0, '--fix alone must not touch the remote');
});

// --- A 200 is not proof that the body is what was asked for ------------
// GitHub answers some secondary rate limits and abuse-detection trips with
// a JSON *object* and a 2xx status. It parses, so a try/catch around
// response.json() never fires; calling .find on it throws a TypeError from
// outside any handler, which kills the run — possibly after the fix step
// has already pushed a branch and opened a pull request. Dying halfway is
// worse than the duplicate issue this lookup was hardened against, so the
// shape of the body is checked, not just its parseability.

test('a 200 that is not a list of issues files nothing and stays visible', async (t) => {
  const calls = issueHarness(t, { existingIssue: false, lookup: 'object' });
  process.exitCode = 0;

  await assert.doesNotReject(
    () => reportIssue('## Gone (404)\n\n- **Dead**', 1),
    'a secondary rate limit must degrade, not throw out of the run'
  );

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'an unreadable answer is not evidence that no report issue exists'
  );
  assert.strictEqual(process.exitCode, 1, 'a failure to report must stay visible');
});

test('a 200 whose body will not parse is treated the same way', async (t) => {
  const calls = issueHarness(t, { existingIssue: false, lookup: 'unparseable' });
  process.exitCode = 0;

  await assert.doesNotReject(() => reportIssue('## Gone (404)\n\n- **Dead**', 1));

  assert.strictEqual(calls.filter((c) => c.method !== 'GET').length, 0);
  assert.strictEqual(process.exitCode, 1);
});

test('a repository lookup answered with a non-object degrades to unchecked', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  for (const body of [{ json: async () => ['not', 'a', 'repository'] }, { json: async () => null }]) {
    global.fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, ...body });

    const result = await lookup(entry());
    assert.strictEqual(result.status, 'error', 'an unreadable body is never a finding');
    assert.match(result.detail, /without a repository object/);
  }

  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  });

  const result = await lookup(entry());
  assert.strictEqual(result.status, 'error');
  assert.match(result.detail, /unreadable response body/);

  // And it must not be classified into anything a human or the fixer acts on.
  const findings = classify([result]);
  assert.strictEqual(findings.errors.length, 1);
  assert.strictEqual(findings.missing.length, 0);
  assert.strictEqual(applyFixes(FIXTURE, findings).edits.length, 0);
});

test('a rate-limit preflight answered with a non-object refuses the run', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({ status: 200, ok: true, json: async () => null });
  const nonObject = await preflight(150);
  assert.strictEqual(nonObject.ok, false);
  assert.match(nonObject.reason, /carried no quota/);

  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  });
  const unreadable = await preflight(150);
  assert.strictEqual(unreadable.ok, false);
  assert.match(unreadable.reason, /could not be read/);
});

test('gh output that parses to an object is a failed lookup, not an empty one', (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: '{"message":"rate limited"}', stderr: '' } },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /not a list/);
  assert.strictEqual(h.called('gh pr create').length, 0, 'a failed lookup must not open a second pull request');
  assert.strictEqual(h.called('git push').length, 0);
  assert.strictEqual(h.written.length, 0);
});

test('an issue that was created but answered unreadably is not reported as a failure', async (t) => {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const realExitCode = process.exitCode;
  t.after(() => {
    global.fetch = realFetch;
    process.env = realEnv;
    process.exitCode = realExitCode;
  });

  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.exitCode = 0;

  global.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'GET') return { status: 200, ok: true, json: async () => [] };
    return {
      status: 201,
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    };
  };

  await assert.doesNotReject(() => reportIssue('## Gone (404)', 1));
  assert.strictEqual(process.exitCode, 0, 'the issue was created; that call did not fail');
});

// --- One thread, reopened, forever -------------------------------------
// The report lives on a single issue that is closed when the list is clean
// and reopened when something turns up again. The lookup therefore has to
// include closed issues: with state=open, the run that closed the report
// last month would find nothing this month, open a second issue, and
// abandon the first along with its history and its subscribers.
//
// The test on the query string is deliberate. Reverting to state=open looks
// harmless in a diff — it only "narrows a query" — and breaks the thread
// silently, a month later, where nobody connects the two.

function marked(overrides) {
  return {
    number: 99,
    state: 'open',
    body: '<!-- entry-health-report -->\nprevious',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

function captureErrors(t) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  t.after(() => {
    console.error = real;
  });
  return lines;
}

test('the lookup asks for closed issues too', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Gone (404)', 1);

  const get = calls.find((c) => c.method === 'GET');
  assert.match(
    get.url,
    /state=all/,
    'state=open would orphan the thread the month after it was closed'
  );
});

test('a closed report thread is reopened rather than replaced', async (t) => {
  const calls = issueHarness(t, { issues: [marked({ state: 'closed' })] });

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  assert.strictEqual(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'a closed thread must be reopened, not replaced with a new issue'
  );

  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write.url.endsWith('/issues/99'));
  assert.strictEqual(write.body.state, 'open');
  assert.ok(write.body.body.includes('Gone (404)'));
});

test('a hand-closed thread reopens too, which is the accepted trade', async (t) => {
  // There is deliberately no check for who closed it: a manual close means
  // "dealt with for now", and a finding that is still true next month comes
  // back on the same thread rather than being lost.
  const calls = issueHarness(t, {
    issues: [marked({ state: 'closed', closed_by: { login: 'a-maintainer' } })],
  });

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  const write = calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(write.body.state, 'open');
});

test('a clean run closes the open thread', async (t) => {
  const calls = issueHarness(t, { issues: [marked({ state: 'open' })] });

  await reportIssue('## Nothing needs doing', 0);

  const write = calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(write.body.state, 'closed');
});

test('a clean run leaves an already-closed thread completely alone', async (t) => {
  const calls = issueHarness(t, { issues: [marked({ state: 'closed' })] });

  await reportIssue('## Nothing needs doing', 0);

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'rewriting a closed report every clean month would notify watchers forever'
  );
});

test('an open thread wins over a closed one, and the extras are named', async (t) => {
  const errors = captureErrors(t);
  const calls = issueHarness(t, {
    issues: [
      marked({ number: 50, state: 'closed', updated_at: '2026-09-10T00:00:00Z' }),
      marked({ number: 99, state: 'open', updated_at: '2026-01-01T00:00:00Z' }),
    ],
  });

  await reportIssue('## Gone (404)', 1);

  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(
    write.url.endsWith('/issues/99'),
    'reopening a closed report beside an open one would leave two open reports'
  );
  assert.ok(
    errors.some((line) => line.includes('#50')),
    'a second marker issue means an earlier run got this wrong, and a human has to merge them'
  );
});

test('between two closed threads the most recently active one is reused', async (t) => {
  const calls = issueHarness(t, {
    issues: [
      marked({ number: 10, state: 'closed', updated_at: '2025-01-01T00:00:00Z' }),
      marked({ number: 20, state: 'closed', updated_at: '2026-09-01T00:00:00Z' }),
    ],
  });

  await reportIssue('## Gone (404)', 1);

  assert.ok(calls.find((c) => c.method === 'PATCH').url.endsWith('/issues/20'));
});

test('an equally stale pair is broken by issue number, so the choice is stable', async (t) => {
  const calls = issueHarness(t, {
    issues: [
      marked({ number: 7, state: 'closed', updated_at: undefined }),
      marked({ number: 8, state: 'closed', updated_at: undefined }),
    ],
  });

  await reportIssue('## Gone (404)', 1);

  assert.ok(
    calls.find((c) => c.method === 'PATCH').url.endsWith('/issues/8'),
    'an unstable choice would alternate threads from run to run'
  );
});

test('a single match reports no duplicates', async (t) => {
  const errors = captureErrors(t);
  const calls = issueHarness(t, { issues: [marked()] });

  await reportIssue('## Gone (404)', 1);

  assert.strictEqual(errors.length, 0, 'the normal case must stay quiet');
  assert.ok(calls.find((c) => c.method === 'PATCH'));
});

test('an issue without the marker is not mistaken for the report', async (t) => {
  const calls = issueHarness(t, {
    issues: [
      { number: 3, state: 'open', body: 'an unrelated issue', updated_at: '2026-09-11T00:00:00Z' },
      { number: 4, state: 'open', body: '<!-- entry-health-report -->', updated_at: '2020-01-01T00:00:00Z', pull_request: {} },
    ],
  });

  await reportIssue('## Gone (404)', 1);

  assert.ok(
    calls.find((c) => c.method === 'POST'),
    'neither an unmarked issue nor a marked pull request is the report thread'
  );
});

// --- The body the guard was written for --------------------------------
// GitHub answers some secondary rate limits with HTTP 200 and a JSON
// *object*: {"message": "You have exceeded a secondary rate limit"}. The
// first version of this guard asked "is the body an object?" — which that
// body is. It sailed through, `archived` came out false for every entry in
// the list, every 🗄️-marked entry read as unarchived, and the fix mode
// stripped the markers and committed them.
//
// So the assertion here is not that the body classifies as an error. It is
// that it produces no edit, end to end, because that is the damage: an API
// error editing the list is the one thing this script must never do.

const SECONDARY_RATE_LIMIT = {
  message: 'You have exceeded a secondary rate limit',
  documentation_url: 'https://docs.github.com/rest/overview/rate-limits',
};

function respondWith(t, body) {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => body,
  });
}

test('a secondary rate limit answered with HTTP 200 produces no edit at all', async (t) => {
  respondWith(t, SECONDARY_RATE_LIMIT);

  // Every entry in the fixture, asked about and answered with that body.
  const results = await Promise.all(
    parseEntries(FIXTURE).map((e) => lookup(e))
  );
  const findings = classify(results);

  assert.strictEqual(findings.errors.length, results.length, 'all unchecked');
  assert.strictEqual(findings.staleMarker.length, 0, 'a 🗄️ entry must not read as unarchived');
  assert.strictEqual(findings.needsMarker.length, 0);
  assert.strictEqual(findings.renamed.length, 0);
  assert.strictEqual(findings.missing.length, 0);

  const { content, edits, skipped } = applyFixes(FIXTURE, findings);
  assert.strictEqual(edits.length, 0, 'a rate-limited month must not edit the list');
  assert.strictEqual(skipped.length, 0);
  assert.strictEqual(content, FIXTURE, 'byte-identical, including every marker');

  // And the report says so, rather than claiming the list is clean.
  const { body } = render(findings, results.length);
  assert.ok(body.includes('## Could not be checked'));
  assert.ok(body.includes('secondary rate limit'), 'the reason should reach the reader');
});

test('a 200 missing the fields the decision rests on is unchecked', async (t) => {
  // archived drives the marker edits and full_name drives the rename, so
  // both have to be present and of the right type before anything is acted
  // on. A partial object is as unusable as a wrong one.
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  const answer = (body) => {
    global.fetch = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => body,
    });
  };

  for (const body of [
    { full_name: 'acme/example' },
    { archived: true },
    { full_name: 42, archived: true },
    { full_name: 'acme/example', archived: 'yes' },
  ]) {
    answer(body);
    const result = await lookup(entry());
    assert.strictEqual(result.status, 'error', `${JSON.stringify(body)} must not be trusted`);
  }

  answer({ full_name: 'acme/example', archived: false, pushed_at: recent });
  assert.strictEqual((await lookup(entry())).status, 'ok', 'a real repository still works');
});

test('the preflight refuses the rate-limit body instead of waving the run through', async (t) => {
  respondWith(t, SECONDARY_RATE_LIMIT);

  const result = await preflight(150);

  assert.strictEqual(result.ok, false, 'no quota in the body means no preflight');
  assert.match(result.reason, /carried no quota/);
  assert.match(result.reason, /secondary rate limit/);
});

// --- A failed sweep is not "nothing left to fix" -----------------------

test('a sweep that could not check anything leaves the open pull request alone', async (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: JSON.stringify([OUR_PR]), stderr: '' } },
  });
  const findings = classify([
    entry({ name: 'Broken', status: 'error', detail: 'GitHub API rate limit exhausted' }),
    entry({ name: 'AlsoBroken', status: 'error', detail: 'HTTP 502' }),
  ]);

  await runFixMode(findings, true, h.deps);

  assert.strictEqual(
    h.called('gh pr close').length,
    0,
    'closing it would discard last month\'s pending edits over a rate limit'
  );
});

test('a single unchecked entry is enough to defer retirement', async (t) => {
  // The entries that failed may be exactly the ones the open pull request
  // is fixing, and nothing here can tell which.
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: JSON.stringify([OUR_PR]), stderr: '' } },
  });
  const findings = classify([
    entry({ name: 'Fine' }),
    entry({ name: 'Broken', status: 'error', detail: 'HTTP 502' }),
  ]);

  await runFixMode(findings, true, h.deps);

  assert.strictEqual(h.called('gh pr close').length, 0);
});

test('a sweep that answered for everything still retires it', async (t) => {
  const h = prHarness(t, {
    overrides: { 'gh pr list': { ok: true, stdout: JSON.stringify([OUR_PR]), stderr: '' } },
  });

  await runFixMode(classify([entry({ name: 'Fine' })]), true, h.deps);

  assert.strictEqual(h.called('gh pr close').length, 1, 'a clean, complete sweep still cleans up');
});

// --- Paging the issue listing -----------------------------------------
// This endpoint returns pull requests as well as issues, so a single page of
// 100 covers far less of a repository's history than it looks like, and the
// report drifts down it monotonically. Falling off the end reads as "no
// report issue exists", which opens the duplicate the marker exists to
// prevent.

function pagedIssueHarness(t, pages) {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const realExitCode = process.exitCode;
  const calls = [];

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
    if (method !== 'GET') return { status: 200, ok: true, json: async () => ({ number: 123 }) };

    const page = Number(new URL(url).searchParams.get('page')) || 1;
    return { status: 200, ok: true, json: async () => pages[page - 1] || [] };
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

function filler(count, from) {
  return Array.from({ length: count }, (_, i) => ({
    number: from + i,
    state: 'closed',
    body: 'an unrelated issue',
    updated_at: '2026-09-01T00:00:00Z',
  }));
}

test('a report issue that has drifted onto a later page is still found', async (t) => {
  const calls = pagedIssueHarness(t, [
    filler(100, 200),
    [...filler(20, 300), marked({ number: 12, state: 'closed' })],
  ]);

  await reportIssue('## Gone (404)\n\n- **Dead**', 1);

  assert.strictEqual(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'a second report issue is exactly what the marker exists to prevent'
  );
  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write.url.endsWith('/issues/12'));
  assert.strictEqual(write.body.state, 'open');
});

test('a short first page is the last page, so the small case costs one request', async (t) => {
  const calls = pagedIssueHarness(t, [[marked()]]);

  await reportIssue('## Gone (404)', 1);

  assert.strictEqual(
    calls.filter((c) => c.method === 'GET').length,
    1,
    'paging must not cost a request per month while the repository is small'
  );
});

test('the listing is asked for in the order that keeps the report near the front', async (t) => {
  const calls = pagedIssueHarness(t, [[marked()]]);

  await reportIssue('## Gone (404)', 1);

  const query = new URL(calls[0].url).searchParams;
  assert.strictEqual(query.get('state'), 'all', 'state=open orphans the thread once it is closed');
  assert.strictEqual(query.get('sort'), 'updated');
  assert.strictEqual(query.get('direction'), 'desc');
});

test('running out of pages is a failed lookup, not an empty one', async (t) => {
  // Every page full to the limit means there may always be more. Deciding
  // "there is no report issue" from that is how the duplicate gets opened.
  const calls = pagedIssueHarness(t, Array.from({ length: 12 }, (_, p) => filler(100, p * 100)));
  process.exitCode = 0;

  await reportIssue('## Gone (404)', 1);

  assert.strictEqual(calls.filter((c) => c.method !== 'GET').length, 0, 'nothing filed');
  assert.strictEqual(process.exitCode, 1, 'and the failure stays visible');
});

test('a failure on a later page is not read as the end of the listing', async (t) => {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const realExitCode = process.exitCode;
  const calls = [];
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  t.after(() => {
    global.fetch = realFetch;
    process.env = realEnv;
    process.exitCode = realExitCode;
  });
  process.exitCode = 0;

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url });
    if (method !== 'GET') return { status: 200, ok: true, json: async () => ({ number: 1 }) };
    const page = Number(new URL(url).searchParams.get('page')) || 1;
    if (page === 1) return { status: 200, ok: true, json: async () => filler(100, 0) };
    return { status: 502, ok: false, json: async () => ({}) };
  };

  await reportIssue('## Gone (404)', 1);

  assert.strictEqual(calls.filter((c) => c.method !== 'GET').length, 0);
  assert.strictEqual(process.exitCode, 1);
});

// --- The pull request body file ----------------------------------------

test('the pull request body file does not outlive the run', (t) => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('entry-health-pr-'));
  const h = prHarness(t, {
    overrides: { 'gh pr create': { ok: true, stdout: 'https://github.com/owner/repo/pull/1', stderr: '' } },
  });

  openPullRequest('new content\n', [EDIT], [], null, h.deps);

  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('entry-health-pr-'));
  assert.deepStrictEqual(after, before, 'the temp directory should be cleaned up like verifyReadme does');
});

test('the body file is cleaned up even when gh fails', (t) => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('entry-health-pr-'));
  const h = prHarness(t, {
    overrides: { 'gh pr create': { ok: false, stdout: '', stderr: 'gh: not authenticated' } },
  });

  const result = openPullRequest('new content\n', [EDIT], [], null, h.deps);

  assert.strictEqual(result.ok, false);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('entry-health-pr-'));
  assert.deepStrictEqual(after, before);
});
