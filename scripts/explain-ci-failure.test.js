#!/usr/bin/env node
// Tests for explain-ci-failure.js, using node:test so nothing new is added
// to package.json. Run with `npm run test:pr-guidance`.
//
// This script runs with pull-requests: write against input a fork controls,
// so the two things worth testing are the two that decide whether that token
// is misused: which pull request it targets, and what it is willing to put
// in a comment body.
//
// The targeting bug these tests exist for was real. The first version read
// the pull request number out of the artifact, which the fork's own
// `npm run validate` had already had the chance to write — so any fork could
// make this repository's bot post on any pull request in the repo.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classify,
  buildBody,
  retirementBody,
  findExistingComment,
  codeSpan,
  selectPullRequest,
  crossCheck,
  MAX_PER_SECTION,
} = require('./explain-ci-failure.js');

const SHA = 'a'.repeat(40);
const FORK = 'attacker/awesome-embedded-security';

function pull(overrides) {
  return {
    number: 7,
    state: 'open',
    head: { sha: SHA, repo: { full_name: FORK } },
    ...overrides,
  };
}

// --- Targeting --------------------------------------------------------

test('selects the one open pull request whose head matches', () => {
  const result = selectPullRequest([pull()], { headSha: SHA, headRepo: FORK });
  assert.strictEqual(result.number, 7);
  assert.strictEqual(result.error, undefined);
});

test('ignores a pull request from a different head repository', () => {
  const result = selectPullRequest([pull({ head: { sha: SHA, repo: { full_name: 'someone/else' } } })], {
    headSha: SHA,
    headRepo: FORK,
  });
  assert.ok(result.error);
  assert.strictEqual(result.number, undefined);
});

test('ignores a pull request whose head is a different commit', () => {
  const result = selectPullRequest([pull({ head: { sha: 'b'.repeat(40), repo: { full_name: FORK } } })], {
    headSha: SHA,
    headRepo: FORK,
  });
  assert.ok(result.error);
});

test('ignores a closed pull request', () => {
  const result = selectPullRequest([pull({ state: 'closed' })], { headSha: SHA, headRepo: FORK });
  assert.ok(result.error);
});

test('refuses to guess when two pull requests share a head commit', () => {
  const result = selectPullRequest([pull({ number: 7 }), pull({ number: 9 })], {
    headSha: SHA,
    headRepo: FORK,
  });
  assert.match(result.error, /refusing to guess/);
  assert.strictEqual(result.number, undefined);
});

test('refuses when the lookup returned no list at all', () => {
  for (const bad of [null, undefined, {}, 'nope']) {
    const result = selectPullRequest(bad, { headSha: SHA, headRepo: FORK });
    assert.ok(result.error, `expected refusal for ${JSON.stringify(bad)}`);
  }
});

test('refuses when nothing matches', () => {
  const result = selectPullRequest([], { headSha: SHA, headRepo: FORK });
  assert.ok(result.error);
});

// --- Cross-check ------------------------------------------------------
//
// The artifact is allowed to agree and nothing else. This is the assertion
// that would have failed on the original code, which simply used the number
// the artifact supplied.

test('accepts an artifact number that agrees with the derived one', () => {
  assert.strictEqual(crossCheck(7, '7').number, 7);
});

test('refuses an artifact number that points somewhere else', () => {
  const result = crossCheck(7, '1');
  assert.match(result.error, /claims pull request #1/);
  assert.strictEqual(result.number, undefined);
});

test('refuses an absent, empty, or non-numeric artifact number', () => {
  for (const claimed of ['', '   ', undefined, null, 'abc', '7; rm -rf /', '007x']) {
    const result = crossCheck(7, claimed);
    assert.ok(result.error, `expected refusal for ${JSON.stringify(claimed)}`);
    assert.strictEqual(result.number, undefined);
  }
});

test('does not let a padded or float-ish number slip through as a match', () => {
  assert.ok(crossCheck(7, '7.0').error);
  assert.strictEqual(crossCheck(7, '007').number, 7); // numerically equal, digits only
});

// --- Escaping ---------------------------------------------------------

test('codeSpan neutralises markdown a fork would want rendered', () => {
  const span = codeSpan('**Approved by a maintainer** [policy](https://evil.example)');
  assert.ok(span.startsWith('`') && span.endsWith('`'));
  // Still present as text, but inside a code span, so it renders literally.
  assert.ok(span.includes('**Approved by a maintainer**'));
});

test('codeSpan strips backticks so the span cannot be closed early', () => {
  const span = codeSpan('a` **bold** `b');
  assert.strictEqual(span.split('`').length - 1, 2, 'only the wrapping pair may remain');
});

test('codeSpan strips newlines and control characters', () => {
  const span = codeSpan('one\ntwo\r\nthree\x00four');
  assert.ok(!/[\r\n\x00]/.test(span));
});

test('codeSpan bounds the length', () => {
  const span = codeSpan('x'.repeat(5000), 80);
  assert.ok(span.length <= 82, `got ${span.length}`);
});

test('codeSpan survives empty input without producing an empty span', () => {
  assert.strictEqual(codeSpan(''), '`(empty)`');
});

// --- End to end: a hostile artifact --------------------------------------

function withDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-guidance-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a fork cannot author rendered markdown in the comment body', () => {
  const body = withDir(
    {
      'validate.log': [
        'Found 1 issue(s) in README.md:',
        '',
        '  - README.md:1: duplicate URL "x" (already listed at line 2 as "y"). ' +
          '**Approved by a maintainer** see [policy](https://evil.example) <b>staff</b>',
      ].join('\n'),
      'README.md': '\n',
    },
    (dir) => buildBody(classify(dir), 'https://example/run')
  );

  assert.ok(body, 'the finding should still be reported');
  const quoted = body.split('\n').find((l) => l.includes('Approved by a maintainer'));
  assert.ok(quoted, 'the message is still quoted');
  assert.match(quoted, /^- `.*`$/, 'but only ever inside a code span');
});

test('a hostile README line is quoted inside a code span too', () => {
  const body = withDir(
    {
      'validate.log':
        '  ✖   1:1  List item link and description must be separated with a dash  remark-lint:awesome-list-item',
      'README.md':
        '* [Evil](https://example.com) \u{1F4B0} - **bold** [link](https://evil.example) lowercase start',
    },
    (dir) => buildBody(classify(dir), 'https://example/run')
  );

  const quoted = body.split('\n').find((l) => l.includes('Evil'));
  assert.match(quoted, /^- `README\.md:1` — `.*`$/);
});

test('says nothing when it recognises nothing', () => {
  const body = withDir(
    { 'validate.log': 'README.md:1 MD013/line-length Line length\n', 'README.md': '\n' },
    (dir) => buildBody(classify(dir), '')
  );
  assert.strictEqual(body, null);
});

test('caps how many findings of one kind it will list', () => {
  const lines = ['Found many issue(s) in README.md:', ''];
  for (let i = 1; i <= MAX_PER_SECTION + 5; i++) {
    lines.push(`  - README.md:${i}: duplicate URL "u${i}" (already listed at line 1 as "a").`);
  }
  const body = withDir({ 'validate.log': lines.join('\n'), 'README.md': '\n' }, (dir) =>
    buildBody(classify(dir), '')
  );
  assert.match(body, /and 5 more of the same/);
});

// --- Retirement: a comment must never outlive what it describes ----------
//
// The path that mattered, and it is the common one here: a contributor fixes
// the casing error and pushes, markdown-quality goes green, and the link
// check fails on one of the flaky hosts this repository retries three times
// for. The run's conclusion is `failure`, so the "it passes now" branch is
// skipped, and buildBody returns null because nothing in the log is
// recognised — which used to mean the old comment stayed up, pointing at a
// line that no longer has anything wrong with it.

test('retirement says the run is green when it is green', () => {
  process.env.RUN_CONCLUSION = 'success';
  const body = retirementBody(false, 'https://example/run');
  assert.match(body, /passes now/);
  assert.ok(body.startsWith('<!-- pr-guidance-comment -->'), 'must keep the marker');
  delete process.env.RUN_CONCLUSION;
});

test('retirement does not claim green when the run is still red', () => {
  process.env.RUN_CONCLUSION = 'failure';
  const body = retirementBody(false, 'https://example/run');
  assert.ok(!/passes now/.test(body), 'must not tell a red pull request it is green');
  assert.match(body, /still failing/);
  assert.match(body, /example\/run/, 'points at the run log instead');
  delete process.env.RUN_CONCLUSION;
});

test('retirement distinguishes an unreadable run from an unrecognised one', () => {
  process.env.RUN_CONCLUSION = 'failure';
  assert.match(retirementBody(true, ''), /could not be read/);
  assert.match(retirementBody(false, ''), /not for a reason this bot can explain/);
  delete process.env.RUN_CONCLUSION;
});

test('every retirement body carries the marker so it can be found again', () => {
  for (const conclusion of ['success', 'failure']) {
    process.env.RUN_CONCLUSION = conclusion;
    for (const retireOnly of [true, false]) {
      assert.ok(retirementBody(retireOnly, '').includes('<!-- pr-guidance-comment -->'));
    }
  }
  delete process.env.RUN_CONCLUSION;
});

// --- Pagination ---------------------------------------------------------
//
// The header promises one comment rewritten in place rather than one per
// push. On a thread longer than a single page, an unpaginated search would
// never find the marker and would post again every time — the promise broken
// exactly where a long thread makes it most irritating.

// Must await fn before restoring: returning the promise from inside
// try/finally puts the real fetch back before the first page resolves, so
// only page one ever goes through the stub.
async function withFetch(pages, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, json: async () => pages[page - 1] || [] };
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

const filler = () => Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'unrelated' }));

test('finds its own comment on a later page', async () => {
  const pages = [filler(), filler(), [{ id: 999, body: `x <!-- pr-guidance-comment --> y` }]];
  const found = await withFetch(pages, async (seen) => {
    const c = await findExistingComment('o', 'r', 1);
    assert.strictEqual(seen.length, 3, 'should have paged through to find it');
    return c;
  });
  assert.strictEqual(found.id, 999);
});

test('stops at a short page rather than paging forever', async () => {
  const pages = [filler(), [{ id: 1, body: 'nothing here' }]];
  const found = await withFetch(pages, async (seen) => {
    const c = await findExistingComment('o', 'r', 1);
    assert.strictEqual(seen.length, 2, 'a short page is the last page');
    return c;
  });
  assert.strictEqual(found, null);
});

test('gives up after a bounded number of pages', async () => {
  const pages = Array.from({ length: 50 }, filler);
  await withFetch(pages, async (seen) => {
    await findExistingComment('o', 'r', 1);
    assert.ok(seen.length <= 10, `paged ${seen.length} times; must be bounded`);
  });
});

// --- The opener rule must match awesome-lint's, not merely resemble it ---

test('an accented capital is still reported, because awesome-lint rejects it', () => {
  // awesome-lint's escape hatch is / - [A-Z]/ — ASCII only. \p{Lu} matched É
  // and Å, so the linter failed while this stayed silent on exactly the case
  // it exists for. Verified against awesome-lint 2.3.0, rules/list-item.js.
  for (const opener of ['Émulateur de firmware.', 'Ångstrom-level report.']) {
    const body = withDir(
      {
        'validate.log':
          '  ✖   1:1  List item link and description must be separated with a dash  remark-lint:awesome-list-item',
        'README.md': `* [Foo](https://example.com) \u{1F4B0} - ${opener}`,
      },
      (dir) => buildBody(classify(dir), '')
    );
    assert.ok(body, `expected guidance for "${opener}"`);
    assert.match(body, /must be separated with a dash/);
  }
});

test('an ASCII capital opener is left alone, since awesome-lint accepts it', () => {
  const body = withDir(
    {
      'validate.log':
        '  ✖   1:1  List item link and description must be separated with a dash  remark-lint:awesome-list-item',
      'README.md': '* [Foo](https://example.com) \u{1F4B0} - Emulator for firmware.',
    },
    (dir) => buildBody(classify(dir), '')
  );
  assert.strictEqual(body, null, 'a genuine dash error needs no translation');
});
