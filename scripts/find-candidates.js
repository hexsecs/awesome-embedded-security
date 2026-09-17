#!/usr/bin/env node
// Proposes *additions* to README.md. Every other check in this repository is
// defensive — the link check, check-readme.js and check-staleness.js all exist
// to stop the 285 entries already here from rotting. Nothing proposes a
// change, so the list can only grow when a human happens to notice a project
// and opens a PR. The failure mode this guards against is therefore silence:
// a list that is well maintained and slowly falling behind its subject.
//
// It searches GitHub for repositories matching the list's subject matter,
// subtracts everything already listed and everything a maintainer has already
// declined, ranks what is left, caps the result at a reviewable number, and
// drafts each one as a ready-to-paste entry line complete with the section
// and the exact alphabetical position it belongs at.
//
// Run locally with `npm run find:candidates`. In CI it runs monthly and, with
// --report-issue, files its findings as a single GitHub issue that it
// rewrites in place rather than opening a new one every month.
//
// It NEVER edits README.md, and that is deliberate rather than an
// implementation shortcut. Whether a project belongs on this list is a
// judgement about topical relevance, quality and overlap with what is
// already here, and a keyword search cannot make it: a search for "sdr"
// cannot tell a signal-analysis toolkit apart from a ham-radio logbook, and
// star count is a measure of popularity, not of fit. Everything below is a
// proposal addressed to a human reviewer.
//
// Exits 0 even when it proposes nothing: this reports, it does not gate.

'use strict';

const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, '..', 'README.md');
const DECLINED_PATH = path.join(__dirname, 'declined-candidates.json');

// --- The search ------------------------------------------------------
// Tune these by editing the list; nothing below reads them except the query
// builder. Each entry costs exactly one GitHub search request per run, and
// the search API's quota is far tighter than the core API's (30 requests per
// minute authenticated, 10 unauthenticated, against 5000 per hour for core),
// so adding terms is cheap but not free — see preflight() below.
//
// Two shapes are used on purpose. A `topic:` query is precise, because the
// topic was applied by the project's own maintainers, but only covers
// projects that bothered to tag themselves. A free-text query catches the
// rest at the cost of noise. Broad topics that are not security-specific on
// their own (`bootloader`, `sdr`, `can-bus`, `uefi`) are paired with a
// security term, because unpaired they return mostly hobby firmware and
// drown everything else in the ranking.
const SEARCH_TERMS = [
  // Topics that are already scoped to this list's subject.
  'topic:embedded-security',
  'topic:firmware-security',
  'topic:iot-security',
  'topic:hardware-hacking',
  'topic:side-channel',
  'topic:fault-injection',
  'topic:secure-boot',
  'topic:jtag',
  // Broad topics, narrowed with a security term.
  'topic:bootloader security',
  'topic:uefi firmware security',
  'topic:sdr security analysis',
  'topic:can-bus security automotive',
  'topic:rtos security',
  // Free text, for projects that never tagged themselves.
  'glitching in:name,description,topics',
  'firmware emulation rehosting in:name,description,topics',
];

// Quality thresholds. These are not a judgement about the software; they are
// what makes the monthly report short enough to read.
//
// MIN_STARS: below roughly this, a repository usually has no users beyond its
// author, and the list is curated rather than a directory. It is the single
// biggest lever on report size — halving it roughly triples the candidate
// pool.
const MIN_STARS = 150;

// PUSHED_WITHIN_MONTHS: a *new* proposal should be currently alive. Note this
// is stricter than check-staleness.js's 24-month "quiet" threshold, and
// deliberately so: contributing.md is right that a dormant project is often
// still the best tool in its niche, but that is a call a human makes when
// they already know the niche. A script proposing a four-year-dead repository
// to a reviewer who has never heard of it is just noise.
const PUSHED_WITHIN_MONTHS = 18;

// MAX_CANDIDATES: a report of 200 candidates is the same as no report,
// because nobody reviews it twice. Twelve is about one sitting.
const MAX_CANDIDATES = 12;

// How many results to pull per query. GitHub allows 100; 50 is plenty once
// the results are sorted by stars, and keeps the responses small.
const SEARCH_PER_PAGE = 50;

const API_ROOT = 'https://api.github.com';

// Searches run a few at a time. The search API's limit is per *minute*, so a
// burst of 15 requests at once is the thing most likely to trip it.
const CONCURRENCY = 3;

// Core-API requests this run makes outside of search: one to find an existing
// report issue, one to write it.
const CORE_REQUESTS = 2;

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

function apiHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'awesome-embedded-security-candidate-discovery',
  };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  return headers;
}

// --- Normalization shared with the rest of the tooling ----------------
// Both of these are lifted from check-readme.js on purpose. normalizeUrl has
// to agree with the duplicate detector or a trailing slash produces a phantom
// candidate for a project that is already listed; sortKey has to agree with
// the alphabetical-order check or the position this script suggests is one
// the order check will then reject.

// Sort key for an entry label. Leading punctuation only is dropped, so
// ".NET" files under N while pairs like "EM-Fault-It-Yourself"/"emba" keep
// their existing order.
function sortKey(label) {
  return label.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '');
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathName = u.pathname.replace(/\/+$/, '');
    return `${host}${pathName}${u.search}`;
  } catch {
    return String(url).trim().replace(/\/+$/, '');
  }
}

// --- What the list already contains -----------------------------------

const LINK_ITEM_RE = /^(\s*)\*\s+\[([^\]]+)\]\(([^)]+)\)/;

// Parses README.md into the three things the diff and the placement need:
// every URL already listed, every entry name already listed, and each ###
// section's entries with their line numbers.
//
// The Table of Contents is skipped for the same reason check-readme.js skips
// it: its items are markdown links too, and they point at anchors.
function readList(lines) {
  const urls = new Map(); // normalized URL -> entry label
  const names = new Map(); // sortKey(label) -> label
  const sections = new Map(); // "### heading" name -> section

  const tocStart = lines.findIndex((l) => l.trim() === '## Contents');
  const tocEnd =
    tocStart === -1
      ? -1
      : lines.findIndex((l, i) => i > tocStart && /^##\s+/.test(l));
  const tocLast = tocEnd === -1 ? lines.length : tocEnd;

  let currentTop = '';
  let current = null;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      currentTop = h2[1];
      current = null;
      return;
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      current = {
        name: h3[1],
        parent: currentTop,
        headingLine: lineNo,
        entries: [],
      };
      sections.set(h3[1], current);
      return;
    }

    if (tocStart !== -1 && idx > tocStart && idx < tocLast) return;

    const match = line.match(LINK_ITEM_RE);
    if (!match) return;

    const [, indent, label, rawUrl] = match;
    const name = label.trim();
    const url = rawUrl.trim();

    if (url && !url.startsWith('#')) {
      const key = normalizeUrl(url);
      if (!urls.has(key)) urls.set(key, name);
      if (!names.has(sortKey(name))) names.set(sortKey(name), name);
    }

    // Only top-level items participate in a section's alphabetical run.
    // Nested lists (the language groups under Language Specific Decompilers,
    // the categories under Other Awesome Lists) are ordered against
    // themselves, and this script never proposes into them — see
    // SECTION_KEYWORDS.
    if (indent.length === 0 && current) {
      current.entries.push({ label: name, lineNo });
    }
  });

  return { urls, names, sections };
}

// --- The declined list ------------------------------------------------
// Without this, a project a maintainer looked at and said no to comes back
// next month, and the month after that, and by the third identical report
// everyone has muted the issue. It is the difference between a useful
// monthly report and one nobody reads, so it is committed to the repository
// rather than kept in workflow state.
//
// Format: scripts/declined-candidates.json, an object with a "declined"
// array. Each element needs "url" and "reason"; "date" is conventional.
// URLs are matched after normalization, so http/https, a trailing slash and
// a www. prefix are all the same entry.
function parseDeclined(raw, source = DECLINED_PATH) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (!data || !Array.isArray(data.declined)) {
    throw new Error(`${source} must contain a "declined" array.`);
  }

  const urls = new Map(); // normalized URL -> reason
  for (const item of data.declined) {
    if (!item || typeof item.url !== 'string' || !item.url.trim()) {
      throw new Error(`${source}: every declined entry needs a "url".`);
    }
    if (typeof item.reason !== 'string' || !item.reason.trim()) {
      throw new Error(
        `${source}: "${item.url}" has no "reason". A decline with no reason ` +
          'cannot be revisited, so one is required.'
      );
    }
    urls.set(normalizeUrl(item.url.trim()), item.reason.trim());
  }
  return urls;
}

// A malformed declined list is fatal rather than ignored. Silently treating
// it as empty would re-propose everything a maintainer has already rejected,
// which is precisely the failure this file exists to prevent.
function readDeclined() {
  if (!fs.existsSync(DECLINED_PATH)) {
    throw new Error(
      `${DECLINED_PATH} is missing. It is committed to the repository so ` +
        'that declined projects stay declined; restore it rather than ' +
        'running without it.'
    );
  }
  return parseDeclined(fs.readFileSync(DECLINED_PATH, 'utf8'));
}

// --- Section proposal -------------------------------------------------
// A keyword table, not a classifier. Matching is on whole words against the
// repository's name, description and topics, with hyphens treated as spaces
// so the `fault-injection` topic matches the "fault injection" keyword.
//
// Two sections are deliberately absent. "Language Specific Decompilers" and
// the categories under "Other Awesome Lists" are nested lists, and a nested
// list needs a sub-category decision this table cannot make. Anything that
// would land there gets no suggestion, which is the honest answer.
const SECTION_KEYWORDS = [
  ['Binary Parsing and Analysis Tools', ['binwalk', 'firmware extraction', 'unpacking', 'file carving', 'binary analysis', 'elf', 'executable format', 'filesystem extraction']],
  ['Disassemblers/Decompilers', ['disassembler', 'decompiler', 'decompilation', 'ghidra', 'ida pro', 'lifter']],
  ['Debugging Tools', ['debugger', 'gdb', 'gdbserver', 'debug probe', 'swd', 'on chip debugging']],
  ['USB Emulation and Fuzzing', ['usb emulation', 'usb device emulation', 'facedancer', 'usb fuzzing', 'usb gadget']],
  ['Secure Boot and Firmware Trust', ['secure boot', 'secureboot', 'verified boot', 'measured boot', 'bootloader', 'coreboot', 'chain of trust']],
  ['Firmware Supply Chain and SBOM', ['sbom', 'supply chain', 'cyclonedx', 'spdx', 'provenance', 'attestation', 'vex']],
  ['Fuzzing Tools', ['fuzzing', 'fuzzer', 'fuzz', 'afl', 'libfuzzer', 'coverage guided']],
  ['Security Auditing Frameworks', ['audit', 'auditing', 'assessment framework', 'penetration testing', 'security scanner']],
  ['Firmware Taint Analysis', ['taint analysis', 'taint', 'dataflow analysis', 'symbolic execution', 'concolic']],
  ['RTOS Security', ['rtos', 'freertos', 'zephyr', 'threadx', 'rt thread', 'nuttx', 'mbed os']],
  ['TEE/Trusted Execution Environments', ['tee', 'trustzone', 'optee', 'op tee', 'sgx', 'enclave', 'trusted execution', 'keystone']],
  ['Root of Trust and TPM', ['tpm', 'root of trust', 'hsm', 'secure element', 'caliptra', 'remote attestation', 'dice']],
  ['OTA Update Security', ['ota', 'over the air', 'firmware update', 'swupdate', 'mender', 'suit manifest', 'rauc']],
  ['IoT Protocol Security', ['mqtt', 'coap', 'modbus', 'lorawan', 'iot protocol', 'matter', 'thread protocol']],
  ['Bluetooth and BLE Security', ['bluetooth', 'ble', 'bluetooth low energy', 'hci', 'gatt']],
  ['Zigbee / Z-Wave Security', ['zigbee', 'z wave', 'zwave', '802 15 4', 'ieee802154']],
  ['Baseband Security', ['baseband', 'cellular', 'lte', 'gsm', '5g', 'srsran', 'modem']],
  ['Firmware Malware Analysis', ['malware', 'implant', 'rootkit', 'bootkit', 'yara', 'uefi malware']],
  ['Emulation Tools', ['emulation', 'emulator', 'qemu', 'unicorn', 'rehosting', 'firmware emulation']],
  ['MCU Firmware Fuzzing', ['mcu fuzzing', 'firmware fuzzing', 'microcontroller fuzzing', 'peripheral modeling']],
  ['Hardware Reverse Engineering Multitools', ['multitool', 'bus pirate', 'hardware hacking tool', 'flipper zero']],
  ['Hardware Debug Interfaces', ['jtag', 'boundary scan', 'jtagulator', 'swd probe', 'tap controller']],
  ['USB Protocol Analysis', ['usb analyzer', 'usb sniffer', 'usb protocol analysis', 'usb capture']],
  ['Chip-Off and Memory Forensics', ['chip off', 'nand', 'emmc', 'spi flash', 'flash dump', 'memory forensics', 'bga']],
  ['Side-Channel Analysis', ['side channel', 'sidechannel', 'power analysis', 'dpa', 'cpa', 'electromagnetic analysis', 'chipwhisperer', 'cache attack']],
  ['Fault Injection', ['fault injection', 'glitching', 'glitch', 'voltage glitching', 'clock glitching', 'emfi', 'laser fault']],
  ['Logic Analyzers', ['logic analyzer', 'sigrok', 'saleae', 'protocol decoder']],
  ['NFC and RFID', ['nfc', 'rfid', 'mifare', 'proxmark', 'iso14443', 'desfire']],
  ['RF Tools (Non-SDR)', ['sub ghz', 'cc1101', 'rf transceiver', 'garage door', 'keyfob']],
  ['Software Defined Radio Software', ['sdr', 'gnuradio', 'gnu radio', 'rtl sdr', 'software defined radio', 'signal analysis']],
  ['Wi-Fi Tools', ['wifi', 'wi fi', '802 11', 'wpa', 'wpa2', 'deauth']],
];

// Topics worth extra weight in the ranking: a project that tagged itself with
// one of these is asserting it belongs to this subject, which is a stronger
// signal than a word appearing somewhere in its description.
const TOPIC_SIGNALS = new Set([
  'embedded-security',
  'firmware-security',
  'hardware-security',
  'iot-security',
  'hardware-hacking',
  'side-channel',
  'side-channel-attacks',
  'fault-injection',
  'glitching',
  'secure-boot',
  'reverse-engineering',
  'firmware-analysis',
  'jtag',
  'uefi',
]);

// Lowercase, collapse everything that is not a letter or digit to a single
// space, and pad the ends, so `includes(' jtag ')` is a whole-word test. This
// is what stops "pe" matching "pipeline" and "sdr" matching "sdrangelove".
function haystack(repo) {
  const parts = [repo.name || '', repo.description || '', ...(repo.topics || [])];
  return ` ${parts.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function hasWord(hay, keyword) {
  const normalized = keyword.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalized ? hay.includes(` ${normalized} `) : false;
}

// Returns the best-scoring section and the keywords that got it there, so the
// report can show its working and a reviewer can disagree cheaply.
function proposeSection(repo) {
  const hay = haystack(repo);
  let best = null;

  for (const [name, keywords] of SECTION_KEYWORDS) {
    const matched = keywords.filter((k) => hasWord(hay, k));
    if (matched.length === 0) continue;
    if (!best || matched.length > best.matched.length) {
      best = { name, matched };
    }
  }

  return best;
}

// --- Alphabetical placement ------------------------------------------
// Computed with the same sortKey the order check uses, so the position
// suggested here is one check-readme.js will accept.

function placeInSection(section, name) {
  const key = sortKey(name);
  const entries = section.entries;

  if (entries.length === 0) {
    // Heading, blank line, then the first entry.
    return { lineNo: section.headingLine + 2, after: null, before: null };
  }

  let i = 0;
  while (i < entries.length && sortKey(entries[i].label).localeCompare(key) < 0) {
    i++;
  }

  if (i === entries.length) {
    const last = entries[entries.length - 1];
    return { lineNo: last.lineNo + 1, after: last, before: null };
  }

  return {
    lineNo: entries[i].lineNo,
    after: i > 0 ? entries[i - 1] : null,
    before: entries[i],
  };
}

// --- Drafting the entry line ------------------------------------------
// The rules are contributing.md's, and two of them are enforced by
// awesome-lint with error messages that point somewhere else entirely, so
// they are worth getting right here: a description must not start with the
// entry's own name, and it must start with a capital.
//
// Where a description cannot be derived that satisfies them, this returns
// null and a reason. A plausible-sounding wrong description is worse than a
// blank one: a reviewer will believe the blank and check it, and will believe
// the wrong one too.

// Emoji and variation selectors are stripped because in this list 💰 and 🗄️
// between the link and the dash are load-bearing markers, and a stray emoji
// carried over from a repository description reads as one.
const DECORATION_RE = /[\p{Extended_Pictographic}︎️‍]/gu;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds a pattern that matches the project name however it is punctuated,
// so "OP-TEE" in the name also matches "OP TEE" or "OPTEE" at the head of
// the description.
function namePattern(name) {
  const runs = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(escapeRegExp);
  if (runs.length === 0) return null;
  return runs.join('[^A-Za-z0-9]*');
}

function draftDescription(name, repo) {
  const raw = (repo.description || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return { text: null, problem: 'the repository has no description of its own' };
  }

  // Markdown links in a description would nest brackets inside the entry
  // line and break the entry regexes; keep the link text only.
  let text = raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(DECORATION_RE, '')
    .replace(/\s+/g, ' ')
    .trim();

  // awesome-lint rejects a description that opens with the entry's own name.
  // Drop it, along with whatever separator or copula follows.
  const pattern = namePattern(name);
  if (pattern) {
    const lead = new RegExp(
      `^(?:the\\s+)?${pattern}\\s*(?:[-–—:,|]+\\s*)?(?:is|are)?\\s*(?:a|an|the)?\\s*`,
      'i'
    );
    const stripped = text.replace(lead, '').trim();
    if (stripped !== text) {
      // Under this and there is nothing left but the name and a tagline
      // fragment; better to say so than to ship two words.
      if (stripped.length < 25) {
        return {
          text: null,
          problem:
            'the description is essentially the project name again, and ' +
            'awesome-lint rejects a description that starts with it',
        };
      }
      text = stripped;
    }
  }

  // awesome-lint requires a capital first letter. Uppercasing a plain
  // lowercase word is safe; uppercasing something that looks like an
  // identifier ("probe-rs", "u-boot", "esp32") corrupts a name, so those are
  // handed back for a human to reword.
  const firstWord = text.split(/\s+/)[0] || '';
  if (/^[a-z]/.test(text)) {
    if (/^[a-z]+$/.test(firstWord)) {
      text = text[0].toUpperCase() + text.slice(1);
    } else {
      return {
        text: null,
        problem:
          `the description starts with "${firstWord}", which looks like a ` +
          'case-sensitive identifier rather than a word — it needs a ' +
          'hand-written opening to satisfy awesome-lint\'s casing rule',
      };
    }
  } else if (!/^[\p{Lu}\p{N}]/u.test(text)) {
    return {
      text: null,
      problem: 'the description does not start with a letter or a digit',
    };
  }

  if (!/[.!?]$/.test(text)) text += '.';

  return { text, problem: null };
}

// 💰 is about licensing, not price. From repository metadata the only honest
// signal is a missing or non-OSI license, and that is weak enough that it is
// surfaced as "check this" rather than applied to the drafted line.
function markerHint(repo) {
  const spdx = repo.license && repo.license.spdx_id;
  if (!spdx || spdx === 'NOASSERTION') {
    return (
      'no recognised open-source license on the repository — check whether ' +
      'this is a commercial or source-available product and needs 💰'
    );
  }
  return null;
}

// --- Selection --------------------------------------------------------

function monthsAgo(months, now) {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - months);
  return d;
}

// Turns raw search results into a ranked, capped candidate list. Everything
// here is pure so the test can drive it with synthetic API responses.
//
// `results` is one entry per query, each either {status:'ok', items} or
// {status:'error', detail}. An errored query contributes to `unchecked` and
// never to the candidates — a search that failed is not evidence that
// nothing exists.
function selectCandidates(results, list, declined, now = new Date()) {
  const unchecked = [];
  const byFullName = new Map();

  for (const result of results) {
    if (result.status !== 'ok') {
      unchecked.push(result);
      continue;
    }
    for (const repo of result.items || []) {
      if (!repo || !repo.full_name) continue;
      const key = repo.full_name.toLowerCase();
      const existing = byFullName.get(key);
      if (existing) {
        existing.queries.add(result.query);
        continue;
      }
      byFullName.set(key, { repo, queries: new Set([result.query]) });
    }
  }

  const cutoff = monthsAgo(PUSHED_WITHIN_MONTHS, now);
  const rejected = {
    archived: 0,
    fork: 0,
    lowStars: 0,
    dormant: 0,
    listed: 0,
    declined: 0,
  };

  const kept = [];

  for (const { repo, queries } of byFullName.values()) {
    // The search qualifiers already ask for these, but they are re-checked
    // here because a maintainer tuning SEARCH_TERMS should not be able to
    // silently disable a threshold by dropping a qualifier.
    //
    // Archived repositories are excluded outright rather than proposed with a
    // 🗄️ marker. contributing.md is clear that archived is not a reason to
    // *remove* an entry — a frozen paper artifact can still be the best thing
    // in its niche — but that is an argument for keeping something the list
    // already has, not for adding something new and pre-dead. If an archived
    // project genuinely belongs here, a human should add it by hand with the
    // marker and a sentence saying why.
    if (repo.archived) {
      rejected.archived++;
      continue;
    }
    if (repo.fork) {
      rejected.fork++;
      continue;
    }
    if ((repo.stargazers_count || 0) < MIN_STARS) {
      rejected.lowStars++;
      continue;
    }
    if (!repo.pushed_at || new Date(repo.pushed_at) < cutoff) {
      rejected.dormant++;
      continue;
    }

    // Already-listed check, three ways. The URL comparison uses the same
    // normalization as the duplicate detector, so a trailing slash or a www.
    // does not produce a phantom candidate. The homepage is checked too
    // because plenty of entries link a project's own site rather than its
    // repository, and the name because neither URL would catch a project
    // listed under a mirror or a docs host.
    const urlKey = normalizeUrl(repo.html_url || '');
    const homeKey = repo.homepage ? normalizeUrl(repo.homepage) : null;
    if (list.urls.has(urlKey) || (homeKey && list.urls.has(homeKey))) {
      rejected.listed++;
      continue;
    }
    if (list.names.has(sortKey(repo.name || ''))) {
      rejected.listed++;
      continue;
    }

    if (declined.has(urlKey) || (homeKey && declined.has(homeKey))) {
      rejected.declined++;
      continue;
    }

    kept.push(buildCandidate(repo, queries, list));
  }

  // Ranking, kept deliberately simple so a maintainer can read a score off
  // the report and say "that is wrong" without reading this file:
  //   3 points per distinct query that found it — being reachable from two
  //     different angles is the strongest available signal that a project is
  //     really about this subject rather than a keyword coincidence;
  //   2 points per self-applied topic from TOPIC_SIGNALS;
  //   log10(stars) as a tiebreak, so popularity nudges rather than decides.
  kept.sort((a, b) => b.score - a.score || b.stars - a.stars);

  return {
    candidates: kept.slice(0, MAX_CANDIDATES),
    considered: byFullName.size,
    keptCount: kept.length,
    rejected,
    unchecked,
    queriesRun: results.length,
  };
}

function buildCandidate(repo, queries, list) {
  const topics = repo.topics || [];
  const topicHits = topics.filter((t) => TOPIC_SIGNALS.has(t));
  const stars = repo.stargazers_count || 0;
  const score =
    3 * queries.size + 2 * topicHits.length + Math.log10(stars + 1);

  const name = repo.name;
  const description = draftDescription(name, repo);
  const section = proposeSection(repo);
  const known = section ? list.sections.get(section.name) : null;

  return {
    name,
    fullName: repo.full_name,
    url: repo.html_url,
    homepage: repo.homepage || null,
    stars,
    pushedAt: repo.pushed_at,
    topics,
    topicHits,
    queries: [...queries],
    score,
    description,
    section: section ? section.name : null,
    sectionMatches: section ? section.matched : [],
    placement: known ? placeInSection(known, name) : null,
    markerHint: markerHint(repo),
  };
}

// --- Render -----------------------------------------------------------

function entryLine(candidate) {
  return `* [${candidate.name}](${candidate.url}) - ${candidate.description.text}`;
}

function render(selection) {
  const out = [];
  const { candidates, unchecked, queriesRun, considered, keptCount, rejected } =
    selection;
  const searched = queriesRun - unchecked.length;

  out.push(
    `Searched ${searched} of ${queriesRun} queries and found ${considered} ` +
      `distinct repositories; ${keptCount} survived the filters and the ` +
      `top ${candidates.length} are below.`
  );
  out.push('');
  out.push(
    '**Nothing here has been added to the list.** These are proposals. ' +
      'Whether a project belongs on this list is a judgement about topical ' +
      'relevance, quality and overlap with what is already here, and a ' +
      'keyword search cannot make it — the section and description below ' +
      'are drafts to edit, not answers.'
  );
  out.push('');

  if (candidates.length > 0) {
    out.push('## Candidates');
    out.push('');

    candidates.forEach((c, i) => {
      out.push(`### ${i + 1}. ${c.name} (${c.stars.toLocaleString('en-US')} ★)`);
      out.push('');

      if (c.description.text) {
        out.push('```md');
        out.push(entryLine(c));
        out.push('```');
      } else {
        out.push(
          `No entry line drafted: ${c.description.problem}. ` +
            `The line needs a description written by hand — ` +
            `\`* [${c.name}](${c.url}) - …\``
        );
      }
      out.push('');

      if (c.section && c.placement) {
        const where = c.placement.before
          ? c.placement.after
            ? `between **${c.placement.after.label}** and **${c.placement.before.label}**`
            : `ahead of **${c.placement.before.label}**, as the first entry`
          : c.placement.after
            ? `after **${c.placement.after.label}**, as the last entry`
            : 'as the only entry';
        out.push(
          `- **Section:** \`### ${c.section}\` — insert at README.md:` +
            `${c.placement.lineNo}, ${where}`
        );
      } else if (c.section) {
        out.push(
          `- **Section:** \`### ${c.section}\` — heading not found in ` +
            'README.md, so no position was computed'
        );
      } else {
        out.push(
          '- **Section:** no suggestion. Nothing in the repository metadata ' +
            'matched a section, or it belongs in a nested list this script ' +
            'does not place into.'
        );
      }

      out.push(`- **Repository:** ${c.url}`);
      if (c.homepage) out.push(`- **Homepage:** ${c.homepage}`);
      out.push(
        `- **Signal:** score ${c.score.toFixed(1)} — found by ` +
          `${c.queries.length} quer${c.queries.length === 1 ? 'y' : 'ies'} ` +
          `(${c.queries.map((q) => `\`${q}\``).join(', ')})` +
          (c.topicHits.length
            ? `; topics ${c.topicHits.map((t) => `\`${t}\``).join(', ')}`
            : '') +
          `; last push ${String(c.pushedAt).slice(0, 10)}`
      );
      if (c.sectionMatches.length > 0) {
        out.push(
          `- **Section matched on:** ` +
            c.sectionMatches.map((m) => `\`${m}\``).join(', ')
        );
      }
      if (c.markerHint) out.push(`- **Marker:** ${c.markerHint}`);
      out.push(
        `- **Not wanted?** Add it to \`scripts/declined-candidates.json\` ` +
          'with a reason and it will not be proposed again.'
      );
      out.push('');
    });
  }

  if (candidates.length === 0 && unchecked.length < queriesRun) {
    out.push('## Nothing to propose');
    out.push('');
    out.push(
      'Every repository the searches returned is either already listed, ' +
        'already declined, or below the thresholds. Filtered out: ' +
        `${rejected.listed} already listed, ${rejected.declined} declined, ` +
        `${rejected.lowStars} under ${MIN_STARS} stars, ${rejected.dormant} ` +
        `with no push in ${PUSHED_WITHIN_MONTHS} months, ${rejected.archived} ` +
        `archived, ${rejected.fork} forks.`
    );
    out.push('');
  } else if (candidates.length > 0) {
    out.push('## Filtered out');
    out.push('');
    out.push(
      `${rejected.listed} already listed, ${rejected.declined} previously ` +
        `declined, ${rejected.lowStars} under ${MIN_STARS} stars, ` +
        `${rejected.dormant} with no push in ${PUSHED_WITHIN_MONTHS} months, ` +
        `${rejected.archived} archived, ${rejected.fork} forks.` +
        (keptCount > candidates.length
          ? ` ${keptCount - candidates.length} more passed the filters but ` +
            `fell outside the top ${MAX_CANDIDATES}.`
          : '')
    );
    out.push('');
  }

  // Failed queries are listed as unchecked, never as "no results". The
  // overriding rule in this repository is that an API error must not be
  // rendered as a finding, and the inverse matters just as much: an error
  // must not be rendered as an all-clear either.
  if (unchecked.length > 0) {
    out.push('## Could not be searched');
    out.push('');
    out.push(
      'Rate limiting or a network failure, not evidence that these queries ' +
        'return nothing. Anything they would have found is missing from the ' +
        'report above.'
    );
    out.push('');
    for (const u of unchecked) {
      out.push(`- \`${u.query}\`: ${u.detail}`);
    }
    out.push('');
  }

  return { body: out.join('\n').trimEnd(), actionable: candidates.length };
}

// --- The live search --------------------------------------------------

function buildQuery(term, now = new Date()) {
  const since = monthsAgo(PUSHED_WITHIN_MONTHS, now).toISOString().slice(0, 10);
  return (
    `${term} stars:>=${MIN_STARS} pushed:>=${since} archived:false ` +
    'fork:false is:public'
  );
}

async function searchRepositories(term, now = new Date()) {
  const q = buildQuery(term, now);
  const url =
    `${API_ROOT}/search/repositories?q=${encodeURIComponent(q)}` +
    `&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}`;

  let response;
  try {
    response = await fetch(url, { headers: apiHeaders() });
  } catch (err) {
    return { query: term, status: 'error', detail: err.message };
  }

  // 401, 403, 422 and 429 mean unauthenticated, rate limited, or a malformed
  // query — never that the subject has no projects. Rendering any of them as
  // "no candidates found" would quietly turn an outage into an all-clear.
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    // Only 403 and 429 are read as a spent quota, and only then when the
    // header agrees. A 5xx can carry a stale x-ratelimit-remaining of 0, and
    // blaming the quota for an outage sends a maintainer to wait for a reset
    // that will not fix anything.
    const rateLimited =
      (response.status === 403 || response.status === 429) && remaining === '0';
    const detail =
      response.status === 401
        ? 'GitHub API rejected the credentials'
        : response.status === 422
          ? 'GitHub rejected the query as malformed'
          : rateLimited
            ? 'GitHub search rate limit exhausted'
            : `HTTP ${response.status} from the GitHub search API`;
    return { query: term, status: 'error', detail };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return { query: term, status: 'error', detail: `unreadable response: ${err.message}` };
  }

  return { query: term, status: 'ok', items: Array.isArray(data.items) ? data.items : [] };
}

async function searchAll(terms, now = new Date()) {
  const results = [];
  let next = 0;

  async function worker() {
    while (next < terms.length) {
      const index = next++;
      results[index] = await searchRepositories(terms[index], now);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, terms.length) }, worker)
  );

  return results;
}

// Ask about the quota before running any search. This matters more here than
// it does in check-staleness.js: the search API is metered separately from
// the core API and far more tightly — 30 requests per minute authenticated,
// 10 unauthenticated, against core's 5000 per hour. Without this, a run that
// starts with a spent search quota produces fifteen identical failures and a
// report claiming there is nothing to add, which is the worst possible
// outcome for a script whose whole job is noticing what is missing.
async function preflight(searches, now = new Date()) {
  let response;
  try {
    response = await fetch(`${API_ROOT}/rate_limit`, { headers: apiHeaders() });
  } catch (err) {
    return { ok: false, reason: `cannot reach the GitHub API: ${err.message}` };
  }

  if (response.status === 401) {
    return {
      ok: false,
      reason:
        'the GitHub API rejected the credentials. Set GITHUB_TOKEN to a ' +
        'token with public repository read access.',
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `the GitHub API returned HTTP ${response.status}.` };
  }

  const data = await response.json();
  const resources = data.resources || {};
  const search = resources.search;
  const core = resources.core;

  if (search && search.remaining < searches) {
    const resetAt = new Date(search.reset * 1000).toISOString();
    return {
      ok: false,
      reason:
        `only ${search.remaining} GitHub *search* requests remain and this ` +
        `run needs ${searches}. The search quota resets at ${resetAt}. ` +
        'Note this is a separate, much smaller budget than the core API ' +
        'quota the other checks use.',
    };
  }

  if (core && core.remaining < CORE_REQUESTS) {
    const resetAt = new Date(core.reset * 1000).toISOString();
    return {
      ok: false,
      reason:
        `only ${core.remaining} core API requests remain and filing the ` +
        `report needs ${CORE_REQUESTS}. The quota resets at ${resetAt}.`,
    };
  }

  return { ok: true };
}

// --- File the report as an issue --------------------------------------
// One issue, rewritten in place, exactly as check-staleness.js does. The
// marker and title are distinct from that script's so the two never fight
// over the same issue: entry health is about what is decaying, this is about
// what is missing, and they have different lifetimes.

const ISSUE_MARKER = '<!-- candidate-discovery-report -->';
const ISSUE_TITLE = 'Candidate entries for review';

async function findExistingIssue(owner, repo) {
  const response = await fetch(
    `${API_ROOT}/repos/${owner}/${repo}/issues?state=open&per_page=100`,
    { headers: apiHeaders() }
  );
  if (!response.ok) return null;

  const issues = await response.json();
  return (
    issues.find(
      (issue) => !issue.pull_request && (issue.body || '').includes(ISSUE_MARKER)
    ) || null
  );
}

async function reportIssue(body, actionable) {
  const slug = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    console.error('GITHUB_REPOSITORY is not set; cannot file an issue.');
    process.exitCode = 1;
    return;
  }
  if (!token()) {
    console.error('No GITHUB_TOKEN; cannot file an issue.');
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const fullBody = [
    ISSUE_MARKER,
    `_Last searched ${stamp}. This issue is rewritten in place by ` +
      '`scripts/find-candidates.js`; edits to the body will be overwritten. ' +
      'To reject a candidate permanently, add it to ' +
      '`scripts/declined-candidates.json`._',
    '',
    body,
  ].join('\n');

  const existing = await findExistingIssue(owner, repo);

  // Nothing to propose and no open report: stay quiet rather than opening an
  // issue that says there is nothing to add.
  if (!existing && actionable === 0) {
    console.log('No candidates and no open report issue; nothing filed.');
    return;
  }

  if (existing) {
    const response = await fetch(
      `${API_ROOT}/repos/${owner}/${repo}/issues/${existing.number}`,
      {
        method: 'PATCH',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: fullBody,
          // Close it once every candidate has been dealt with, so an open
          // report always means there is something waiting on a decision.
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
        ? `Closed issue #${existing.number}; nothing left to propose.`
        : `Updated issue #${existing.number} with ${actionable} candidate(s).`
    );
    return;
  }

  const response = await fetch(`${API_ROOT}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: ISSUE_TITLE, body: fullBody }),
  });
  if (!response.ok) {
    console.error(`Failed to create issue: ${response.status}`);
    process.exitCode = 1;
    return;
  }
  const created = await response.json();
  console.log(`Opened issue #${created.number} with ${actionable} candidate(s).`);
}

// --- Main -------------------------------------------------------------

async function main() {
  let declined;
  try {
    declined = readDeclined();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const list = readList(fs.readFileSync(README_PATH, 'utf8').split('\n'));
  if (list.urls.size === 0) {
    console.error('No entries found in README.md; refusing to propose anything.');
    process.exitCode = 1;
    return;
  }

  if (!token()) {
    console.error(
      'Warning: no GITHUB_TOKEN set. Unauthenticated GitHub *search* requests ' +
        `are limited to 10 per minute and this run needs ${SEARCH_TERMS.length}.`
    );
  }

  const ready = await preflight(SEARCH_TERMS.length);
  if (!ready.ok) {
    console.error(`Cannot run the search: ${ready.reason}`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const results = await searchAll(SEARCH_TERMS, now);
  const selection = selectCandidates(results, list, declined, now);
  const { body, actionable } = render(selection);

  console.log(body);

  if (process.argv.includes('--report-issue')) {
    console.log('');
    // If every query failed there is no information in this run at all.
    // Rewriting the report with an empty candidate list would close an issue
    // full of real candidates because the search API had a bad morning.
    if (selection.unchecked.length === selection.queriesRun) {
      console.error(
        'Every search query failed; leaving the existing report untouched ' +
          'rather than overwriting it with an empty one.'
      );
      process.exitCode = 1;
      return;
    }
    await reportIssue(body, actionable);
  }
}

// Exported for scripts/find-candidates.test.js. The live search cannot be
// exercised offline, so what is tested is everything that decides what a
// maintainer is shown: the diff against the list and the declined file, the
// thresholds, the cap, the drafted description, the computed position, and —
// most importantly — that a failed search degrades to "unchecked" rather than
// to an all-clear.
module.exports = {
  sortKey,
  normalizeUrl,
  readList,
  parseDeclined,
  readDeclined,
  proposeSection,
  placeInSection,
  draftDescription,
  markerHint,
  selectCandidates,
  buildQuery,
  searchRepositories,
  preflight,
  render,
  entryLine,
  reportIssue,
  SEARCH_TERMS,
  MIN_STARS,
  PUSHED_WITHIN_MONTHS,
  MAX_CANDIDATES,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
