#!/usr/bin/env node
// Validates README.md: catches duplicate links, malformed list-item
// syntax, and a Table of Contents that's out of sync with the actual
// ## / ### headings — none of which markdownlint/awesome-lint check.

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

// --- Table of Contents <-> heading sync check -------------------------
// The ToC is plain text (not anchor links), so this can't be a link
// checker; instead verify the set of ToC entries matches the set of
// actual ## / ### headings, including their ## -> ### grouping. Order
// is intentionally not enforced (the ToC and document order are already
// allowed to diverge), only presence/absence.

const tocStart = lines.findIndex((l) => l.trim() === '## Table of Contents');
if (tocStart === -1) {
  errors.push('README.md: could not find "## Table of Contents" heading.');
} else {
  const tocEnd = lines.findIndex(
    (l, i) => i > tocStart && /^##\s+/.test(l)
  );
  const tocLines = lines.slice(tocStart + 1, tocEnd === -1 ? lines.length : tocEnd);

  const tocSections = new Map(); // top-level name -> Set of nested names
  let currentTop = null;
  for (const line of tocLines) {
    const topMatch = line.match(/^\*\s+(.+?)\s*$/);
    const nestedMatch = line.match(/^\s{2,}\*\s+(.+?)\s*$/);
    if (nestedMatch) {
      if (currentTop) tocSections.get(currentTop).add(nestedMatch[1]);
    } else if (topMatch) {
      currentTop = topMatch[1];
      tocSections.set(currentTop, new Set());
    }
  }

  // Group actual ## / ### headings the same way, skipping the ToC heading.
  const docSections = new Map();
  let currentDocTop = null;
  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+?)\s*$/);
    const h3Match = line.match(/^###\s+(.+?)\s*$/);
    if (h2Match) {
      if (h2Match[1] === 'Table of Contents') {
        currentDocTop = null;
        continue;
      }
      currentDocTop = h2Match[1];
      docSections.set(currentDocTop, new Set());
    } else if (h3Match && currentDocTop) {
      docSections.get(currentDocTop).add(h3Match[1]);
    }
  }

  const tocTops = new Set(tocSections.keys());
  const docTops = new Set(docSections.keys());

  for (const name of tocTops) {
    if (!docTops.has(name)) {
      errors.push(`README.md: ToC lists "${name}" but no matching "## ${name}" heading exists.`);
    }
  }
  for (const name of docTops) {
    if (!tocTops.has(name)) {
      errors.push(`README.md: "## ${name}" heading exists but is missing from the ToC.`);
    }
  }

  for (const name of tocTops) {
    if (!docTops.has(name)) continue;
    const tocNested = tocSections.get(name);
    const docNested = docSections.get(name);
    for (const sub of tocNested) {
      if (!docNested.has(sub)) {
        errors.push(`README.md: ToC lists "${sub}" under "${name}" but no matching "### ${sub}" heading exists.`);
      }
    }
    for (const sub of docNested) {
      if (!tocNested.has(sub)) {
        errors.push(`README.md: "### ${sub}" heading under "${name}" is missing from the ToC.`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Found ${errors.length} issue(s) in README.md:\n`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(`README.md check passed: ${seenUrls.size} unique entries, ToC matches headings, no duplicates or malformed links.`);
