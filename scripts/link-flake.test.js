#!/usr/bin/env node
// Tests for link-flake.js, using node:test so nothing new is added to
// package.json. Run with `npm run test:flake`.
//
// What is worth pinning here is one claim: "recovered". It is the only thing
// this file asserts that could cost anything if it were wrong, because a
// host that looks like it recovers every time is a host that gets suggested
// for ignorePatterns — and an ignorePatterns entry is how a genuinely dead
// link stops being reported at all.
//
// The bug these tests exist for: `recovered` was computed as "absent from
// the last attempt log", so when a final attempt died without emitting any
// parseable dead-link lines — "ERROR: something went wrong!", a bad config,
// DNS falling over — every URL was absent from it, and a hard 404 on the two
// earlier attempts was recorded as having recovered.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAttemptLog, summarize, aggregate, CHRONIC_RUNS } = require('./link-flake.js');

const DEAD = '  [✖] https://dead.example/b → Status: 404';
const FLAKY = '  [✖] https://flaky.example/a → Status: 0';
const HEADER = (n) => `\n  ERROR: ${n} dead links found in README.md !`;

const BOTH = [HEADER(2), FLAKY, DEAD].join('\n');
const ONLY_DEAD = [HEADER(1), DEAD].join('\n');
const UNREADABLE = '\n  ERROR: something went wrong!';

function withRun(logs, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-flake-test-'));
  try {
    logs.forEach((text, i) => fs.writeFileSync(path.join(dir, `attempt-${i + 1}.log`), text));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

function report(logs, outcome) {
  return withRun(logs, (dir) => {
    quiet(() => summarize({ dir, attempts: 3, outcome }));
    return JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  });
}

function recoveredMap(r) {
  return Object.fromEntries(r.failures.map((f) => [f.url, f.recovered]));
}

// --- Parsing ----------------------------------------------------------

test('parses the dead-link lines markdown-link-check emits', () => {
  const parsed = parseAttemptLog(BOTH);
  assert.strictEqual(parsed.length, 2);
  assert.deepStrictEqual(
    parsed.map((f) => f.url).sort(),
    ['https://dead.example/b', 'https://flaky.example/a']
  );
  assert.strictEqual(parsed[0].file, 'README.md');
});

test('finds nothing in an attempt that died without a link report', () => {
  assert.deepStrictEqual(parseAttemptLog(UNREADABLE), []);
});

// --- The recovered claim ----------------------------------------------

test('a failed run with an unreadable last attempt claims no recovery at all', () => {
  const r = report([BOTH, BOTH, UNREADABLE], 'failed');
  assert.strictEqual(r.lastAttemptParsed, false);
  assert.deepStrictEqual(recoveredMap(r), {
    'https://dead.example/b': false,
    'https://flaky.example/a': false,
  });
});

test('a failed run with a readable last attempt still records the real flake', () => {
  const r = report([BOTH, BOTH, ONLY_DEAD], 'failed');
  assert.strictEqual(r.lastAttemptParsed, true);
  assert.deepStrictEqual(recoveredMap(r), {
    'https://dead.example/b': false,
    'https://flaky.example/a': true,
  });
});

test('a run that passed on retry records every earlier failure as recovered', () => {
  const r = report([BOTH, ''], 'recovered');
  assert.deepStrictEqual(recoveredMap(r), {
    'https://dead.example/b': true,
    'https://flaky.example/a': true,
  });
});

test('a clean run records no failures', () => {
  const r = report([''], 'clean');
  assert.deepStrictEqual(r.failures, []);
});

// --- What reaches an ignorePatterns suggestion -------------------------

function aggregateOutput(reports) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-flake-agg-'));
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    reports.forEach((r, i) => {
      const runDir = path.join(dir, `run${i}`);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(r));
    });
    aggregate([dir]);
    return lines.join('\n');
  } finally {
    console.log = log;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a dead host and a flaky host in the same corpus are told apart', () => {
  // Every run: both hosts fail, the flaky one comes back on attempt 3, the
  // dead one 404s throughout. The flaky host has earned a suggestion; the
  // dead one must never get one however many runs it appears in.
  const runs = [];
  for (let i = 0; i < CHRONIC_RUNS + 1; i++) {
    runs.push(report([BOTH, BOTH, ONLY_DEAD], 'failed'));
  }
  const out = aggregateOutput(runs);

  // Only the emitted pattern lines — the surrounding advice says the word
  // "dead" itself, which a substring check would trip over.
  const patterns = out.split('\n').filter((l) => l.includes('"pattern"'));
  assert.strictEqual(patterns.length, 1, `expected one pattern, got ${patterns.join(' ')}`);
  assert.ok(patterns[0].includes('flaky'), 'the flaky host should be suggested');
  assert.ok(!patterns[0].includes('dead'), 'the dead host must never be suggested');
  assert.match(out, /dead\.example\n {2}failed in 4\/4 run\(s\).*4 stayed dead/);
});

test('a host that recovers every time is suggested', () => {
  const runs = [];
  for (let i = 0; i < CHRONIC_RUNS; i++) {
    runs.push(report([[HEADER(1), FLAKY].join('\n'), ''], 'recovered'));
  }
  const out = aggregateOutput(runs);
  const patterns = out.split('\n').filter((l) => l.includes('"pattern"'));
  assert.strictEqual(patterns.length, 1);
  assert.ok(patterns[0].includes('flaky'));
});

test('reports from unreadable failed runs contribute no recovery credit', () => {
  // The path the two findings joined up on: three runs that each ended
  // unreadable used to mark every URL recovered, and three of those was
  // enough to print a pattern for a host that had 404ed throughout.
  const runs = [];
  for (let i = 0; i < CHRONIC_RUNS; i++) {
    runs.push(report([BOTH, BOTH, UNREADABLE], 'failed'));
  }
  const out = aggregateOutput(runs);
  assert.match(out, /Nothing to add to ignorePatterns/);
  assert.match(out, /ended without a readable final attempt/);
});

test('the aggregate header reports the outcome mix it was given', () => {
  const out = aggregateOutput([
    report([BOTH, ''], 'recovered'),
    report([BOTH, BOTH, ONLY_DEAD], 'failed'),
  ]);
  assert.match(out, /1 recovered on retry, 1 failed/);
});
