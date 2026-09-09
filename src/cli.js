/*
 * cli.js — extract one or more protocols to JSON.
 *
 *   node src/cli.js path/to/protocol.pdf [more.pdf ...] [--out outputs]
 *
 * Same pipeline the web UI uses, so the committed outputs are reproducible.
 */

import { loadEnv } from './env.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { run } from './pipeline.js';

// Imports are hoisted, so this runs before any code below reads process.env.
loadEnv();

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : 'outputs';
// Guard the index: with no --out, outIndex is -1 and "outIndex + 1" is 0, which
// silently swallows the first file.
const files = args.filter((a, i) =>
  !a.startsWith('--') && !(outIndex >= 0 && (i === outIndex || i === outIndex + 1)));

if (!files.length) {
  console.error('usage: node src/cli.js <protocol.pdf> [...] [--out outputs]');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const started = Date.now();
  const result = await run(readFileSync(file), {
    assist: !args.includes('--no-assist'),
    log: (kind, message) => console.log(`   ${kind.padEnd(7)} ${message}`),
  });
  const name = basename(file, extname(file));
  const path = join(outDir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ sourceFile: basename(file), ...result }, null, 2));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${name}  ${result.pageCount}pp  ${seconds}s  →  ${path}`);
  for (const table of result.tables) {
    const cells = table.rows.reduce((n, r) => n + r.cells.length, 0);
    console.log(`   ${table.id}  pages ${table.pages.join(',')}  ${table.columns.length} cols  ${table.rows.length} rows  `
      + `${cells} cells  ${table.footnotes.length} footnotes  ${table.ambiguities.length} ambiguities`);
    if (table.title) console.log(`       "${table.title.slice(0, 70)}"`);
    const p = table.provenance;
    console.log(`       read by ${p.readBy}${p.model ? ` (${p.model})` : ''}  ·  confidence ${p.confidence}  →  ${String(p.verdict).toUpperCase()}`);
    if (p.geometric) console.log(`       the rule-based pass had ${p.geometric.columns} cols / ${p.geometric.rows} rows at ${p.geometric.confidence}`);
    for (const f of p.findings) console.log(`       [${f.severity}] ${f.check}: ${f.detail.slice(0, 105)}`);
  }
}
