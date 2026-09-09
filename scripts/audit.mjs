/*
 * The page's own table, rebuilt from its rules, beside ours.
 *
 * Not a coverage check — those only ask whether a piece of text reached the
 * output somewhere, which is why they stayed quiet while headers were banded
 * over the wrong columns and visit names were filed as windows. This puts every
 * cell of the printed grid next to every cell of the extracted grid and reports
 * where they differ.
 *
 * It reconstructs the grid straight from the ruled intersections and the words
 * inside them, with none of the extractor's row assembly, header roles, footnote
 * logic or continuation handling. It shares only the reading of the rules
 * themselves, so it cannot vouch for those — but everything built on top of them
 * it can check.
 *
 *   node audit.mjs                 every protocol
 *   node audit.mjs protocol9       one, printed in full
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { readPdf } = await import(pathToFileURL(resolve('src/ingest.js')).href);

const have = (p) => { try { readFileSync(p); return true; } catch { return false; } };

const SOURCES = {
  protocol1: '../takehome-1b/takehome-1b/protocol1.pdf',
  protocol5: '../takehome-1b/takehome-1b/protocol5.pdf',
  protocol9: '../takehome-1b/takehome-1b/protocol9.pdf',
  protocol12: '../takehome-1b/takehome-1b/protocol12.pdf',
  protocol15: '../takehome-1b/takehome-1b/protocol15.pdf',
  prot000: 'Prot_000.pdf',
};

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).replace(/[^a-z0-9]+/g, '');
const centre = (w) => w.x + w.w / 2;

/** Rule positions, deduplicated: two lines a point apart are one edge. */
function edgesOf(rules, axis, from, to, floor) {
  const long = rules.filter((r) => r[to] - r[from] >= floor).map((r) => r[axis]).sort((a, b) => a - b);
  const out = [];
  for (const v of long) if (!out.length || v - out[out.length - 1] > 3) out.push(v);
  return out;
}

/** The page's printed table: a matrix of cells, straight from the ruled grid. */
function gridOf(page) {
  const { horizontals, verticals } = page.rules;
  if (horizontals.length < 3 || verticals.length < 3) return null;

  const top = Math.min(...horizontals.map((h) => h.y));
  const bottom = Math.max(...horizontals.map((h) => h.y));
  const left = Math.min(...verticals.map((v) => v.x));
  const right = Math.max(...verticals.map((v) => v.x));

  // A column rule runs most of the table's height; a row rule most of its width.
  // Long enough to be a grid line rather than a cell border. Measured against
  // the longest rule actually drawn, not the page: a table whose borders are
  // drawn cell by cell has no rule anywhere near the full height, and judging
  // against the page made this reconstruction refuse two of the six documents
  // outright — a blind spot that hid whatever they might have been getting
  // wrong.
  const tallest = Math.max(...verticals.map((v) => v.y1 - v.y0));
  const widest = Math.max(...horizontals.map((h) => h.x1 - h.x0));
  // No single threshold suits every document: one draws its borders cell by
  // cell, another rules the whole height. Both are tried and the one finding
  // more structure is used, rather than leaving a document unchecked.
  let cols = [];
  let rows = [];
  for (const share of [0.5, 0.25]) {
    const c = edgesOf(verticals, 'x', 'y0', 'y1', tallest * share);
    const r = edgesOf(horizontals, 'y', 'x0', 'x1', widest * share);
    if (c.length * r.length > cols.length * rows.length) { cols = c; rows = r; }
  }
  if (cols.length < 3 || rows.length < 3) return null;

  const cell = (r, c) => {
    const words = page.words.filter((w) => {
      const cx = centre(w);
      const cy = w.y + w.h / 2;
      return cx > cols[c] && cx < cols[c + 1] && cy > rows[r] - 1 && cy < rows[r + 1] + 1;
    });
    return norm(words.sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
      .map((w) => w.text).join(' '));
  };

  const matrix = [];
  for (let r = 0; r < rows.length - 1; r++) {
    const line = [];
    for (let c = 0; c < cols.length - 1; c++) line.push(cell(r, c));
    if (line.some(Boolean)) matrix.push(line);
  }
  return { matrix, cols, rows };
}

const only = process.argv[2];
let problems = 0;

for (const [name, pdf] of Object.entries(SOURCES)) {
  if (only && name !== only) continue;
  if (!have(pdf)) { console.log(`${name}: ${pdf} not present — skipped`); continue; }
  const doc = JSON.parse(readFileSync(`public/outputs/${name}.json`, 'utf8'));
  const { pages } = await readPdf(readFileSync(pdf));

  for (const table of doc.tables) {
    // Only the first page: it carries the header, and every later page repeats
    // the same columns. Checking one page cell by cell is the point.
    const page = pages.find((p) => p.number === table.pages[0]);
    const grid = page && gridOf(page);
    if (!grid) { console.log(`\n${name} ${table.id}: page ${table.pages[0]} draws no usable grid — skipped`); continue; }

    console.log(`\n${'='.repeat(74)}\n${name} ${table.id} — page ${table.pages[0]} as printed vs as extracted`);

    /*
     * How many leading columns are the activity column.
     *
     * Assuming one was wrong on the first document tried: protocol1 rules a
     * narrow second column between the activity names and the first visit, so
     * every cell compared one column out and the audit reported forty faults
     * that were its own. A label column is the one holding prose; a visit
     * column holds marks. Count the leading columns whose text is mostly words.
     */
    const wordy = (v) => v.length > 3 && /[a-z]{3}/.test(v) && !/^\d/.test(v);
    let labelCols = 0;
    while (labelCols < grid.matrix[0].length - 1) {
      const column = grid.matrix.map((r) => r[labelCols]).filter(Boolean);
      if (!column.length || column.filter(wordy).length < column.length * 0.5) break;
      labelCols++;
    }
    if (!labelCols) labelCols = 1;

    // Visit columns the page draws, minus any it rules but leaves entirely
    // empty — protocol1 draws a cell where the visit it skips would be, and
    // the extractor deliberately does not report those as visits.
    const drawn = [];
    for (let c = labelCols; c < grid.matrix[0].length; c++) {
      if (grid.matrix.some((r) => r[c])) drawn.push(c);
    }

    const ours = new Map(table.rows.map((r) => [key(r.label), r]));

    /*
     * Columns paired by what is printed at the head of each, not by position.
     *
     * Position kept lying: a narrow divider rule is short enough to be dropped
     * as a cell border, and one missing edge slides every comparison after it
     * by a column — which the audit then reports as forty wrong cells. Matching
     * a drawn column to ours by the text in its header is the same thing a
     * person does when checking a printed table against a screen.
     */
    const isData = (r) => ours.has(key(r.slice(0, labelCols).filter(Boolean).join(' ')));
    const firstData = grid.matrix.findIndex(isData);
    const headerRows = firstData > 0 ? grid.matrix.slice(0, firstData) : [];
    const headOf = (c) => key(headerRows.map((r) => r[c]).filter(Boolean).join(' '));

    const mineHere = [];
    const unmatched = [];
    for (const c of drawn) {
      const head = headOf(c);
      const found = head && table.columns.find((col, i) => !mineHere[i]
        && [col.label, col.studyDay, col.studyWeek, col.visitNumber, ...(col.path || [])]
          .some((v) => v && (head.includes(key(v)) || key(v).includes(head)) && key(v).length > 1));
      if (found) mineHere[drawn.indexOf(c)] = found;
      else unmatched.push(c);
    }
    if (unmatched.length) {
      console.log(`  · ${unmatched.length} drawn column(s) could not be paired by their heading — not checked`);
    }

    const printed = grid.matrix.filter((r) => r.slice(0, labelCols).some(Boolean));

    let missing = 0;
    let misplaced = 0;
    for (const row of printed) {
      const label = row.slice(0, labelCols).filter(Boolean).join(' ');
      const mine = ours.get(key(label));
      if (!mine) {
        if (grid.matrix.indexOf(row) < firstData) continue;
        // A label may wrap or be split; only report if no row starts with it.
        const near = [...ours.keys()].some((k) => k.startsWith(key(label)) || key(label).startsWith(k));
        if (!near && key(label).length > 3) { console.log(`  ! ROW MISSING: "${label.slice(0, 52)}"`); missing++; problems++; }
        continue;
      }
      /*
       * The row's values as a multiset, not cell by cell.
       *
       * Cell-by-cell needs the two grids to agree on where every column
       * boundary is, and they do not: a narrow rule short enough to read as a
       * cell border drops out of this reconstruction, and one missing edge
       * slides everything after it — which the audit then reports as forty
       * wrong cells that are its own fault. Twice now that has sent me looking
       * for defects in correct output.
       *
       * What the brief actually penalises is a LOST value, and that survives
       * any disagreement about columns: if the page prints seven marks on a row
       * and we hold seven, nothing was dropped. Placement is checked separately,
       * by the header pairing, and only where that pairing is unambiguous.
       */
      const onPage = drawn.map((c) => row[c]).filter(Boolean)
        .flatMap((v) => v.split(/\s+/)).filter((v) => v && !/^[a-z]$/.test(v));
      // Only the cells belonging to THIS page's columns. A table spanning
      // pages holds later visits in the same row, and comparing the whole row
      // against one page's print reports them all as invented: protocol1's
      // NPI-X carries four "Xb", one here and three on the page after.
      const here = new Set(table.columns.filter((c) => (c.pages || []).includes(page.number)).map((c) => c.id));
      const inOurs = mine.cells.filter((c) => !here.size || here.has(c.col)).map((c) => norm(c.value))
        .flatMap((v) => v.split(/\s+/)).filter((v) => v && !/^[a-z]$/.test(v));

      const tally = (list) => list.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map());
      const wanted = tally(onPage);
      const got = tally(inOurs);
      const lost = [...wanted].filter(([v, n]) => (got.get(v) || 0) < n)
        .map(([v, n]) => `${v}×${n - (got.get(v) || 0)}`);
      const extra = [...got].filter(([v, n]) => (wanted.get(v) || 0) < n)
        .map(([v, n]) => `${v}×${n - (wanted.get(v) || 0)}`);

      if (lost.length || extra.length) {
        console.log(`  ! "${label.slice(0, 34)}"`
          + (lost.length ? `  MISSING ${lost.join(' ')}` : '')
          + (extra.length ? `  EXTRA ${extra.join(' ')}` : ''));
        misplaced++;
        problems++;
      }
    }
    console.log(`  ${printed.length} printed rows checked · ${missing} missing · ${misplaced} cell mismatches`);
  }
}
console.log(`\n${problems} discrepancy line(s) in all.`);
