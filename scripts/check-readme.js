#!/usr/bin/env node
// Validates README.md: catches duplicate links, malformed list-item
// syntax, entries that are out of alphabetical order, and a Table of
// Contents that's out of sync with the actual ## / ### headings — none
// of which markdownlint/awesome-lint check.

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
// Matches a Table of Contents entry: "* [Name](#anchor)", any nesting depth.
const TOC_ITEM_RE = /^(\s*)\*\s+\[([^\]]+)\]\(#([^)]*)\)\s*$/;

// Sort key for an entry label. Leading punctuation is dropped so that
// ".NET" files under N rather than ahead of everything, matching how the
// list is actually ordered. Only *leading* punctuation is stripped —
// stripping it throughout would reorder existing pairs like
// "EM-Fault-It-Yourself"/"emba" — and letters are preserved, so the "μ" in
// μAFL and μEmu still sorts as a letter.
function sortKey(label) {
  return label.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '');
}

// GitHub's heading-anchor algorithm: lowercase, drop everything that isn't
// alphanumeric/underscore/space/hyphen, then spaces become hyphens.
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-');
}

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

const errors = [];

// --- Locate the Table of Contents ------------------------------------
// Found up front so the entry scan below can skip it: since the ToC is
// anchored, its items are markdown links and would otherwise be counted
// as list entries (and flagged as duplicates of each other).

const tocStart = lines.findIndex((l) => l.trim() === '## Contents');
const tocEnd =
  tocStart === -1
    ? -1
    : lines.findIndex((l, i) => i > tocStart && /^##\s+/.test(l));
const tocLast = tocEnd === -1 ? lines.length : tocEnd;

if (tocStart === -1) {
  errors.push('README.md: could not find "## Contents" heading.');
}

// --- Entry scan: duplicates and malformed links -----------------------

const seenUrls = new Map(); // normalizedUrl -> { lineNo, raw }

lines.forEach((line, idx) => {
  const lineNo = idx + 1;

  if (tocStart !== -1 && idx > tocStart && idx < tocLast) return;

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

// --- Alphabetical order check ----------------------------------------
// Entries are kept alphabetically within each group of siblings. A group
// is a run of list items at the same indent under the same heading, so
// nested lists (the language groups under Language Specific Decompilers,
// the categories under Other Awesome Lists) are each checked against
// themselves rather than against the surrounding list. Headings and the
// ToC break a group.

{
  const groups = [];
  const stack = [];
  let section = '';
  const closeAll = () => {
    while (stack.length > 0) groups.push(stack.pop());
  };

  lines.forEach((line, idx) => {
    if (tocStart !== -1 && idx > tocStart && idx < tocLast) return;

    const heading = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (heading) {
      closeAll();
      section = heading[1];
      return;
    }

    const item = line.match(/^(\s*)\*\s+(.*)$/);
    if (!item) return;

    const indent = item[1].length;
    const linked = item[2].match(/^\[([^\]]+)\]/);
    const entry = {
      section,
      label: linked ? linked[1] : item[2].trim(),
      lineNo: idx + 1,
    };

    while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
      groups.push(stack.pop());
    }
    if (stack.length === 0 || stack[stack.length - 1].indent < indent) {
      stack.push({ indent, members: [entry] });
    } else {
      stack[stack.length - 1].members.push(entry);
    }
  });
  closeAll();

  for (const group of groups) {
    if (group.members.length < 2) continue;
    for (let i = 1; i < group.members.length; i++) {
      const prev = group.members[i - 1];
      const curr = group.members[i];
      if (sortKey(prev.label).localeCompare(sortKey(curr.label)) > 0) {
        errors.push(
          `README.md:${curr.lineNo}: "${curr.label}" is out of alphabetical ` +
            `order under "${curr.section}" — it should come before ` +
            `"${prev.label}" (line ${prev.lineNo}).`
        );
      }
    }
  }
}

// --- Table of Contents <-> heading sync check -------------------------
// Verify that the set of ToC entries matches the set of actual ## / ###
// headings, including their ## -> ### grouping, and that every anchor
// actually resolves to the heading it names. Order is intentionally not
// enforced (the ToC and document order are already allowed to diverge),
// only presence/absence.

if (tocStart !== -1) {
  const tocSections = new Map(); // top-level name -> Set of nested names
  let currentTop = null;

  for (let i = tocStart + 1; i < tocLast; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const match = line.match(TOC_ITEM_RE);
    if (!match) {
      errors.push(
        `README.md:${i + 1}: ToC entry is not an anchor link ` +
          `("* [Name](#anchor)"): "${line.trim()}"`
      );
      continue;
    }

    const [, indent, name, anchor] = match;
    const expected = slugify(name);
    if (anchor !== expected) {
      errors.push(
        `README.md:${i + 1}: ToC anchor "#${anchor}" does not match ` +
          `heading "${name}" (expected "#${expected}").`
      );
    }

    if (indent.length >= 2) {
      if (currentTop) tocSections.get(currentTop).add(name);
    } else {
      currentTop = name;
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
      if (h2Match[1] === 'Contents') {
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

console.log(
  `README.md check passed: ${seenUrls.size} unique entries, ` +
    `alphabetized, ToC anchors resolve, no duplicates or malformed links.`
);
