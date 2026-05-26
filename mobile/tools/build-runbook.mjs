#!/usr/bin/env node
// Generates reda_admin_runbook.md from mobile/src/help/content.ts.
//
// The in-app help guide is the source of truth for runbook content; this
// script produces the printable markdown version. Every time you edit the
// `ADMIN` sections in content.ts, run `npm run build:runbook` (from inside
// mobile/) and commit both files together.
//
// Usage (from mobile/):
//   npm run build:runbook                    # write the file
//   npm run check:runbook                    # fail (exit 1) if file is stale
//
// Or directly:
//   node mobile/tools/build-runbook.mjs           # write
//   node mobile/tools/build-runbook.mjs --check   # check
//
// The parser is intentionally simple. It assumes content.ts keeps the shape:
//   const ADMIN = [
//     { id: '...', title: '...' or `...`, icon: '...', body: `...` },
//     ...
//   ] as const satisfies readonly HelpSection[];
// If you break that shape, the script will throw — fix the script, don't
// special-case the content.
//
// Lives at mobile/tools/ rather than scripts/ at the repo root because
// scripts/ is gitignored (it holds operational SQL with real data) and this
// generator needs to be checked in so CI + new clones can run check:runbook.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname is mobile/tools/; ROOT goes two levels up to the repo root.
const ROOT     = resolve(__dirname, '..', '..');
const CONTENT  = resolve(ROOT, 'mobile', 'src', 'help', 'content.ts');
const RUNBOOK  = resolve(ROOT, 'reda_admin_runbook.md');

const src = readFileSync(CONTENT, 'utf8');

// Find the start of the ADMIN array body. Skip past the type annotation's
// own `[]` (`readonly HelpSection[]`) and look for `= [`.
const adminDecl = src.indexOf('const ADMIN');
if (adminDecl < 0) throw new Error('Could not find `const ADMIN` in content.ts');
const eqIdx = src.indexOf('=', adminDecl);
const openBracket = src.indexOf('[', eqIdx);
if (openBracket < 0) throw new Error('Could not find opening [ for ADMIN');

// Walk forward, counting brackets, respecting string/template literal contexts.
let depth = 0;
let inSingle = false;
let inDouble = false;
let inBacktick = false;
let inLineComment = false;
let inBlockComment = false;
let i = openBracket;
const sectionStarts = []; // depth-1 `{` positions
const sectionEnds   = []; // depth-1 `}` positions (matching)

for (; i < src.length; i++) {
  const c  = src[i];
  const c2 = src[i + 1];
  if (inLineComment) {
    if (c === '\n') inLineComment = false;
    continue;
  }
  if (inBlockComment) {
    if (c === '*' && c2 === '/') { inBlockComment = false; i++; }
    continue;
  }
  if (inSingle) {
    if (c === '\\') { i++; continue; }
    if (c === "'") inSingle = false;
    continue;
  }
  if (inDouble) {
    if (c === '\\') { i++; continue; }
    if (c === '"') inDouble = false;
    continue;
  }
  if (inBacktick) {
    if (c === '\\') { i++; continue; }
    if (c === '`')  inBacktick = false;
    continue;
  }
  // Outside any string.
  if (c === '/' && c2 === '/') { inLineComment = true; i++; continue; }
  if (c === '/' && c2 === '*') { inBlockComment = true; i++; continue; }
  if (c === "'")  { inSingle = true; continue; }
  if (c === '"')  { inDouble = true; continue; }
  if (c === '`')  { inBacktick = true; continue; }
  if (c === '[') { depth++; continue; }
  if (c === ']') {
    depth--;
    if (depth === 0) break;
    continue;
  }
  if (c === '{') {
    if (depth === 1) sectionStarts.push(i);
    depth++;
    continue;
  }
  if (c === '}') {
    depth--;
    if (depth === 1) sectionEnds.push(i);
    continue;
  }
}

if (sectionStarts.length === 0 || sectionStarts.length !== sectionEnds.length) {
  throw new Error(`ADMIN parse failed: ${sectionStarts.length} starts vs ${sectionEnds.length} ends`);
}

const sections = [];
for (let k = 0; k < sectionStarts.length; k++) {
  const blockText = src.slice(sectionStarts[k], sectionEnds[k] + 1);

  // id: 'slug' or `slug`
  const idMatch = blockText.match(/\bid:\s*(['`])([^'`]+)\1/);
  if (!idMatch) throw new Error(`section ${k}: no id matched in:\n${blockText.slice(0, 80)}`);
  const id = idMatch[2];

  // title: '...' or `...`. Allow internal apostrophes inside backticks.
  const titleMatch =
    blockText.match(/\btitle:\s*`([^`]+)`/) ||
    blockText.match(/\btitle:\s*'((?:\\.|[^'\\])+)'/);
  if (!titleMatch) throw new Error(`section ${id}: no title matched`);
  const title = titleMatch[1].replace(/\\(['`\\])/g, '$1');

  // body: `...` (template literal, may span multiple lines)
  const bodyIdx = blockText.search(/\bbody:\s*\n?\s*`/);
  if (bodyIdx < 0) throw new Error(`section ${id}: no body found`);
  const bodyOpen = blockText.indexOf('`', bodyIdx);
  if (bodyOpen < 0) throw new Error(`section ${id}: no body open backtick`);
  let j = bodyOpen + 1;
  while (j < blockText.length) {
    if (blockText[j] === '\\') { j += 2; continue; }
    if (blockText[j] === '`')  break;
    j++;
  }
  if (j >= blockText.length) throw new Error(`section ${id}: unterminated body backtick`);
  const body = blockText.slice(bodyOpen + 1, j);

  sections.push({ id, title, body: body.trim() });
}

// Render the runbook.
const preamble =
`# Reda Admin — Daily Runbook (for Uzo)

This guide is generated from the in-app help content. To edit it, change
\`mobile/src/help/content.ts\` and run \`npm run build:runbook\` from inside
\`mobile/\`. Do not edit this file by hand.

Print it, keep it next to your phone. Most days, you'll do **Reconcile**
and **End of day**.
`;

const footer =
`
---

## What the icons mean

| Icon  | Meaning                                      |
|-------|----------------------------------------------|
| Home  | Today's overview + quick actions             |
| Truck | All deliveries, filterable                   |
| Wallet| Money owed: by-client + by-agent             |
| Bot   | Bot output needing your eyes                 |
| Box   | Catalog: clients, products, locations, rates |
| Help  | This guide, in the app                       |
| Gear  | Profile, sign out, sync status               |

---

*Generated from \`mobile/src/help/content.ts\` — do not edit by hand.*
`;

let md = preamble;
for (const s of sections) {
  md += `\n---\n\n## ${s.title}\n\n${s.body}\n`;
}
md += footer;

const check = process.argv.includes('--check');
if (check) {
  let existing = '';
  try { existing = readFileSync(RUNBOOK, 'utf8'); } catch { /* missing */ }
  if (existing.trimEnd() !== md.trimEnd()) {
    console.error('reda_admin_runbook.md is out of date relative to mobile/src/help/content.ts.');
    console.error('Run `npm run build:runbook` (from mobile/) and commit the result.');
    process.exit(1);
  }
  console.log(`reda_admin_runbook.md is up to date (${sections.length} sections).`);
  process.exit(0);
}

writeFileSync(RUNBOOK, md);
console.log(`Wrote ${RUNBOOK} (${sections.length} sections, ${md.length} chars).`);
