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

const { readPdf, linesOf } = await import(pathToFileURL(resolve('src/ingest.js')).href);

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

  /*
   * Words are placed by the band their LINE is in, not their own middle.
   *
   * Word by word, a superscript rides above its baseline and the second line
   * of a two-line row sits below its band's edge, so each drifts into the
   * neighbouring row on its own. That is what reported five marks as missing
   * from rows the page never marks — the "e" printed on "BPRS" was read
   * against "Continuous BP, HR, ECG" above it. A line is the unit the page
   * sets its rows in, so a line belongs to one band and its words go with it.
   */
  const bandOf = new Map();
  for (const line of linesOf(page.words)) {
    const mid = (line.top + line.bottom) / 2;
    let band = rows.findIndex((y, i) => i < rows.length - 1 && mid > y - 1 && mid < rows[i + 1] + 1);
    // A line straddling an edge belongs to whichever band holds more of it.
    if (band >= 0) {
      const over = (i) => Math.min(line.bottom, rows[i + 1]) - Math.max(line.top, rows[i]);
      if (band + 1 < rows.length - 1 && over(band + 1) > over(band)) band += 1;
      if (band > 0 && over(band - 1) > over(band)) band -= 1;
    }
    for (const w of line.words) bandOf.set(w, band);
  }

  const cell = (r, c) => {
    const words = page.words.filter((w) => {
      const cx = centre(w);
      return cx > cols[c] && cx < cols[c + 1] && bandOf.get(w) === r;
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

/*
 * Any PDF, not only the ones with a published output.
 *
 * The documents that find real faults are the ones nobody has looked at, and
 * those cannot be committed here — so pass a path and the schedule is extracted
 * on the spot and compared against the page it came from:
 *
 *   node scripts/audit.mjs ../somewhere/Prot_111.pdf
 *
 * What is checked is identical either way. The only difference is where the
 * extraction comes from: the committed file, which carries a model review, or a
 * fresh rule-based read.
 */
const skipped = [];
const unchecked = [];
const only = process.argv[2];
const adhoc = only && /\.pdf$/i.test(only);
const targets = adhoc
  ? [[only.split(/[\\/]/).pop().replace(/\.pdf$/i, ''), only]]
  : Object.entries(SOURCES);
let problems = 0;

/*
 * Both readings of every document, not just the committed one.
 *
 * This script read `public/outputs/*.json` and nothing else, and those carry a
 * model review. So it checked the FILES and never the reader — while a reviewer
 * dropping a PDF into the UI gets the rule-based path, which is a different
 * answer. A bug living only there was invisible to every run of this audit, and
 * one did: protocol15's Treatment Week 1-3 column was being deleted outright by
 * the live reader while the committed file held it correctly, and this reported
 * the document clean for as long as that was true.
 *
 * Each document is now audited twice — as committed, and as the reader produces
 * it today — because those are two different claims and both get made.
 */
const readings = [];
for (const [name, pdf] of targets) {
  if (!adhoc && only && name !== only) continue;
  if (!have(pdf)) { console.log(`${name}: ${pdf} not present — skipped`); continue; }
  if (!adhoc) readings.push([`${name} (as committed)`, name, pdf, 'committed']);
  readings.push([`${name} (as read today)`, name, pdf, 'live']);
}

for (const [title, name, pdf, how] of readings) {
  let doc;
  if (how === 'live') {
    const { run } = await import(pathToFileURL(resolve('src/pipeline.js')).href);
    doc = await run(readFileSync(pdf), { assist: false });
    console.log(`\n### ${title} — rules only, extracted here: ${doc.tables.length} schedule(s)`);
  } else {
    doc = JSON.parse(readFileSync(`public/outputs/${name}.json`, 'utf8'));
    console.log(`\n### ${title}`);
  }
  const { pages } = await readPdf(readFileSync(pdf));

  for (const table of doc.tables) {
   /*
    * Every page of the table, not only the one carrying the header.
    *
    * Checking page one covered seven of these twenty pages, and left out
    * precisely where naive extraction is known to fail: a schedule running
    * across four pages, headers that repeat or do not or repeat abbreviated, a
    * continuation printed landscape. Whatever went wrong on page three went
    * unmeasured, and "verified" meant verified on the easy page.
    */
   for (const pageNumber of table.pages) {
    const page = pages.find((p) => p.number === pageNumber);
    const grid = page && gridOf(page);
    if (!grid) {
      /*
       * Counted, not merely mentioned.
       *
       * A page that draws no column rules cannot be rebuilt from its rules —
       * and that is exactly where the extractor is weakest. Prot_111 draws
       * none at all, so every page of it was skipped and the run still signed
       * off with "0 discrepancy line(s) in all". A checker that gives a clean
       * bill to a document it never opened is worse than no checker, because
       * it is believed.
       */
      skipped.push(`${title} p${pageNumber}`);
      console.log(`\n${title} ${table.id} p${pageNumber}: NOT CHECKED — the page draws no column rules to rebuild`);
      continue;
    }

    console.log(`\n${'='.repeat(74)}\n${title} ${table.id} — page ${pageNumber} as printed vs as extracted`);

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

    /*
     * One printed column to one of ours, and never the same one twice.
     *
     * The "already taken" test used to read `!mineHere[i]`, where `i` indexes
     * table.columns and mineHere is indexed by printed position — two different
     * spaces, so it never excluded anything. One of our columns could be paired
     * with every printed column at once, which is how a fifteen-visit page came
     * to report every cell against a column called "9".
     */
    /*
     * Paired by WHAT EACH COLUMN CONTAINS, with the heading only as a tiebreak.
     *
     * Headings were tried first and are not up to it: they repeat ("Clinical
     * review" four times), abbreviate differently on a continuation page, and
     * collapse to a bare number that matches anything it appears inside. Exact
     * matching left fourteen columns of one page unpaired and therefore
     * unchecked, which is the same blindness in a politer form.
     *
     * A column's real identity on a page is the set of assessments marked in
     * it. Two visits almost never carry the same set, the set survives any
     * disagreement about headings, and — the point of the whole exercise — a
     * single cell in the wrong column shifts one member of a set of many, so
     * the best-overlap pairing still lands and the stray cell is left over as
     * the report.
     */
    const rowsOnPage = grid.matrix
      .map((r) => ({ row: ours.get(key(r.slice(0, labelCols).filter(Boolean).join(' '))), cells: r }))
      .filter((r) => r.row);
    const printFinger = new Map(drawn.map((c) =>
      [c, new Set(rowsOnPage.filter((r) => r.cells[c]).map((r) => r.row.id))]));
    const mineFinger = new Map(table.columns.map((col) =>
      [col.id, new Set(rowsOnPage.filter((r) => r.row.cells.some((x) => x.col === col.id)).map((r) => r.row.id))]));

    const scores = [];
    for (const c of drawn) {
      for (const col of table.columns) {
        const a = printFinger.get(c);
        const b = mineFinger.get(col.id);
        if (!a.size && !b.size) continue;
        const shared = [...a].filter((id) => b.has(id)).length;
        const union = new Set([...a, ...b]).size;
        // The heading breaks a tie between two visits marked identically; it
        // never makes a pairing on its own.
        // An exact heading match is strong evidence, not a nudge, and it must
        // count for a heading one character long: protocol9 heads its columns
        // "1" through "11", the day rows are what tell those apart, and
        // requiring two characters left every single-digit day to be paired on
        // the strength of its marks alone — which put the column headed "3"
        // against our Day 4, and five more behind it.
        const says = [col.label, col.studyDay, col.studyWeek, col.visitNumber, ...(col.path || [])];
        const head = headOf(c);
        const agrees = says.some((v) => v && key(v) && head && key(v) === head);
        scores.push({ c, col, score: (union ? shared / union : 0) + (agrees ? 0.5 : 0) });
      }
    }
    scores.sort((p, q) => q.score - p.score);

    const mineHere = [];
    const taken = new Set();
    const usedPrinted = new Set();
    for (const { c, col, score } of scores) {
      if (score <= 0 || taken.has(col.id) || usedPrinted.has(c)) continue;
      mineHere[drawn.indexOf(c)] = col;
      taken.add(col.id);
      usedPrinted.add(c);
    }
    /*
     * A pairing that crosses is wrong, whatever it scored.
     *
     * Both tables read left to right and neither reorders its visits, so the
     * paired columns must ascend together. Greedy scoring does not know that:
     * on protocol9 every day carries a similar set of assessments, and the
     * pairing slipped by one — reporting the column headed "3" against our
     * "Day 4", and eight more like it, on a page we had read exactly right.
     *
     * The longest ascending run is kept and the rest let go, so a genuine
     * crossing costs a few columns their check rather than producing nine
     * confident reports about nothing.
     */
    const paired = drawn.map((c, i) => ({ i, at: table.columns.indexOf(mineHere[i]) }))
      .filter((p) => p.at >= 0);
    const best = [];
    for (const p of paired) {
      let run = [p];
      for (const q of best) if (q[q.length - 1].at < p.at && q.length + 1 > run.length) run = [...q, p];
      best.push(run);
    }
    const keep = new Set((best.sort((a, b) => b.length - a.length)[0] || []).map((p) => p.i));
    drawn.forEach((c, i) => {
      if (mineHere[i] && !keep.has(i)) { mineHere[i] = undefined; usedPrinted.delete(c); }
    });

    const unmatched = drawn.filter((c) => !usedPrinted.has(c));
    unchecked.push(...unmatched.map((c) => `${title} p${pageNumber} "${headerRows.map((r) => r[c]).filter(Boolean).join(' ').slice(0, 24) || '(no heading)'}"`));
    if (process.env.DBG) for (const c of unmatched) console.error();
    if (unmatched.length) {
      console.log(`  · ${unmatched.length} drawn column(s) could not be paired to one of ours — not checked`);
    }

    const printed = grid.matrix.filter((r) => r.slice(0, labelCols).some(Boolean));

    /*
     * Is this page's grid even this table's?
     *
     * A table lists the pages its footnotes spill onto as well as the pages it
     * is printed on, and protocol5's footnotes spill onto the page where its
     * blood-collection appendix begins. Audited against that page, the main
     * schedule was told it had lost every row of a different table. If almost
     * none of what is printed here belongs to this table, the grid is somebody
     * else's and there is nothing to compare.
     */
    const another = doc.tables.find((t) => t !== table && t.pages[0] === pageNumber);
    if (another) {
      console.log(`  · ${another.id} starts on this page, so the grid here is its — not compared`);
      continue;
    }

    let missing = 0;
    let misplaced = 0;
    for (const row of printed) {
      const label = row.slice(0, labelCols).filter(Boolean).join(' ');
      /*
       * The same row, with its superscript kept out of its name.
       *
       * protocol15 prints "Physical exam/FEV<d> 1" and we store the name as
       * "Physical exam/FEV1" with "d" recorded as a marker, which is the point
       * of keeping markers beside values rather than glued into them. Matched
       * on the raw text, that row reported itself as missing from a table that
       * holds it and has footnote d pointing straight at it.
       */
      const mine = ours.get(key(label)) || ours.get(key(label.replace(/\b[a-z]\b/gi, ' ')));
      if (!mine) {
        if (grid.matrix.indexOf(row) < firstData) continue;
        /*
         * Matched on the words, in any order, ignoring bullets.
         *
         * A row's name is one thing; how a reading writes it down is another.
         * protocol9 bullets every assessment on its continuation pages and
         * wraps "(15)" onto a second line, so exact and prefix matching called
         * ten rows missing that are plainly present. An audit that cries wolf
         * on formatting hides the losses it exists to find.
         */
        const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);
        const want = words(label);
        const near = want.size < 2 || [...ours.values()].some((r) => {
          const have = words(r.label);
          const shared = [...want].filter((w) => have.has(w)).length;
          return shared >= Math.min(want.size, have.size) * 0.7;
        });
        /*
         * A footnote legend under the table is not a row of it.
         *
         * The reconstruction knows only about ruled cells, and a sponsor rules
         * the block under the grid the same way — so "a. b. c. d. e. 6th
         * administration…", "X a X b X c X d – FEV 1" and "a S = serum, P =
         * plasma" were each reported as a row we had lost. They are the
         * footnotes, and they are checked as footnotes further down.
         */
        const legend = /^\s*[a-z*†‡§¶#]{1,3}\s*[.):=-]/i.test(label)
          || /^\s*(?:x\s*[a-z]\s*){2,}/i.test(label)
          || (label.match(/=/g) || []).length >= 2;
        if (!near && !legend && key(label).length > 3) { console.log(`  ! ROW MISSING: "${label.slice(0, 52)}"`); missing++; problems++; }
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
      /*
       * Extra means INVENTED, not repeated.
       *
       * protocol9 writes "Prior to Day 4" once, in a cell merged across three
       * days, and we record it against each day it covers — which is the whole
       * point of recording it. Counting copies called that three words too
       * many, three times over. A word the page does not print at all is the
       * fault worth reporting; a word it prints once and we attach to each
       * column it is written over is not.
       */
      const extra = [...got].filter(([v]) => !wanted.has(v)).map(([v, n]) => `${v}×${n}`);

      /*
       * WHERE a written-out value sits, not only that we hold it.
       *
       * The multiset above is blind to placement on purpose, and that blindness
       * had a cost: protocol15 prints "Weekly x 2 weeks" under Baseline for
       * five assessments, the published output filed all five under Screening,
       * and every run of this audit passed because the values were all present.
       *
       * A phrase is not an X. It appears once on its row, so which column holds
       * it is unambiguous — and wherever the heading pairing above found a
       * partner for the printed column, the two can simply be compared. That is
       * the whole check, and it is deliberately limited to phrases: comparing
       * marks cell by cell is what produced forty false reports twice before.
       */
      for (const c of drawn) {
        const value = norm(row[c] || '');
        if (!/[a-z]{3}/i.test(value)) continue;
        const should = mineHere[drawn.indexOf(c)];
        if (!should) continue;
        // Every cell holding it, not the first: a value written ACROSS several
        // columns belongs to each of them, and matching only the first reported
        // protocol9's "Prior to Day 4" as misplaced in two of the three days it
        // is written over.
        const held = mine.cells.filter((x) => norm(x.value) === value);
        if (!held.length || held.some((x) => x.col === should.id)) continue;
        const at = table.columns.find((col) => col.id === held[0].col);
        console.log(`  ! "${label.slice(0, 28)}" — "${value.slice(0, 24)}" is printed under `
          + `"${should.label}" but filed under "${at ? at.label : held.col}"`);
        problems++;
      }

      /*
       * And now every cell, mark or not, in the column the page prints it in.
       *
       * This is the check the audit refused to make, and the reason it refused
       * no longer holds. Comparing cell by cell failed twice because the two
       * grids were aligned by POSITION, and a narrow divider rule dropping out
       * of the reconstruction slid everything after it by one column — forty
       * reports, all of them the audit's own fault. Pairing each printed column
       * to ours by the text at its head, which is what a person does, removes
       * that failure entirely: a dropped edge no longer shifts anything,
       * because nothing is being counted along a row.
       *
       * Unpaired columns are skipped and already reported as unchecked, so this
       * only ever speaks where it has a partner it is sure of.
       */
      for (const c of drawn) {
        const should = mineHere[drawn.indexOf(c)];
        if (!should) continue;
        const printedHere = norm(row[c] || '');
        // Markers count as printed content. The page sets an "X" with a
        // superscript "b" beside it and we keep the two apart deliberately, so
        // comparing the value alone reports a difference that is only our own
        // way of storing it.
        const oursHere = mine.cells.filter((x) => x.col === should.id)
          .map((x) => norm([x.value, ...(x.markers || [])].join(' '))).join(' ');
        if (!printedHere && !oursHere) continue;
        // A value written across columns is printed once and held in each of
        // them, so containment either way counts as agreement.
        /*
         * The same tokens, in whatever order.
         *
         * A cell holding "X" with a superscript "b" can be printed b-then-X or
         * X-then-b depending on where the superscript's baseline falls, and we
         * store the marker after the value regardless. Comparing the strings
         * made "a x" and "x a" a discrepancy — six of them, all of them the
         * same cell read correctly.
         */
        const bag = (s) => s.split(' ').filter(Boolean).map(key).filter(Boolean).sort();
        const inside = (a, b) => {
          const rest = [...b];
          return a.every((t) => {
            const at = rest.indexOf(t);
            if (at < 0) return false;
            rest.splice(at, 1);
            return true;
          });
        };
        const mineBag = bag(oursHere);
        const pageBag = bag(printedHere);
        const agrees = printedHere && oursHere
          && (inside(mineBag, pageBag) || inside(pageBag, mineBag));
        /*
         * A value written across merged cells is printed once and covers many.
         *
         * protocol9 prints "Prior to Day 4" in a cell spanning days 1 to 3. The
         * reconstruction finds text in one of those three and nothing in the
         * other two, and we hold it in all three — correctly, because a reader
         * asking about day 2 must not have to know the answer was printed over
         * day 1. So a value we hold where the page rules an empty cell is no
         * fault if the same value is printed elsewhere on the same row.
         */
        /*
         * A bare marker letter on its own is not comparable.
         *
         * A superscript is set above the baseline of the mark it qualifies, and
         * where that mark sits at the top of its row the superscript crosses
         * the rule into the row above. protocol15 prints "Vital signs" with an
         * X in six columns, each carrying a "b" that lands in the band of
         * "Physical exam/FEV" over it — reported as six marks missing from a
         * row the page marks twice. The mark itself is always in the right
         * band, so nothing that matters is waved through here.
         */
        if (!mineBag.length && pageBag.length && pageBag.every((t) => t.length === 1)) continue;

        const spanned = !printedHere && oursHere
          && drawn.some((other) => other !== c && inside(bag(norm(row[other] || '')), mineBag)
            && bag(norm(row[other] || '')).length);
        if (spanned) continue;
        if (agrees) continue;
        if (!printedHere && !/[a-z]{3}/i.test(oursHere) && oursHere.length <= 2) {
          // A lone mark we hold where the page rules an empty cell. Reported,
          // but as its own kind of fault so it cannot hide among the rest.
          console.log(`  ! "${label.slice(0, 28)}" — "${oursHere}" under "${should.label}", which the page leaves empty`);
        } else if (!oursHere) {
          console.log(`  ! "${label.slice(0, 28)}" — nothing under "${should.label}", where the page prints "${printedHere.slice(0, 24)}"`);
        } else {
          console.log(`  ! "${label.slice(0, 28)}" — under "${should.label}" the page prints "${printedHere.slice(0, 20)}" and we hold "${oursHere.slice(0, 20)}"`);
        }
        problems++;
      }

      if (lost.length || extra.length) {
        console.log(`  ! "${label.slice(0, 34)}"`
          + (lost.length ? `  MISSING ${lost.join(' ')}` : '')
          + (extra.length ? `  EXTRA ${extra.join(' ')}` : ''));
        misplaced++;
        problems++;
      }
    }
    console.log(`  ${printed.length} printed rows checked · ${missing} missing · ${misplaced} cell mismatches`);

    /*
     * The header, against what is printed above the grid.
     *
     * Rows and cells were checked and headers were not, which is how a schedule
     * came to be banded "Screening Period" over five visits where the page rules
     * it over two, and how visit names ended up filed as visit windows — both
     * found by eye, late, because nothing was looking.
     */
    let headerFaults = 0;
    drawn.forEach((c, i) => {
      const col = mineHere[i];
      if (!col) return;
      const head = headOf(c);
      if (!head) return;
      const said = [col.label, col.studyDay, col.studyWeek, col.visitNumber, col.window, ...(col.path || [])]
        .filter(Boolean).map(key).filter((v) => v.length > 1);
      // Everything printed in this column's header should be somewhere in what
      // we say about the column; anything else is a heading we did not read.
      // Or the whole of what we say, joined. A visit headed "1 / -2" has a
      // label and a week that are each one character long, and testing them
      // one at a time discarded both as too short to be distinctive — so a
      // column we had read perfectly reported itself as unaccounted for.
      const whole = key([col.label, col.studyDay, col.studyWeek, col.visitNumber, col.window, ...(col.path || [])].filter(Boolean).join(" "));
      const covered = said.some((v) => head.includes(v) || v.includes(head))
        || (whole.length > 1 && (head.includes(whole) || whole.includes(head)));
      if (!covered) {
        console.log(`  ! HEADER column ${i + 1}: page="${headerRows.map((r) => r[c]).filter(Boolean).join(' / ').slice(0, 34)}"`
          + ` ours="${[col.label, col.studyDay, col.studyWeek].filter(Boolean).join(' / ').slice(0, 34)}"`);
        headerFaults++;
        problems++;
      }
    });
    if (headerRows.length) console.log(`  ${drawn.length} column headings checked · ${headerFaults} not accounted for`);
   }

   /*
    * Footnote text, against the page it is printed on.
    *
    * The brief grades the full text of every footnote, and nothing here was
    * comparing it — a footnote truncated at a line break, or one that stops at
    * a page boundary, would have gone unnoticed exactly as the brief warns.
    */
   const onPages = table.pages
     .flatMap((n) => (pages.find((p) => p.number === n)?.lines || []).map((l) => norm(l.text)))
     .join(' ');
   let cut = 0;
   for (const footnote of table.footnotes || []) {
     const text = norm(footnote.text);
     if (text.length < 8) continue;
     /*
      * Compared with the spaces taken out, then on words.
      *
      * The page breaks a footnote wherever the column ends and puts a space
      * there; it also sets "FEV1" as "FEV" and a small "1", which reads back
      * with a space between. Ours joins it, correctly, and a word-by-word
      * comparison then called a footnote that is verbatim on the page missing.
      */
     const flat = (s) => s.replace(/[^a-z0-9]+/g, '');
     if (flat(onPages).includes(flat(text))) continue;
     const words = text.split(' ').filter((w) => w.length > 2);
     const found = words.filter((w) => onPages.includes(w) || flat(onPages).includes(flat(w))).length;
     if (found < words.length * 0.9) {
       console.log(`  ! FOOTNOTE "${footnote.printed || footnote.marker}": ${words.length - found} of ${words.length} words are not on the table's pages`);
       cut++;
       problems++;
     }
   }
   console.log(`  ${(table.footnotes || []).length} footnotes checked against the page · ${cut} with text not found there`);
  }
}
console.log(`\n${problems} discrepancy line(s) in all.`);
if (unchecked.length) {
  console.log(`
${unchecked.length} drawn column(s) had no counterpart in our table, so their cells went unchecked:`);
  for (const u of unchecked) console.log(`  · ${u}`);
}
if (skipped.length) {
  console.log(`\n${skipped.length} page(s) could NOT be checked, having no ruled grid to rebuild: ${skipped.join(', ')}.`);
  console.log('Nothing above vouches for those. On a document whose pages are all listed here,');
  console.log('a count of zero means nothing was compared — not that nothing is wrong.');
}
