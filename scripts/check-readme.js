#!/usr/bin/env node
// Validates README.md list entries: catches duplicate links and malformed
// bullet syntax that markdownlint/awesome-lint don't check for.

'use strict';

const fs = require('fs');
const path = require('path');

const README_PATH = path.join(__dirname, '..', 'README.md');
const lines = fs.readFileSync(README_PATH, 'utf8').split('\n');

// Matches list items that start with a markdown link, e.g.
// "* [Name](https://example.com) - Description."
const LINK_ITEM_RE = /^\s*\*\s+\[([^\]]*)\]\(([^)]*)\)/;
// Matches list items that look like a link but have broken bracket/paren
// pairing (missing `]`, missing `(`, etc.) so they fail LINK_ITEM_RE silently.
const BROKEN_LINK_ITEM_RE = /^\s*\*\s+\[/;

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    let pathName = u.pathname.replace(/\/+$/, '');
    return `${host}${pathName}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

const seenUrls = new Map(); // normalizedUrl -> { lineNo, raw }
const errors = [];

lines.forEach((line, idx) => {
  const lineNo = idx + 1;
  const linkMatch = line.match(LINK_ITEM_RE);

  if (linkMatch) {
    const [, name, url] = linkMatch;

    if (!name.trim()) {
      errors.push(`README.md:${lineNo}: list entry has an empty link label.`);
    }
    if (!url.trim()) {
      errors.push(`README.md:${lineNo}: list entry has an empty URL.`);
    }

    if (url.trim()) {
      const key = normalizeUrl(url.trim());
      if (seenUrls.has(key)) {
        const prev = seenUrls.get(key);
        errors.push(
          `README.md:${lineNo}: duplicate URL "${url.trim()}" ` +
            `(already listed at line ${prev.lineNo} as "${prev.raw}").`
        );
      } else {
        seenUrls.set(key, { lineNo, raw: name.trim() });
      }
    }
    return;
  }

  if (BROKEN_LINK_ITEM_RE.test(line)) {
    errors.push(
      `README.md:${lineNo}: list entry starts like a link but is malformed: "${line.trim()}"`
    );
  }
});

if (errors.length > 0) {
  console.error(`Found ${errors.length} issue(s) in README.md:\n`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(`README.md check passed: ${seenUrls.size} unique entries, no duplicates or malformed links.`);
