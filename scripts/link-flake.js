#!/usr/bin/env node
// Turns the link checker's retry noise into evidence.
//
// scripts/check-links.sh retries the whole markdown-link-check pass up to
// three times because external hosts intermittently drop connections. That
// keeps CI green, and it also means nobody ever finds out *which* hosts do
// it: a host that fails attempt 1 and passes attempt 2, every month, looks
// identical to a host that never fails at all. The ignorePatterns list in
// markdown.links.config.json was curated by hand, from memory, for exactly
// that reason.
//
//   summarize  reads the per-attempt logs one run left behind and writes
//              report.json: which URLs failed, on which attempt, and whether
//              a later attempt got them.
//   aggregate  reads several of those reports — download the build artifacts
//              from a few Validate Markdown runs, unzip them into one
//              directory, point this at it — and ranks hosts by how often
//              they flake, so an ignorePatterns entry can be argued for
//              instead of remembered.
//
// Exits 0 on anything short of bad arguments. This reports; check-links.sh
// gates.

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

// A host has to have flaked in this many separate runs before it is worth
// suggesting an ignorePatterns entry. One bad afternoon is not a pattern.
const CHRONIC_RUNS = 3;

// ...and it must never once have stayed dead through a whole run. A host
// that fails every attempt is not flaky, it is broken, and ignoring it would
// hide a dead link rather than a dropped connection — the one outcome this
// file exists to avoid. This was a ratio (0.8) and is now absolute: a ratio
// let a host with a genuinely dead URL be suggested on the strength of its
// other URLs flaking, which is precisely the trade nobody wants made
// silently. The printed stats still show every host, so a maintainer who
// wants to make that trade can see the evidence and make it deliberately.

// markdown-link-check --quiet prints only the failures, as:
//   "  ERROR: 2 dead links found in README.md !"
//   "  [x] https://example.com/x -> Status: 0"
// (with a heavy ballot X and a real arrow, matched below).
const FILE_RE = /^\s*ERROR:\s+\d+\s+dead links?\s+found\s+in\s+(.+?)\s*!\s*$/;
const DEAD_RE = /^\s*\[[\u2716\u2717x]\]\s+(\S+)\s+\u2192\s+Status:\s*(.+?)\s*$/;
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '(unparseable)';
  }
}

// --- summarize --------------------------------------------------------

function parseAttemptLog(text) {
  const failures = [];
  let file = '(unknown)';

  for (const raw of text.replace(ANSI_RE, '').split('\n')) {
    const fileMatch = raw.match(FILE_RE);
    if (fileMatch) {
      file = fileMatch[1];
      continue;
    }
    const deadMatch = raw.match(DEAD_RE);
    if (deadMatch) {
      failures.push({ url: deadMatch[1], status: deadMatch[2], file });
    }
  }

  return failures;
}

function summarize(flags) {
  const dir = flags.dir || '.link-check';
  const attempts = Number(flags.attempts || 3);
  const outcome = flags.outcome || 'unknown';

  const perAttempt = [];
  for (let n = 1; n <= attempts; n++) {
    const logPath = path.join(dir, `attempt-${n}.log`);
    if (!fs.existsSync(logPath)) break;
    perAttempt.push(parseAttemptLog(fs.readFileSync(logPath, 'utf8')));
  }

  // A URL counts as recovered when it failed on some attempt but not on the
  // last attempt this run actually made. That is the flake signature, and it
  // is exactly what the retry throws away.
  //
  // Except that "absent from the last log" only means "passed" if that log
  // is one we could read. When the final attempt dies without emitting
  // parseable dead-link lines — "ERROR: something went wrong!", a bad
  // config, DNS falling over — every URL is absent from it, and reading that
  // as recovery marks genuinely dead links as flaky. So a failed run whose
  // last attempt told us nothing yields no recovery claims at all.
  const attemptsRun = perAttempt.length;
  const lastAttempt = perAttempt[attemptsRun - 1] || [];
  const lastFailures = new Set(lastAttempt.map((f) => f.url));
  const lastAttemptParsed = lastAttempt.length > 0;
  const canJudgeRecovery = outcome !== 'failed' || lastAttemptParsed;

  const byUrl = new Map();
  perAttempt.forEach((failures, index) => {
    for (const failure of failures) {
      let record = byUrl.get(failure.url);
      if (!record) {
        record = {
          url: failure.url,
          host: hostOf(failure.url),
          file: failure.file,
          statuses: [],
          failedAttempts: [],
          recovered: false,
        };
        byUrl.set(failure.url, record);
      }
      record.failedAttempts.push(index + 1);
      if (!record.statuses.includes(failure.status)) record.statuses.push(failure.status);
    }
  });

  for (const record of byUrl.values()) {
    // Within a readable run this stays independent of the overall outcome on
    // purpose: a URL that failed attempt 1 and passed attempt 3 flaked, even
    // if some other URL was genuinely dead and took the run down with it.
    record.recovered = canJudgeRecovery && !lastFailures.has(record.url);
  }

  const failures = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));

  const hosts = new Map();
  for (const failure of failures) {
    const entry = hosts.get(failure.host) || { host: failure.host, failures: 0, recovered: 0 };
    entry.failures += 1;
    if (failure.recovered) entry.recovered += 1;
    hosts.set(failure.host, entry);
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    outcome,
    attempts,
    attemptsRun,
    // Recorded so aggregate can tell "nothing failed on the last attempt"
    // from "we could not read the last attempt".
    lastAttemptParsed,
    run: {
      repository: process.env.GITHUB_REPOSITORY || '',
      workflow: process.env.GITHUB_WORKFLOW || '',
      ref: process.env.GITHUB_REF_NAME || '',
      sha: process.env.GITHUB_SHA || '',
      runId: process.env.GITHUB_RUN_ID || '',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
    },
    failures,
    hosts: [...hosts.values()].sort((a, b) => b.failures - a.failures),
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const recovered = failures.filter((f) => f.recovered).length;
  console.log(
    `==> Flake summary: ${failures.length} URL(s) failed at least once across ` +
      `${attemptsRun} attempt(s), ${recovered} recovered on a retry ` +
      `(${path.join(dir, 'report.json')})`
  );
}

// --- aggregate --------------------------------------------------------

function collectReports(targets) {
  const found = [];

  const walk = (target) => {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      console.error(`Skipping ${target}: not found.`);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
      return;
    }
    if (!target.endsWith('.json')) return;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      return;
    }
    if (parsed && parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.failures)) {
      found.push({ file: target, report: parsed });
    }
  };

  for (const target of targets) walk(target);
  return found;
}

function aggregate(targets) {
  const reports = collectReports(targets);

  if (reports.length === 0) {
    console.error(
      'No link-check reports found. Point this at a directory of unzipped ' +
        '"link-check-report" build artifacts, or at report.json files directly.'
    );
    return;
  }

  const outcomes = { clean: 0, recovered: 0, failed: 0, unknown: 0 };
  const unreadable = [];

  const hosts = new Map();
  for (const { file, report } of reports) {
    const outcome = report.outcome || 'unknown';
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;

    // A failed run whose last attempt emitted nothing parseable cannot tell
    // recovery from silence. summarize already refuses to claim recovery in
    // that case; this is the reader's half of the same guard, so a report
    // written before that fix — or by a future version — cannot smuggle
    // optimistic flags in.
    const trustRecovery = outcome !== 'failed' || report.lastAttemptParsed === true;
    if (!trustRecovery) unreadable.push(file);

    const seenHosts = new Set();
    for (const failure of report.failures) {
      const entry = hosts.get(failure.host) || {
        host: failure.host,
        runs: 0,
        failures: 0,
        recovered: 0,
        stayedDead: 0,
        statuses: new Set(),
        urls: new Set(),
      };
      if (!seenHosts.has(failure.host)) {
        entry.runs += 1;
        seenHosts.add(failure.host);
      }
      entry.failures += 1;
      if (trustRecovery && failure.recovered) entry.recovered += 1;
      else entry.stayedDead += 1;
      for (const status of failure.statuses || []) entry.statuses.add(String(status));
      entry.urls.add(failure.url);
      hosts.set(failure.host, entry);
    }
  }

  const ranked = [...hosts.values()].sort((a, b) => b.runs - a.runs || b.failures - a.failures);

  console.log(
    `Aggregated ${reports.length} report(s) across ${ranked.length} host(s) — ` +
      `${outcomes.clean} clean, ${outcomes.recovered} recovered on retry, ` +
      `${outcomes.failed} failed.\n`
  );
  if (unreadable.length > 0) {
    console.log(
      `${unreadable.length} failed run(s) ended without a readable final ` +
        'attempt; their URLs are counted as failures but none as recovered.\n'
    );
  }
  for (const entry of ranked) {
    const rate = entry.failures === 0 ? 0 : entry.recovered / entry.failures;
    console.log(
      `${entry.host}\n` +
        `  failed in ${entry.runs}/${reports.length} run(s), ` +
        `${entry.failures} URL failure(s), ${entry.recovered} recovered on retry ` +
        `(${Math.round(rate * 100)}%), ${entry.stayedDead} stayed dead\n` +
        `  statuses: ${[...entry.statuses].join(', ') || 'n/a'}\n` +
        `  example: ${[...entry.urls][0]}`
    );
  }

  // Never suggested: a host that has stayed dead through even one whole run.
  // That is a broken link, and an ignorePatterns entry would be how it stops
  // being reported.
  const chronic = ranked.filter(
    (entry) => entry.runs >= CHRONIC_RUNS && entry.recovered > 0 && entry.stayedDead === 0
  );

  console.log('');
  if (chronic.length === 0) {
    console.log(
      `No host flaked in ${CHRONIC_RUNS}+ runs while recovering on retry every ` +
        'time. Nothing to add to ignorePatterns.'
    );
    return;
  }

  console.log(
    'Chronically flaky, and recovering on retry rather than staying dead.\n' +
      'Candidate ignorePatterns entries for ' +
      '.github/workflows/markdown.links.config.json:\n'
  );
  const patterns = chronic.map((entry) => ({
    pattern: `^https://${entry.host.replace(/\./g, '\\.')}/`,
  }));
  console.log(JSON.stringify(patterns, null, 2));
  console.log(
    '\nIgnoring a host means a genuinely dead link on it will never be ' +
      'caught again. Weigh that against how often it cries wolf before ' +
      'pasting any of these in.'
  );
}

// --- entry point ------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      rest.push(argv[i]);
    }
  }
  return { flags, rest };
}

// Exported for scripts/link-flake.test.js. The behaviour worth pinning is
// what this file is willing to call "recovered", because that is the claim
// an ignorePatterns entry would eventually be argued from.
module.exports = {
  parseAttemptLog,
  summarize,
  aggregate,
  hostOf,
  CHRONIC_RUNS,
  SCHEMA_VERSION,
};

if (require.main !== module) {
  return;
}

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parseFlags(argv);

if (command === 'summarize') {
  summarize(flags);
} else if (command === 'aggregate') {
  aggregate(rest.length > 0 ? rest : ['.link-check']);
} else {
  console.error(
    'Usage:\n' +
      '  node scripts/link-flake.js summarize [--dir .link-check] ' +
      '[--attempts 3] [--outcome clean|recovered|failed]\n' +
      '  node scripts/link-flake.js aggregate <report.json|directory>...'
  );
  process.exit(2);
}
