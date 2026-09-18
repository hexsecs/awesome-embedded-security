#!/usr/bin/env node
// Tests for find-candidates.js, using node:test so nothing new is added to
// package.json. Run with `npm run test:candidates`.
//
// The live search cannot be exercised here, so what is tested is everything
// that decides what a maintainer is shown: the diff against the list and the
// declined file, the thresholds, the cap, the drafted description, the
// computed alphabetical position, and that a failed search degrades to
// "unchecked" rather than to an all-clear.
//
// The mistake this script must not make is the mirror of check-staleness's.
// There, a misread API error would send someone deleting a live entry. Here,
// a misread API error would render as "nothing to add" — a discovery pass
// that silently stops discovering is indistinguishable from a list with
// nothing missing, which is exactly the failure it exists to prevent.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
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
} = require('./find-candidates.js');

const NOW = new Date('2026-09-17T00:00:00Z');
const MONTH = 1000 * 60 * 60 * 24 * 30.44;
const recent = new Date(NOW.getTime() - 2 * MONTH).toISOString();
const dormant = new Date(
  NOW.getTime() - (PUSHED_WITHIN_MONTHS + 6) * MONTH
).toISOString();

// A synthetic GitHub search result item, shaped like the real API's.
function repo(overrides = {}) {
  return {
    full_name: 'acme/glitchkit',
    name: 'GlitchKit',
    html_url: 'https://github.com/acme/glitchkit',
    homepage: null,
    description: 'Toolkit for voltage glitching attacks against microcontrollers.',
    topics: ['fault-injection', 'glitching'],
    stargazers_count: 900,
    pushed_at: recent,
    archived: false,
    fork: false,
    license: { spdx_id: 'MIT' },
    ...overrides,
  };
}

function ok(query, items) {
  return { query, status: 'ok', items };
}

// A minimal README, laid out like the real one so the placement maths has
// real line numbers to work with.
const FAKE_README = [
  '# Awesome Embedded Security', // 1
  '', // 2
  '## Contents', // 3
  '', // 4
  '* [Software Tools](#software-tools)', // 5
  '', // 6
  '## Software Tools', // 7
  '', // 8
  '### Fault Injection', // 9
  '', // 10
  '* [ChipSHOUTER](https://github.com/newaetech/chipshouter) - EMFI platform.', // 11
  '* [Fault Tool](https://example.com/fault/) - Glitching harness.', // 12
  '* [Zapper](https://github.com/acme/zapper) - Laser fault rig.', // 13
  '', // 14
  '### Emulation Tools', // 15
  '', // 16
  '* [Qiling](https://github.com/qilingframework/qiling) - Emulation framework.', // 17
  '', // 18
  '### Wi-Fi Tools', // 19
  '', // 20
].join('\n');

const list = readList(FAKE_README.split('\n'));
const noDeclines = new Map();

// --- Normalization agrees with check-readme.js ------------------------

test('URL normalization collapses the differences the duplicate check ignores', () => {
  const canonical = normalizeUrl('https://github.com/acme/glitchkit');

  assert.strictEqual(normalizeUrl('https://github.com/acme/glitchkit/'), canonical);
  assert.strictEqual(normalizeUrl('https://www.github.com/acme/glitchkit'), canonical);
  assert.strictEqual(normalizeUrl('https://GitHub.com/acme/glitchkit//'), canonical);
});

test('sort keys drop leading punctuation only', () => {
  assert.strictEqual(sortKey('.NET decompiler'), 'net decompiler');
  assert.strictEqual(sortKey('EM-Fault-It-Yourself'), 'em-fault-it-yourself');
});

// --- Reading the list -------------------------------------------------

test('the Table of Contents is not mistaken for entries', () => {
  assert.ok(!list.urls.has('#software-tools'));
  assert.ok(!list.names.has(sortKey('Software Tools')));
});

test('sections carry their entries with real line numbers', () => {
  const section = list.sections.get('Fault Injection');
  assert.deepStrictEqual(
    section.entries.map((e) => [e.label, e.lineNo]),
    [
      ['ChipSHOUTER', 11],
      ['Fault Tool', 12],
      ['Zapper', 13],
    ]
  );
});

test('the real declined file parses and every entry carries a reason', () => {
  const declined = readDeclined();
  assert.ok(declined.size > 0, 'the file ships seeded');
  for (const reason of declined.values()) {
    assert.ok(reason.length > 0);
  }
});

test('a declined entry without a reason is refused rather than ignored', () => {
  assert.throws(
    () => parseDeclined('{"declined":[{"url":"https://example.com"}]}'),
    /reason/
  );
});

test('a malformed declined file is fatal, not silently empty', () => {
  assert.throws(() => parseDeclined('{not json'), /not valid JSON/);
  assert.throws(() => parseDeclined('{"nope":[]}'), /"declined" array/);
});

// --- Subtracting what is already known --------------------------------

test('a repository already listed by URL is excluded', () => {
  const results = [
    ok('topic:fault-injection', [
      repo({
        full_name: 'newaetech/chipshouter',
        name: 'ChipSHOUTER-Other',
        html_url: 'https://github.com/newaetech/chipshouter',
      }),
    ]),
  ];

  const selection = selectCandidates(results, list, noDeclines, NOW);
  assert.strictEqual(selection.candidates.length, 0);
  assert.strictEqual(selection.rejected.listed, 1);
});

// The whole point of borrowing normalizeUrl from check-readme.js: without
// it, a trailing slash or a www. turns a listed project into a phantom
// candidate, and the report starts proposing things the list already has.
test('a listed repository is still excluded when only the URL spelling differs', () => {
  for (const url of [
    'https://github.com/newaetech/chipshouter/',
    'https://www.github.com/newaetech/chipshouter',
  ]) {
    const selection = selectCandidates(
      [ok('q', [repo({ full_name: 'newaetech/chipshouter', name: 'Unseen', html_url: url })])],
      list,
      noDeclines,
      NOW
    );
    assert.strictEqual(
      selection.candidates.length,
      0,
      `${url} should have matched the listed entry`
    );
  }
});

test('a repository listed under its homepage rather than its repo is excluded', () => {
  const selection = selectCandidates(
    [
      ok('q', [
        repo({
          full_name: 'someone/fault-tool',
          name: 'Something Else',
          html_url: 'https://github.com/someone/fault-tool',
          homepage: 'https://example.com/fault',
        }),
      ]),
    ],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.candidates.length, 0);
  assert.strictEqual(selection.rejected.listed, 1);
});

test('a repository listed under a different URL but the same name is excluded', () => {
  const selection = selectCandidates(
    [ok('q', [repo({ full_name: 'fork/zapper', name: 'Zapper', html_url: 'https://github.com/fork/zapper' })])],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.candidates.length, 0);
  assert.strictEqual(selection.rejected.listed, 1);
});

test('a declined project never comes back', () => {
  const declined = new Map([
    [normalizeUrl('https://github.com/acme/glitchkit/'), 'Out of scope.'],
  ]);

  const selection = selectCandidates([ok('q', [repo()])], list, declined, NOW);

  assert.strictEqual(selection.candidates.length, 0);
  assert.strictEqual(selection.rejected.declined, 1);
});

test('the declined match survives a www. or trailing-slash difference', () => {
  const declined = new Map([
    [normalizeUrl('http://www.github.com/acme/glitchkit'), 'Out of scope.'],
  ]);

  const selection = selectCandidates([ok('q', [repo()])], list, declined, NOW);
  assert.strictEqual(selection.rejected.declined, 1);
});

// --- Thresholds -------------------------------------------------------

test('thresholds are enforced in the script, not only in the query', () => {
  const cases = [
    [{ full_name: 'a/a', name: 'A', html_url: 'https://github.com/a/a', stargazers_count: MIN_STARS - 1 }, 'lowStars'],
    [{ full_name: 'b/b', name: 'B', html_url: 'https://github.com/b/b', pushed_at: dormant }, 'dormant'],
    [{ full_name: 'c/c', name: 'C', html_url: 'https://github.com/c/c', archived: true }, 'archived'],
    [{ full_name: 'd/d', name: 'D', html_url: 'https://github.com/d/d', fork: true }, 'fork'],
  ];

  for (const [overrides, bucket] of cases) {
    const selection = selectCandidates(
      [ok('q', [repo(overrides)])],
      list,
      noDeclines,
      NOW
    );
    assert.strictEqual(selection.candidates.length, 0, `${bucket} should be filtered`);
    assert.strictEqual(selection.rejected[bucket], 1);
  }
});

test('a repository exactly on the star threshold is kept', () => {
  const selection = selectCandidates(
    [ok('q', [repo({ stargazers_count: MIN_STARS })])],
    list,
    noDeclines,
    NOW
  );
  assert.strictEqual(selection.candidates.length, 1);
});

test('an archived repository is never proposed as a new entry', () => {
  const selection = selectCandidates(
    [ok('q', [repo({ archived: true })])],
    list,
    noDeclines,
    NOW
  );

  const { body } = render(selection);
  assert.strictEqual(selection.candidates.length, 0);
  assert.ok(!body.includes('GlitchKit'), 'an archived project should not appear at all');
});

test('the same repository found by several queries is counted once', () => {
  const selection = selectCandidates(
    [ok('topic:fault-injection', [repo()]), ok('glitching', [repo()])],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.candidates.length, 1);
  assert.strictEqual(selection.candidates[0].queries.length, 2);
});

// --- Rank and cap -----------------------------------------------------

test('the report is capped at a reviewable number', () => {
  const many = Array.from({ length: MAX_CANDIDATES + 25 }, (_, i) =>
    repo({
      full_name: `acme/tool${i}`,
      name: `Tool${i}`,
      html_url: `https://github.com/acme/tool${i}`,
      stargazers_count: 200 + i,
    })
  );

  const selection = selectCandidates([ok('q', many)], list, noDeclines, NOW);

  assert.strictEqual(selection.candidates.length, MAX_CANDIDATES);
  assert.strictEqual(selection.keptCount, MAX_CANDIDATES + 25);
  assert.ok(render(selection).body.includes('fell outside the top'));
});

test('ranking prefers the project two queries found over the one with more stars', () => {
  const broad = repo({
    full_name: 'acme/popular',
    name: 'Popular',
    html_url: 'https://github.com/acme/popular',
    stargazers_count: 40000,
    topics: [],
  });
  const focused = repo({
    full_name: 'acme/focused',
    name: 'Focused',
    html_url: 'https://github.com/acme/focused',
    stargazers_count: 400,
  });

  const selection = selectCandidates(
    [ok('topic:fault-injection', [broad, focused]), ok('glitching', [focused])],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.candidates[0].name, 'Focused');
});

// --- Drafting the entry line ------------------------------------------

test('a description that opens with the project name is reworded', () => {
  const drafted = draftDescription('GlitchKit', {
    description: 'GlitchKit is a toolkit for voltage glitching attacks against MCUs.',
  });

  assert.ok(drafted.text, drafted.problem || '');
  assert.ok(
    !drafted.text.toLowerCase().startsWith('glitchkit'),
    'awesome-lint rejects a description starting with the entry name'
  );
  assert.match(drafted.text, /^[A-Z]/);
  assert.match(drafted.text, /\.$/);
});

test('the name is stripped however it is punctuated', () => {
  const drafted = draftDescription('OP-TEE', {
    description: 'OP TEE: open portable trusted execution environment for ARM TrustZone.',
  });

  assert.ok(drafted.text, drafted.problem || '');
  assert.match(drafted.text, /^Open portable trusted/);
});

test('a description that is only the project name gets no draft', () => {
  const drafted = draftDescription('GlitchKit', { description: 'GlitchKit' });

  assert.strictEqual(drafted.text, null);
  assert.match(drafted.problem, /project name/);
});

test('a missing description is reported, never invented', () => {
  const drafted = draftDescription('GlitchKit', { description: null });

  assert.strictEqual(drafted.text, null);
  assert.match(drafted.problem, /no description of its own/);
});

// Uppercasing "probe-rs" into "Probe-rs" would silently rename a project,
// and contributing.md is explicit that a misspelled name is the one thing no
// checker can catch because the URL still resolves.
test('a lowercase identifier is handed back rather than capitalized', () => {
  const drafted = draftDescription('Some Tool', {
    description: 'probe-rs backend that adds SWD tracing.',
  });

  assert.strictEqual(drafted.text, null);
  assert.match(drafted.problem, /case-sensitive identifier/);
});

test('a plain lowercase word is capitalized', () => {
  const drafted = draftDescription('Some Tool', {
    description: 'library for parsing UEFI capsule updates',
  });

  assert.strictEqual(drafted.text, 'Library for parsing UEFI capsule updates.');
});

test('emoji and markdown links are stripped out of the drafted description', () => {
  const drafted = draftDescription('Some Tool', {
    description: '🔥 Fuzzer for [MCU](https://example.com) firmware images.',
  });

  assert.strictEqual(drafted.text, 'Fuzzer for MCU firmware images.');
});

test('the drafted line matches the house format', () => {
  const selection = selectCandidates([ok('q', [repo()])], list, noDeclines, NOW);
  const line = entryLine(selection.candidates[0]);

  assert.match(line, /^\* \[[^\]]+\]\(https:\/\/[^)]+\) - [A-Z].*\.$/);
});

test('a missing license is surfaced as a 💰 question rather than an answer', () => {
  assert.strictEqual(markerHint({ license: { spdx_id: 'Apache-2.0' } }), null);
  assert.match(markerHint({ license: null }), /💰/);
  assert.match(markerHint({ license: { spdx_id: 'NOASSERTION' } }), /💰/);
});

// --- Section and alphabetical position --------------------------------

test('a section is proposed from the repository\'s own topics', () => {
  assert.strictEqual(proposeSection(repo()).name, 'Fault Injection');
  assert.strictEqual(
    proposeSection({ name: 'x', description: 'QEMU-based firmware rehosting.', topics: [] }).name,
    'Emulation Tools'
  );
});

test('keyword matching is whole-word, so short keywords do not match inside words', () => {
  const section = proposeSection({
    name: 'pipeline-helper',
    description: 'Continuous integration pipeline helper for makefiles.',
    topics: [],
  });
  assert.strictEqual(section.name, null);
});

test('an unrecognisable project gets no section rather than a wrong one', () => {
  const selection = selectCandidates(
    [
      ok('q', [
        repo({
          full_name: 'acme/mystery',
          name: 'Mystery',
          html_url: 'https://github.com/acme/mystery',
          description: 'Assorted utilities.',
          topics: [],
        }),
      ]),
    ],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.candidates[0].section, null);
  assert.ok(render(selection).body.includes('no suggestion'));
});

test('the alphabetical position lands between the right two entries', () => {
  const section = list.sections.get('Fault Injection');

  // ChipSHOUTER(11) < Fault Tool(12) < GlitchKit < Zapper(13)
  const middle = placeInSection(section, 'GlitchKit');
  assert.strictEqual(middle.lineNo, 13);
  assert.strictEqual(middle.after.label, 'Fault Tool');
  assert.strictEqual(middle.before.label, 'Zapper');
});

test('a first and a last entry are placed at the ends of the section', () => {
  const section = list.sections.get('Fault Injection');

  const first = placeInSection(section, 'Anvil');
  assert.strictEqual(first.lineNo, 11);
  assert.strictEqual(first.after, null);
  assert.strictEqual(first.before.label, 'ChipSHOUTER');

  const last = placeInSection(section, 'Zeta');
  assert.strictEqual(last.lineNo, 14);
  assert.strictEqual(last.after.label, 'Zapper');
  assert.strictEqual(last.before, null);
});

test('placement ignores leading punctuation, as the order check does', () => {
  const section = list.sections.get('Fault Injection');
  const placed = placeInSection(section, '.glitch');

  assert.strictEqual(
    placed.after.label,
    'Fault Tool',
    '".glitch" must file under G, not ahead of everything'
  );
});

test('an empty section places the first entry under its heading', () => {
  const section = list.sections.get('Wi-Fi Tools');
  const placed = placeInSection(section, 'Anything');

  assert.strictEqual(placed.lineNo, section.headingLine + 2);
  assert.strictEqual(placed.after, null);
  assert.strictEqual(placed.before, null);
});

// --- The routing corpus -----------------------------------------------
// Every ROUTING_CORPUS entry marked `live: true` is a real repository, with
// the name, description and topics GitHub returned for it on 2026-09-17 —
// these are the twelve candidates the first live discovery run produced, and
// proposeSection sees exactly these three fields and nothing else. They are
// reproduced verbatim rather than paraphrased, because the bug this corpus
// exists to pin was invisible in paraphrase: four of the twelve landed in
// `Bluetooth and BLE Security` on the strength of one incidental word.
//
// The synthetic entries alongside them pin what must not regress while that
// is fixed. Loosening the BLE section until a bus tool stops landing there is
// easy and wrong; the corpus holds a genuinely Bluetooth-only tool, genuinely
// secure-boot tools, and an entry whose whole case is a single precise
// keyword, so a fix that routes by breaking those fails here.
//
// `expect: null` means no suggestion, which is a result, not a gap.
const ROUTING_CORPUS = [
  {
    live: true,
    why: 'An awesome list. Its topics describe its contents, not its subject.',
    expect: 'Other Awesome Lists',
    placeable: false,
    repo: {
      name: 'awesome-connected-things-sec',
      description: 'A Curated list of Security Resources for all connected things',
      topics: [
        'automotive-security', 'awesome', 'awesome-list', 'ble-security',
        'bluetooth-security', 'embedded-security', 'firmware-analysis',
        'firmware-security', 'hardware-hacking', 'ics-security',
        'iot-pentesting', 'iot-security', 'reverse-engineering', 'rf-security',
        'wireless-security',
      ],
    },
  },
  {
    live: true,
    why: 'Routed correctly before this change and must still route there.',
    expect: 'Security Auditing Frameworks',
    repo: {
      name: 'AutoProber',
      description:
        'Hardware hacker’s flying probe automation stack for agent-driven   ' +
        'target discovery, microscope mapping, safety-monitored CNC motion, ' +
        'probe review, and   controlled pin probing.',
      topics: [
        'ai-agents', 'autromation', 'embedded-security', 'flying-probe',
        'gainsec', 'hardware-hacking', 'hardware-security', 'iot-security',
        'offensive-security', 'pcb', 'pcb-probing', 'penetration-testing',
        'reverse-engineering', 'robotics', 'security-research',
      ],
    },
  },
  {
    live: true,
    why:
      'A multi-protocol bus tool. One incidental `bluetooth` topic sent it to ' +
      'the BLE section; a maintainer put it next to Bus Pirate.',
    expect: 'Hardware Reverse Engineering Multitools',
    repo: {
      name: 'ESP32-Bit-Pirate',
      description: 'A Hardware Hacking Tool with Web-Based CLI That Speaks Every Protocol ',
      topics: [
        'arduino', 'bluetooth', 'can-bus', 'debugging', 'eeprom', 'esp32',
        'flipperzero', 'gpio', 'hardware-hacking', 'i2c', 'jtag', 'openocd',
        'protocols', 'pwm', 'radio', 'rfid', 'spi', 'subghz', 'uart', 'wifi',
      ],
    },
  },
  {
    live: true,
    why:
      'The regression guard that matters most: BLE is its actual subject, so ' +
      'a fix that stops bus tools landing in BLE must not stop this one.',
    expect: 'Bluetooth and BLE Security',
    repo: {
      name: 'GhostESP',
      description: 'The open-source wireless research platform for ESP32.',
      topics: [
        'ble', 'bluetooth-low-energy', 'cardputer', 'embedded', 'esp-idf',
        'esp32', 'flipperzero', 'hardware-hacking', 'iot-security', 'nfc',
        'pentesting', 'red-team', 'rfid', 'security-research', 'subghz',
        'wardriving', 'wifi-hacking', 'wifi-security',
      ],
    },
  },
  {
    live: true,
    why: 'Routed correctly before this change and must still route there.',
    expect: 'Security Auditing Frameworks',
    repo: {
      name: 'Dark-Moon',
      description:
        'Autonomous AI pentesting engine across web, cloud, identity, CI/CD, ' +
        'IaC, databases, Active Directory, Kubernetes, IoT firmware and AI/LLM ' +
        'endpoints (OWASP LLM Top 10). Real exploits with proof for every ' +
        'finding. Privacy gateway: the LLM never sees your real IPs, hosts or ' +
        'creds; nothing leaves your perimeter.',
      topics: [
        'active-directory', 'ai-agents', 'ai-red-team', 'ai-security-tool',
        'autonomous-agents', 'cloud-security', 'firmware-security',
        'iot-security', 'kubernetes', 'llm', 'local-llm', 'mcp',
        'multi-agent-systems', 'offensive-security', 'penetration-testing',
        'pentesting', 'red-team', 'security-automation', 'security-tools',
        'self-hosted',
      ],
    },
  },
  {
    live: true,
    why:
      'Nothing in the table covers PKI for constrained devices, and inventing ' +
      'a section for it is not this script’s job.',
    expect: null,
    repo: {
      name: 'TinyPKI',
      description:
        'TinyPKI is a lightweight C11/OpenSSL PKI core for constrained IoT and ' +
        'edge networks, combining ECQV implicit certificates, sparse Merkle ' +
        'revocation proofs, MMR issuance transparency, CA-signed checkpoints, ' +
        't-of-n edge witnesses, and SM2/SM3/SM4 sessions.',
      topics: [
        'c11', 'certificate-revocation', 'certificate-transparency',
        'cryptography', 'ecqv', 'edge-computing', 'embedded-security',
        'iot-security', 'lightweight-pki', 'merkle-mountain-range',
        'merkle-tree', 'offline-verification', 'openssl', 'pki',
        'secure-session', 'sm2', 'sm3', 'sm4', 'sparse-merkle-tree',
        'threshold-policy',
      ],
    },
  },
  {
    live: true,
    why:
      'Declined as off-topic, but the routing was right: it really does carry ' +
      'secure-boot. Relevance is a separate question from placement.',
    expect: 'Secure Boot and Firmware Trust',
    repo: {
      name: 'Ventoy',
      description: 'A new bootable USB solution.',
      topics: [
        'arm64', 'auto-install', 'bootable-usb', 'bsd', 'chromeos', 'iso-files',
        'legacy', 'linux', 'multiboot', 'persistence', 'secure-boot', 'uefi',
        'unattended', 'unix', 'usb', 'windows', 'x86', 'x86-64',
      ],
    },
  },
  {
    live: true,
    why: 'As Ventoy: declined on relevance, routed correctly.',
    expect: 'Secure Boot and Firmware Trust',
    repo: {
      name: 'rufus',
      description: 'The Reliable USB Formatting Utility',
      topics: [
        'bios', 'boot', 'bootable-drives', 'freedos', 'gpt', 'grub', 'grub4dos',
        'iso', 'mbr', 'md5', 'persistence', 'rufus', 'secure-boot', 'sha1',
        'sha256', 'syslinux', 'uefi', 'usb', 'windows', 'windows-to-go',
      ],
    },
  },
  {
    live: true,
    why: 'A genuine secure-boot tool. Routing must survive.',
    expect: 'Secure Boot and Firmware Trust',
    repo: {
      name: 'sbctl',
      description: ':computer: :lock: :key: Secure Boot key manager',
      topics: [
        'efi', 'efi-stub', 'go', 'golang', 'linux', 'secure-boot', 'secureboot',
        'signatures', 'uefi', 'uefi-secureboot',
      ],
    },
  },
  {
    live: true,
    why: 'A genuine secure-boot tool. Routing must survive.',
    expect: 'Secure Boot and Firmware Trust',
    repo: {
      name: 'lanzaboote',
      description:
        'Secure Boot & Measured Boot for NixOS [maintainers=@blitz ' +
        '@raitobezarius @nikstur]',
      topics: [
        'efi', 'measured-boot', 'nix', 'nixos', 'nixpkgs', 'rust', 'secure-boot',
        'security', 'tpm2', 'uefi',
      ],
    },
  },
  {
    live: true,
    why:
      'Netlist reverse engineering, hand-placed beside Ghidra and IDA. No ' +
      'keyword in the table covered netlists, so it got nothing.',
    expect: 'Disassemblers/Decompilers',
    repo: {
      name: 'hal',
      description: 'HAL – The Hardware Analyzer',
      topics: [
        'embedded-security', 'fpga', 'hal', 'hardware', 'integrated-circuits',
        'netlist', 'reverse-engineering', 'security',
      ],
    },
  },
  {
    live: true,
    why: 'As Ventoy: declined on relevance, routed correctly.',
    expect: 'Bluetooth and BLE Security',
    repo: {
      name: 'OpenTagViewer',
      description: 'Track your AirTags, iDevices and other FindMy devices on Android',
      topics: [
        'airtag', 'android', 'bluetooth', 'bluetooth-le', 'bluetooth-low-energy',
        'chaquopy', 'findmy', 'hardware-hacking', 'icloud', 'icloud-sync',
        'looking-for-contributors', 'openhaystack', 'packet-analysis',
        'reverse-engineering', 'wiki',
      ],
    },
  },

  // --- Synthetic cases, pinning the edges the live twelve do not reach ---
  {
    why: 'One strong, specific keyword and nothing else still has to route.',
    expect: 'Side-Channel Analysis',
    repo: {
      name: 'tracehunter',
      description: 'Correlation power analysis over captured traces.',
      topics: [],
    },
  },
  {
    why:
      'An awesome list that never says "awesome": the description alone is ' +
      'enough, because contents-based routing is wrong for all of them.',
    expect: 'Other Awesome Lists',
    placeable: false,
    repo: {
      name: 'iot-security-resources',
      description: 'A curated list of Zigbee, Z-Wave and LoRaWAN security research.',
      topics: ['zigbee', 'z-wave'],
    },
  },
  {
    why: 'A list whose only declaration is the topic its maintainers applied.',
    expect: 'Other Awesome Lists',
    placeable: false,
    repo: {
      name: 'firmware-index',
      description: 'Everything worth reading about firmware fuzzing and emulation.',
      topics: ['awesome-list', 'firmware-security'],
    },
  },
  {
    why:
      'Breadth across many sections with no multitool self-description: the ' +
      'honest answer is the contenders, not a pick among them.',
    expect: null,
    repo: {
      name: 'protocolzoo',
      description:
        'Research harness covering MQTT brokers, Zigbee coordinators, ' +
        'LoRaWAN gateways, GATT servers and Modbus PLCs.',
      topics: ['mifare', 'sigrok', 'chipwhisperer'],
    },
  },
  {
    why:
      'Breadth of generic vocabulary must not beat one precise hit: two soft ' +
      'words for one section against `chipwhisperer` for another. Counting ' +
      'matches, BLE won this 2-1.',
    expect: 'Side-Channel Analysis',
    repo: {
      name: 'sca-rig',
      description: 'ChipWhisperer capture rig.',
      topics: ['bluetooth', 'ble'],
    },
  },
  {
    why: 'Nothing matches at all, which stays a non-answer rather than a guess.',
    expect: null,
    repo: { name: 'Mystery', description: 'Assorted utilities.', topics: [] },
  },
];

for (const entry of ROUTING_CORPUS) {
  const label = entry.live ? `${entry.repo.name} (live)` : entry.repo.name;
  test(`routing: ${label} -> ${entry.expect || 'no suggestion'}`, () => {
    const proposal = proposeSection(entry.repo);
    assert.strictEqual(proposal.name, entry.expect, entry.why);
  });
}

test('an awesome list is routed by what it is, never by what it contains', () => {
  const proposal = proposeSection(
    ROUTING_CORPUS.find((e) => e.repo.name === 'awesome-connected-things-sec').repo
  );

  // Its topics include ble-security and bluetooth-security. Those describe the
  // resources it indexes, and routing on them is the bug.
  assert.strictEqual(proposal.name, 'Other Awesome Lists');
  assert.ok(
    proposal.matched.some((m) => /awesome/.test(m.keyword)),
    'the report has to show which signal said "this is a list"'
  );
});

test('an awesome list reports the section it cannot compute a position in', () => {
  const entry = ROUTING_CORPUS.find((e) => e.placeable === false);
  const proposal = proposeSection(entry.repo);

  assert.strictEqual(proposal.placeable, false);
  assert.match(proposal.heading, /^## Other Awesome Lists$/);
  assert.match(proposal.note, /nested/i, 'it must say why there is no line number');
});

test('a multi-protocol tool is not filed under the first protocol it matched', () => {
  const proposal = proposeSection(
    ROUTING_CORPUS.find((e) => e.repo.name === 'ESP32-Bit-Pirate').repo
  );

  assert.strictEqual(proposal.name, 'Hardware Reverse Engineering Multitools');
  assert.ok(
    proposal.contenders.length > 1,
    'a reviewer checking this needs to see what else it looked like'
  );
  assert.ok(
    proposal.contenders.some((c) => c.name === 'Bluetooth and BLE Security'),
    'BLE was the old answer, so it has to appear as a contender'
  );
});

test('breadth with no multitool claim is reported as breadth, not as a pick', () => {
  const proposal = proposeSection(
    ROUTING_CORPUS.find((e) => e.repo.name === 'protocolzoo').repo
  );

  assert.strictEqual(proposal.name, null);
  assert.match(proposal.note, /different sections/);
  assert.ok(proposal.contenders.length >= 4);
});

test('a lone generic keyword is not enough to name a section', () => {
  const proposal = proposeSection({
    name: 'tagtool',
    description: 'Companion app that talks to trackers over Bluetooth.',
    topics: [],
  });

  assert.strictEqual(proposal.name, null);
  assert.deepStrictEqual(
    proposal.contenders.map((c) => c.name),
    ['Bluetooth and BLE Security'],
    'the near miss is still worth showing'
  );
});

test('a near-tie is reported as a near-tie rather than resolved by table order', () => {
  // `netlist` for one section, `sigrok` for another: one precise keyword each.
  const proposal = proposeSection({
    name: 'twoways',
    description: 'Netlist viewer with a sigrok capture backend.',
    topics: [],
  });

  assert.strictEqual(proposal.name, null);
  assert.match(proposal.note, /not clearly ahead/);
});

test('the report names the contenders when it declines to choose', () => {
  const selection = selectCandidates(
    [
      ok('q', [
        repo({
          full_name: 'acme/protocolzoo',
          name: 'protocolzoo',
          html_url: 'https://github.com/acme/protocolzoo',
          ...ROUTING_CORPUS.find((e) => e.repo.name === 'protocolzoo').repo,
        }),
      ]),
    ],
    list,
    noDeclines,
    NOW
  );
  const { body } = render(selection);

  assert.ok(body.includes('no suggestion'));
  assert.ok(body.includes('IoT Protocol Security'), 'the contenders have to be shown');
});

test('the report says an awesome list has a section but no computable line', () => {
  const selection = selectCandidates(
    [
      ok('q', [
        repo({
          full_name: 'v33ru/awesome-connected-things-sec',
          html_url: 'https://github.com/V33RU/awesome-connected-things-sec',
          ...ROUTING_CORPUS.find((e) => e.repo.name === 'awesome-connected-things-sec')
            .repo,
        }),
      ]),
    ],
    list,
    noDeclines,
    NOW
  );
  const { body } = render(selection);

  assert.ok(body.includes('## Other Awesome Lists'));
  assert.ok(
    !body.includes('heading not found'),
    'the heading is in README.md; saying otherwise is a different, false claim'
  );
  assert.ok(!/README\.md:\d+/.test(body), 'it must not invent a line number');
});

test('the rendered report names the section and the exact line', () => {
  const selection = selectCandidates([ok('q', [repo()])], list, noDeclines, NOW);
  const { body, actionable } = render(selection);

  assert.strictEqual(actionable, 1);
  assert.ok(body.includes('### Fault Injection'));
  assert.ok(body.includes('README.md:13'));
  assert.ok(body.includes('between **Fault Tool** and **Zapper**'));
});

// --- The failure that matters ----------------------------------------
// A search that failed is not evidence that nothing exists. If a run
// rendered a rate-limited search as "nothing to propose", the discovery loop
// would quietly stop discovering and look exactly like success.

test('a failed search is unchecked, never an all-clear', () => {
  const selection = selectCandidates(
    [{ query: 'topic:fault-injection', status: 'error', detail: 'GitHub search rate limit exhausted' }],
    list,
    noDeclines,
    NOW
  );
  const { body, actionable } = render(selection);

  assert.strictEqual(actionable, 0);
  assert.strictEqual(selection.unchecked.length, 1);
  assert.ok(body.includes('Not fully searched'));
  assert.ok(body.includes('rate limit exhausted'));
  assert.ok(
    !body.includes('Nothing to propose'),
    'a failed search must not read as a clean sweep'
  );
});

test('a total search failure produces a short report, not a wall of noise', () => {
  const selection = selectCandidates(
    SEARCH_TERMS.map((query) => ({ query, status: 'error', detail: 'HTTP 503' })),
    list,
    noDeclines,
    NOW
  );
  const { body, actionable } = render(selection);

  assert.strictEqual(actionable, 0);
  assert.strictEqual(selection.candidates.length, 0);
  assert.ok(!body.includes('## Candidates'));
  assert.ok(!body.includes('Nothing to propose'));
  assert.ok(body.includes(`Fully searched 0 of ${SEARCH_TERMS.length} queries`));
});

test('one query failing does not discard the others', () => {
  const selection = selectCandidates(
    [
      { query: 'topic:jtag', status: 'error', detail: 'HTTP 502' },
      ok('topic:fault-injection', [repo()]),
    ],
    list,
    noDeclines,
    NOW
  );
  const { body } = render(selection);

  assert.strictEqual(selection.candidates.length, 1);
  assert.ok(body.includes('## Candidates'));
  assert.ok(body.includes('Not fully searched'));
});

test('HTTP failures from the search API become errors, not empty results', async (t) => {
  const cases = [
    { status: 401, expect: /credentials/ },
    { status: 403, expect: /rate limit|HTTP 403/ },
    { status: 422, expect: /malformed/ },
    { status: 429, expect: /rate limit|HTTP 429/ },
    { status: 503, expect: /HTTP 503/ },
  ];

  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  for (const { status, expect } of cases) {
    global.fetch = async () => ({ status, ok: false, headers: { get: () => '0' } });

    const result = await searchRepositories('topic:jtag');
    assert.strictEqual(result.status, 'error', `HTTP ${status} must be an error`);
    assert.match(result.detail, expect);
  }
});

test('a network exception is an error, not an empty result set', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => {
    throw new Error('ECONNRESET');
  };

  const result = await searchRepositories('topic:jtag');
  assert.strictEqual(result.status, 'error');
  assert.match(result.detail, /ECONNRESET/);
});

test('an empty but successful search is an all-clear, not an error', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => '29' },
    json: async () => ({ items: [] }),
  });

  const result = await searchRepositories('topic:jtag');
  assert.strictEqual(result.status, 'ok');
  assert.deepStrictEqual(result.items, []);
});

// --- Query construction and preflight ---------------------------------

test('the thresholds are pushed into the query so GitHub does the filtering', () => {
  const q = buildQuery('topic:jtag', NOW);

  assert.ok(q.startsWith('topic:jtag '));
  assert.ok(q.includes(`stars:>=${MIN_STARS}`));
  assert.ok(q.includes('archived:false'));
  assert.ok(q.includes('fork:false'));
  assert.match(q, /pushed:>=\d{4}-\d{2}-\d{2}/);
});

test('preflight refuses when the search quota is short, and says which quota', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      resources: {
        core: { remaining: 5000, reset: 0 },
        search: { remaining: 2, reset: Math.floor(Date.now() / 1000) + 60 },
      },
    }),
  });

  const result = await preflight(15);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /only 2 GitHub \*search\* requests remain/);
});

test('preflight refuses a rejected token before any search runs', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({ status: 401, ok: false });

  const result = await preflight(15);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /credentials/);
});

test('preflight refuses when core has no room left to file the report', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      resources: {
        core: { remaining: 0, reset: Math.floor(Date.now() / 1000) + 60 },
        search: { remaining: 30, reset: 0 },
      },
    }),
  });

  assert.strictEqual((await preflight(15)).ok, false);
});

test('preflight passes when both quotas cover the run', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      resources: { core: { remaining: 5000, reset: 0 }, search: { remaining: 30, reset: 0 } },
    }),
  });

  assert.strictEqual((await preflight(15)).ok, true);
});

// --- Filing the issue -------------------------------------------------
// The only part that writes to the repository, and it must never write to
// README.md. Each branch is pinned: an empty run must not open an issue, a
// monthly run must not pile one up beside the report already open, and the
// marker must differ from check-staleness.js's so the two never fight over
// the same issue.

// `lookupStatus` fails the GET that looks for an already-open report, so the
// tests can tell "there is no open report" apart from "I could not find out".
function issueHarness(t, { existingIssue, lookupStatus = 200, lookupThrows = false }) {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const calls = [];

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });

    if (method === 'GET') {
      if (lookupThrows) throw new Error('ECONNRESET');
      if (lookupStatus !== 200) {
        return {
          status: lookupStatus,
          ok: false,
          headers: { get: () => '0' },
          json: async () => ({ message: 'nope' }),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => '4999' },
        json: async () =>
          existingIssue
            ? [{ number: 77, body: '<!-- candidate-discovery-report -->\nprevious' }]
            : [],
      };
    }
    return { status: method === 'POST' ? 201 : 200, ok: true, json: async () => ({ number: 456 }) };
  };

  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';

  // reportIssue signals a refusal to post by setting process.exitCode, which
  // would otherwise leak out and fail the whole test run.
  const realExitCode = process.exitCode;
  t.after(() => {
    global.fetch = realFetch;
    process.env = realEnv;
    process.exitCode = realExitCode;
  });

  return calls;
}

test('nothing to propose and no open report files nothing at all', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Nothing to propose', 0);

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'an empty run must not open an issue'
  );
});

test('nothing to propose closes the report that was already open', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Nothing to propose', 0);

  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write);
  assert.strictEqual(write.body.state, 'closed');
  assert.ok(write.url.endsWith('/issues/77'));
});

test('candidates with no open report open one under its own title', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Candidates', 3);

  const write = calls.find((c) => c.method === 'POST');
  assert.ok(write);
  assert.strictEqual(write.body.title, 'Candidate entries for review');
  assert.ok(write.body.body.startsWith('<!-- candidate-discovery-report -->'));
  assert.ok(
    !write.body.body.includes('<!-- entry-health-report -->'),
    'the two reports must never claim the same issue'
  );
});

test('candidates rewrite the open report rather than opening a second', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Candidates', 2);

  assert.strictEqual(calls.filter((c) => c.method === 'POST').length, 0);
  const write = calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(write.body.state, 'open');
});

test('no request this script makes ever writes to a file in the repository', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Candidates', 1);

  for (const call of calls) {
    assert.ok(
      !/\/contents\/|\/git\/|\/pulls/.test(call.url),
      `${call.url} would edit the repository; this script only files issues`
    );
  }
});

test('the report tells a reviewer how to decline a candidate', () => {
  const selection = selectCandidates([ok('q', [repo()])], list, noDeclines, NOW);
  const { body } = render(selection);

  assert.ok(body.includes('scripts/declined-candidates.json'));
  assert.ok(body.includes('Nothing here has been added to the list.'));
});

// --- Incomplete results must not destroy pending review work ----------
// The candidate list from a run where a query failed is a floor, not a set.
// Overwriting an open report with one drops candidates that only the failed
// query would have surfaced, and a maintainer may be part way through
// reviewing them; closing one because the partial list came back empty
// discards the whole queue on the strength of a search that never ran. One
// query out of fifteen timing out is the common case, not the exotic one.

test('a partial search failure leaves an open report untouched', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Candidates', 3, { complete: false });

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'an incomplete run must not rewrite a report it cannot reproduce'
  );
  assert.strictEqual(process.exitCode, 1, 'and the run should flag itself');
});

test('a partial search failure does not close an open report', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  // The dangerous shape: one query fails, the rest legitimately find
  // nothing, and `actionable` is 0 for a reason that is not true.
  await reportIssue('## Could not be searched', 0, { complete: false });

  const write = calls.find((c) => c.method === 'PATCH');
  assert.strictEqual(
    write,
    undefined,
    'closing on an incomplete search discards the review queue'
  );
});

test('an incomplete run may still open a report where none exists', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Candidates', 12, { complete: false });

  const write = calls.find((c) => c.method === 'POST');
  assert.ok(
    write,
    'there is no pending work to lose, and 12 candidates should not be ' +
      'thrown away because a 13th query timed out'
  );
});

test('an incomplete run with nothing found and no open report stays quiet', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Could not be searched', 0, { complete: false });

  assert.strictEqual(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('a complete run still rewrites and closes as before', async (t) => {
  const calls = issueHarness(t, { existingIssue: true });

  await reportIssue('## Nothing to propose', 0, { complete: true });

  const write = calls.find((c) => c.method === 'PATCH');
  assert.ok(write, 'completeness is the only thing that gates this');
  assert.strictEqual(write.body.state, 'closed');
});

// --- A failed lookup is not proof that no report exists ---------------
// Treating a 5xx, a permission error or a rate-limited response as "no issue
// found" sends reportIssue down the creation path and opens a second report
// beside the one already open. From then on the single-issue design is
// broken and the two reports diverge silently.

test('a failed existing-issue lookup never creates a second report', async (t) => {
  for (const status of [403, 429, 500, 502, 503]) {
    const calls = issueHarness(t, { existingIssue: true, lookupStatus: status });

    await reportIssue('## Candidates', 5);

    assert.strictEqual(
      calls.filter((c) => c.method === 'POST').length,
      0,
      `HTTP ${status} on the lookup must not be read as "no issue exists"`
    );
    assert.strictEqual(calls.filter((c) => c.method === 'PATCH').length, 0);
    assert.strictEqual(process.exitCode, 1, `HTTP ${status} should flag the run`);
    process.exitCode = 0;
  }
});

test('a network exception during the lookup does not create a report', async (t) => {
  const calls = issueHarness(t, { existingIssue: true, lookupThrows: true });

  await reportIssue('## Candidates', 5);

  assert.strictEqual(calls.filter((c) => c.method !== 'GET').length, 0);
  assert.strictEqual(process.exitCode, 1);
});

test('a 200 with no matching issue really does mean no report is open', async (t) => {
  const calls = issueHarness(t, { existingIssue: false });

  await reportIssue('## Candidates', 5);

  assert.ok(
    calls.find((c) => c.method === 'POST'),
    'the only response that authorises creating a report is a successful ' +
      'listing that contains none'
  );
});

test('an issues listing that is not an array is a failure, not an empty list', async (t) => {
  const realFetch = global.fetch;
  const realEnv = { ...process.env };
  const realExitCode = process.exitCode;
  const calls = [];

  global.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method });
    if (method === 'GET') {
      return {
        status: 200,
        ok: true,
        headers: { get: () => '4999' },
        // What the API returns when it declines with a 200, e.g. an
        // abuse-detection body. `.find` would throw; `[]` would be a lie.
        json: async () => ({ message: 'You have exceeded a secondary rate limit' }),
      };
    }
    return { status: 201, ok: true, json: async () => ({ number: 1 }) };
  };
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  t.after(() => {
    global.fetch = realFetch;
    process.env = realEnv;
    process.exitCode = realExitCode;
  });

  await reportIssue('## Candidates', 2);

  assert.strictEqual(calls.filter((c) => c.method !== 'GET').length, 0);
});

// --- The description corpus -------------------------------------------
// draftDescription's leading-name stripper is the one piece of this script
// that rewrites text a human will paste into the list verbatim, so it gets a
// table rather than a handful of examples. Every earlier bug here shared a
// shape: the stripper matched something that was not actually the leading
// name — an article's letter at the head of the *next* word, or the name as a
// prefix of a longer word — and the corrupted remainder was then capitalized,
// given a full stop, and emitted inside a ```md fence as paste-ready.
//
// That is worse than the blank this function is supposed to fall back to,
// because it is confident. The fixtures below are chosen to pin the
// boundaries specifically: a- and an-initial following words, a name that is
// a strict prefix of the next word, a name repeated later in the sentence, a
// name containing punctuation, and articles that are genuinely articles.
//
// Verified against awesome-lint: a strict-prefix name left unstripped
// ("Flash" / "Flashing utility…") does NOT trip no-repeat-item-in-description,
// so passing those through untouched is correct rather than merely safe.
const DESCRIPTION_CORPUS = [
  // --- the alternation must not eat the next word's first letter ---
  ['GlitchKit', 'GlitchKit — Automated glitching framework for embedded targets',
    'Automated glitching framework for embedded targets.'],
  ['emba', 'emba - Analyzer for Linux-based firmware of embedded devices',
    'Analyzer for Linux-based firmware of embedded devices.'],
  ['Zap', 'Zap - Anvil-based test harness for secure boot verification',
    'Anvil-based test harness for secure boot verification.'],
  ['Zap', 'Zap: Applied power analysis toolkit for smartcard research',
    'Applied power analysis toolkit for smartcard research.'],
  ['Zap', 'Zap — Theoretical fault model explorer for secure elements',
    'Theoretical fault model explorer for secure elements.'],

  // --- but genuine copulas and articles must still go ---
  ['Faultier', 'Faultier is an affordable fault injection tool for hardware hacking',
    'Affordable fault injection tool for hardware hacking.'],
  ['Faultier', 'Faultier is a portable voltage glitching platform for MCU research',
    'Portable voltage glitching platform for MCU research.'],
  ['Zap', 'Zap, the definitive JTAG scanner for embedded targets everywhere',
    'Definitive JTAG scanner for embedded targets everywhere.'],

  // --- a name that is a strict prefix of the next word is not the name ---
  ['Flash', 'Flashing utility for embedded devices over SWD and JTAG',
    'Flashing utility for embedded devices over SWD and JTAG.'],
  ['Radio', 'Radioactive signal analysis toolkit for software defined radio',
    'Radioactive signal analysis toolkit for software defined radio.'],

  // --- names carrying punctuation ---
  ['OP-TEE', 'OP TEE: open portable trusted execution environment for ARM TrustZone.',
    'Open portable trusted execution environment for ARM TrustZone.'],
  ['OP-TEE', 'OP-TEE — An open portable TEE implementation for ARM TrustZone',
    'Open portable TEE implementation for ARM TrustZone.'],

  // --- only the leading occurrence is stripped ---
  ['GlitchKit', 'GlitchKit — Automated framework; GlitchKit targets STM32 and nRF parts',
    'Automated framework; GlitchKit targets STM32 and nRF parts.'],

  // --- matching the leading name is case-insensitive ---
  ['GlitchKit', 'GLITCHKIT - Automated glitching framework for embedded targets',
    'Automated glitching framework for embedded targets.'],

  // --- no leading name: capital and full stop only ---
  ['Some Tool', 'A library for parsing UEFI capsule updates and signatures',
    'A library for parsing UEFI capsule updates and signatures.'],
  ['Some Tool', 'An open source toolkit for analysing secure boot chains',
    'An open source toolkit for analysing secure boot chains.'],
];

test('the description corpus drafts every fixture correctly', () => {
  const wrong = [];

  for (const [name, input, expected] of DESCRIPTION_CORPUS) {
    const got = draftDescription(name, { description: input });
    if (got.text !== expected) {
      wrong.push(
        `  [${name}] ${JSON.stringify(input)}\n` +
          `     expected ${JSON.stringify(expected)}\n` +
          `     got      ${JSON.stringify(got.text)}${got.text === null ? ' (' + got.problem + ')' : ''}`
      );
    }
  }

  assert.strictEqual(
    wrong.length,
    0,
    `${wrong.length} of ${DESCRIPTION_CORPUS.length} fixtures drafted wrongly:\n${wrong.join('\n')}`
  );
});

// The property that every fixture above is really pinning: the stripper may
// only remove whole words. If the drafted text is a suffix of the input, the
// character before the cut must be a boundary — never mid-word.
test('stripping never cuts into the middle of a word', () => {
  for (const [name, input] of DESCRIPTION_CORPUS) {
    const got = draftDescription(name, { description: input });
    if (!got.text) continue;

    const tail = got.text.replace(/\.$/, '');
    const idx = input.toLowerCase().lastIndexOf(tail.toLowerCase());
    if (idx <= 0) continue; // nothing was stripped, or the text was recased

    const preceding = input[idx - 1];
    assert.ok(
      /[^A-Za-z0-9]/.test(preceding),
      `[${name}] cut mid-word: "${input}" -> "${got.text}" ` +
        `(character before the cut was ${JSON.stringify(preceding)})`
    );
  }
});

// --- A timed-out search is HTTP 200 -----------------------------------
// GitHub answers a query that blew its time budget with 200, a truncated or
// empty `items`, and `incomplete_results: true`. Reading only `items` records
// that as a fully-searched query, which walks around the completeness gate:
// `unchecked` stays empty, main() passes `complete: true`, and an open report
// is rewritten — or, with nothing left, closed. A search that never finished
// would read as an all-clear.

test('incomplete_results is not a clean result', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => '25' },
    json: async () => ({ incomplete_results: true, items: [] }),
  });

  const result = await searchRepositories('topic:jtag');
  assert.notStrictEqual(result.status, 'ok', 'a timed-out query is not "ok"');
  assert.strictEqual(result.status, 'partial');
  assert.match(result.detail, /partial result set|time budget/);
});

test('a partial result still contributes the repositories it did return', () => {
  const selection = selectCandidates(
    [{ query: 'topic:fault-injection', status: 'partial', detail: 'timed out', items: [repo()] }],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.candidates.length, 1, 'real results are not thrown away');
  assert.strictEqual(selection.unchecked.length, 1, 'but the query is still not fully searched');
});

test('a partial result makes the run incomplete, so it cannot close a report', async (t) => {
  const selection = selectCandidates(
    [{ query: 'topic:fault-injection', status: 'partial', detail: 'timed out', items: [] }],
    list,
    noDeclines,
    NOW
  );

  // This is the exact shape that used to slip through: 200, no items, so
  // actionable is 0 for a reason that is not true.
  assert.strictEqual(selection.unchecked.length, 1);
  const complete = selection.unchecked.length === 0;
  assert.strictEqual(complete, false);

  const calls = issueHarness(t, { existingIssue: true });
  await reportIssue(render(selection).body, 0, { complete });

  assert.strictEqual(
    calls.filter((c) => c.method !== 'GET').length,
    0,
    'a timed-out search must not close the review queue'
  );
});

test('incomplete_results:false is an ordinary clean result', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => '25' },
    json: async () => ({ incomplete_results: false, items: [] }),
  });

  const result = await searchRepositories('topic:jtag');
  assert.strictEqual(result.status, 'ok');
});

// --- Placement across several candidates ------------------------------
// Placing each candidate against the pristine README is wrong as soon as two
// land in the same section: both get the same line and the same neighbours,
// so applying the first invalidates the second. An exact position is the main
// thing this report offers, and with a twelve-candidate cap funnelling into a
// handful of sections, two in one section is ordinary.

function faultInjectionRepo(name) {
  return repo({
    full_name: `acme/${name.toLowerCase()}`,
    name,
    html_url: `https://github.com/acme/${name.toLowerCase()}`,
    description: 'Voltage glitching harness for embedded targets.',
    topics: ['fault-injection', 'glitching'],
  });
}

function emulationRepo(name) {
  return repo({
    full_name: `acme/${name.toLowerCase()}`,
    name,
    html_url: `https://github.com/acme/${name.toLowerCase()}`,
    description: 'QEMU-based firmware rehosting harness for embedded images.',
    topics: [],
  });
}

test('every neighbour named is a real entry, never another candidate', () => {
  const selection = selectCandidates(
    [ok('q', [faultInjectionRepo('Glitchy'), faultInjectionRepo('Warlock')])],
    list,
    noDeclines,
    NOW
  );

  const proposed = new Set(selection.candidates.map((c) => c.name));
  const listed = new Set(
    [...list.sections.values()].flatMap((s) => s.entries.map((e) => e.label))
  );

  for (const c of selection.candidates) {
    for (const side of [c.placement.after, c.placement.before]) {
      if (!side) continue;
      assert.ok(
        listed.has(side.label) && !proposed.has(side.label),
        `${c.name} is placed against "${side.label}", which is another ` +
          'candidate rather than an entry that actually exists — a reviewer ' +
          'who declines it is left with a position anchored to nothing'
      );
    }
  }
});

// Two candidates that sort into the same gap legitimately share a position:
// each describes the file as it is now, not as it would be after the other.
test('siblings in one gap are both placed against the unmodified file', () => {
  const selection = selectCandidates(
    [ok('q', [faultInjectionRepo('Glitchy'), faultInjectionRepo('Warlock')])],
    list,
    noDeclines,
    NOW
  );

  for (const c of selection.candidates) {
    assert.strictEqual(c.placement.after.label, 'Fault Tool');
    assert.strictEqual(c.placement.before.label, 'Zapper');
  }
});

// The strongest available assertion: actually apply the insertions in report
// order and re-run the alphabetical check over the result.
test('applying every proposed position bottom-up leaves the list sorted', () => {
  const selection = selectCandidates(
    [
      ok('q', [
        faultInjectionRepo('Glitchy'),
        faultInjectionRepo('Warlock'),
        faultInjectionRepo('Abacus'),
        emulationRepo('Rehoster'),
      ]),
    ],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.candidates.length, 4);

  // Positions describe the file as it stands, so they are applied bottom-up:
  // an insertion never shifts the lines above it, which is what makes every
  // position exact no matter how many are applied.
  const lines = FAKE_README.split('\n');
  // Two candidates that sort into the same gap share a line number, so
  // bottom-up alone leaves their order relative to each other undetermined.
  // A maintainer settles that the way the list always does — alphabetically,
  // which check-readme.js enforces — so the tie breaks on sortKey descending.
  const bottomUp = [...selection.candidates].sort(
    (a, b) =>
      b.placement.lineNo - a.placement.lineNo ||
      sortKey(b.name).localeCompare(sortKey(a.name))
  );
  for (const c of bottomUp) {
    assert.ok(c.placement, `${c.name} should have a position`);
    lines.splice(c.placement.lineNo - 1, 0, entryLine(c));
  }

  const after = readList(lines);
  for (const [name, section] of after.sections) {
    const labels = section.entries.map((e) => e.label);
    const sorted = [...labels].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    assert.deepStrictEqual(
      labels,
      sorted,
      `"${name}" is out of alphabetical order after applying the proposals`
    );
  }

});

// The per-candidate half of the same contract: applied on its own against the
// file as it stands, each proposal lands exactly on the line it names, between
// exactly the two entries it names. This is what "positions describe
// README.md as it is now" actually promises, and it holds for any candidate in
// any combination — which is why a partial selection stays exact.
test('each proposal applied alone lands exactly where the report said', () => {
  const selection = selectCandidates(
    [
      ok('q', [
        faultInjectionRepo('Glitchy'),
        faultInjectionRepo('Warlock'),
        faultInjectionRepo('Abacus'),
        emulationRepo('Rehoster'),
      ]),
    ],
    list,
    noDeclines,
    NOW
  );

  for (const c of selection.candidates) {
    const only = FAKE_README.split('\n');
    only.splice(c.placement.lineNo - 1, 0, entryLine(c));

    assert.match(
      only[c.placement.lineNo - 1],
      new RegExp(`\\[${c.name}\\]`),
      `${c.name} did not land on line ${c.placement.lineNo}`
    );
    if (c.placement.after) {
      assert.match(
        only[c.placement.lineNo - 2],
        new RegExp(`\\[${c.placement.after.label}\\]`),
        `${c.name} does not sit directly after ${c.placement.after.label}`
      );
    }
    if (c.placement.before) {
      assert.match(
        only[c.placement.lineNo],
        new RegExp(`\\[${c.placement.before.label}\\]`),
        `${c.name} does not sit directly before ${c.placement.before.label}`
      );
    }

    // ...and the section it went into is still correctly ordered.
    const section = readList(only).sections.get(c.section);
    const labels = section.entries.map((e) => e.label);
    const sorted = [...labels].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    assert.deepStrictEqual(labels, sorted, `"${c.section}" unsorted after ${c.name}`);
  }
});

test('positions are computed independently, with no cross-section shift', () => {
  const selection = selectCandidates(
    [ok('q', [faultInjectionRepo('Abacus'), emulationRepo('Rehoster')])],
    list,
    noDeclines,
    NOW
  );

  const fault = selection.candidates.find((c) => c.section === 'Fault Injection');
  const emul = selection.candidates.find((c) => c.section === 'Emulation Tools');
  assert.ok(fault && emul);

  // Qiling sits at line 17 in the fixture, so Rehoster follows it at 18 —
  // unaffected by Abacus going in at line 11, because that insertion has not
  // been applied. Under the old cumulative scheme this read 19.
  assert.strictEqual(fault.placement.lineNo, 11);
  assert.strictEqual(emul.placement.lineNo, 18);
});

test('placement does not mutate the caller\'s section index', () => {
  const before = list.sections.get('Fault Injection').entries.map((e) => `${e.label}:${e.lineNo}`);

  selectCandidates(
    [ok('q', [faultInjectionRepo('Glitchy'), faultInjectionRepo('Warlock')])],
    list,
    noDeclines,
    NOW
  );

  const after = list.sections.get('Fault Injection').entries.map((e) => `${e.label}:${e.lineNo}`);
  assert.deepStrictEqual(after, before, 'the shared README index must stay pristine');
});

// --- Metadata we cannot read is not metadata that passed ---------------

test('an unparseable pushed_at is filtered out, not silently kept', () => {
  for (const bad of ['not-a-date', '', null, undefined, 0]) {
    const selection = selectCandidates(
      [ok('q', [repo({ pushed_at: bad })])],
      list,
      noDeclines,
      NOW
    );
    assert.strictEqual(
      selection.candidates.length,
      0,
      `pushed_at ${JSON.stringify(bad)} must not reach the report`
    );
  }
});

test('an unreadable timestamp is reported apart from genuine dormancy', () => {
  const selection = selectCandidates(
    [ok('q', [repo({ pushed_at: 'not-a-date' })])],
    list,
    noDeclines,
    NOW
  );

  assert.strictEqual(selection.rejected.unusable, 1);
  assert.strictEqual(selection.rejected.dormant, 0, 'that is a different fact');
});

test('a valid timestamp still passes', () => {
  const selection = selectCandidates([ok('q', [repo()])], list, noDeclines, NOW);
  assert.strictEqual(selection.candidates.length, 1);
  assert.strictEqual(selection.rejected.unusable, 0);
});

// --- preflight must fail closed ---------------------------------------

test('unreadable JSON from /rate_limit is a refusal, not a stack trace', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => {
      throw new Error('Unexpected token < in JSON');
    },
  });

  const result = await preflight(15);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /unreadable JSON/);
});

test('a rate_limit body with no quota block refuses the run', async (t) => {
  const realFetch = global.fetch;
  t.after(() => {
    global.fetch = realFetch;
  });

  for (const body of [{}, { resources: {} }, { resources: { core: { remaining: 5000, reset: 0 } } }]) {
    global.fetch = async () => ({ status: 200, ok: true, json: async () => body });

    const result = await preflight(15);
    assert.strictEqual(
      result.ok,
      false,
      `${JSON.stringify(body)} must not authorise 15 blind searches`
    );
    assert.match(result.reason, /quota|unknown/i);
  }
});

// The property pristine semantics were chosen for: a maintainer who accepts
// only some proposals — the normal outcome, which is why declined-candidates
// .json exists — still gets an exact position for every one they take, as
// long as they work bottom-up. Cumulative numbering could never promise this.
test('any subset applied bottom-up lands exactly, not just the whole set', () => {
  const selection = selectCandidates(
    [
      ok('q', [
        faultInjectionRepo('Glitchy'),
        faultInjectionRepo('Abacus'),
        faultInjectionRepo('Warlock'),
        emulationRepo('Rehoster'),
      ]),
    ],
    list,
    noDeclines,
    NOW
  );
  assert.strictEqual(selection.candidates.length, 4);

  // Every one of the 16 accept/decline combinations.
  for (let mask = 0; mask < 1 << selection.candidates.length; mask++) {
    const taken = selection.candidates.filter((_, i) => mask & (1 << i));
    if (taken.length === 0) continue;

    const lines = FAKE_README.split('\n');
    const bottomUp = [...taken].sort(
      (a, b) =>
        b.placement.lineNo - a.placement.lineNo ||
        sortKey(b.name).localeCompare(sortKey(a.name))
    );
    for (const c of bottomUp) lines.splice(c.placement.lineNo - 1, 0, entryLine(c));

    const after = readList(lines);
    for (const [name, section] of after.sections) {
      const labels = section.entries.map((e) => e.label);
      const sorted = [...labels].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      assert.deepStrictEqual(
        labels,
        sorted,
        `"${name}" is unsorted after accepting ${taken.map((c) => c.name).join(', ')}`
      );
    }
  }
});
