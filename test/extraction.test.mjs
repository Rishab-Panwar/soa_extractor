/*
 * What each protocol must still read as.
 *
 * Every number here was checked against the printed page before it was written
 * down. They are pinned because almost every defect found while building this
 * was a regression: a rule added for one document quietly took a row or a
 * column away from another, and nothing said so. Reading the output of the one
 * document you are working on cannot tell you that — an empty cell looks
 * exactly like a cell the protocol left empty, and a row that is gone leaves no
 * trace at all.
 *
 * The protocols are not redistributable, so these skip rather than fail when
 * the PDFs are not beside the project. `npm test` is then still meaningful for
 * anyone who has them, and honest for anyone who does not.
 */

import { test, skip } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { run } from '../src/pipeline.js';

const at = (name) => fileURLToPath(new URL(`../../takehome-1b/takehome-1b/${name}.pdf`, import.meta.url));
const own = fileURLToPath(new URL('../Prot_000.pdf', import.meta.url));

/**
 * The rule-based reading, with no model involved.
 *
 * Pinning the geometry rather than the published output is deliberate: a review
 * is not deterministic, so a test over it would fail for reasons that are not
 * defects. The geometry is what the rules do, and the rules are what regress.
 */
/*
 * `unnamed` and `unlabelled` are pinned at zero on every protocol, which they
 * reach only since the grid is read from the lines the page draws. They were
 * not zero before and the pins were honest about that; they are kept in the
 * table so the day a column or a row loses its name again, the suite says so.
 */
const EXPECTED = [
  { name: 'protocol1', file: at('protocol1'), columns: 14, rows: 28, cells: 139, unnamed: 0, unlabelled: 0,
    why: 'a header captioned "ACTIVITY WEEK", and "Adverse events" as its last row' },
  { name: 'protocol5', file: at('protocol5'), columns: 11, rows: 31, cells: 107, unnamed: 0, unlabelled: 0,
    why: 'a phase band captioned "Study Phase", wrapping down three lines' },
  { name: 'protocol9', file: at('protocol9'), columns: 11, rows: 32, cells: 168, unnamed: 0, unlabelled: 0,
    why: 'the table title set inside the activity column, bulleted rows, and a value written across columns' },
  { name: 'protocol12', file: at('protocol12'), columns: 9, rows: 39, cells: 132, unnamed: 0, unlabelled: 0,
    why: 'a word printed vertically between two phases' },
  { name: 'protocol15', file: at('protocol15'), columns: 9, rows: 33, cells: 128, unnamed: 0, unlabelled: 0,
    why: 'a cell value that wraps onto a second line' },
  // Eighteen, not the eleven the marks alone could find: seven of its visits
  // are ruled but sparse, and clustering marks could never see them.
  { name: 'Prot_000', file: own, columns: 18, rows: 29, cells: 141, unnamed: 0, unlabelled: 0,
    why: 'visits that are ruled but carry almost no marks' },
];

for (const expected of EXPECTED) {
  const it = existsSync(expected.file) ? test : skip;
  it(`${expected.name}: ${expected.why}`, async () => {
    const result = await run(readFileSync(expected.file), { assist: false });
    const table = result.tables[0];
    assert.ok(table, 'no schedule was found at all');
    assert.equal(table.columns.length, expected.columns, 'column count');
    assert.equal(table.rows.length, expected.rows, 'row count');
    assert.equal(table.rows.reduce((n, r) => n + r.cells.length, 0), expected.cells, 'cell count');
    assert.equal(table.columns.filter((c) => /^column \d+$/i.test(c.label)).length, expected.unnamed, 'unnamed columns');
    assert.equal(table.rows.filter((r) => !String(r.label || '').trim()).length, expected.unlabelled, 'unlabelled rows');
  });
}

test('a value written across columns reaches every column it is written over', async (t) => {
  if (!existsSync(at('protocol9'))) return t.skip('protocol9.pdf not present');
  const result = await run(readFileSync(at('protocol9')), { assist: false });
  const table = result.tables[0];
  const spanning = table.rows.filter((r) => r.cells.some((c) => c.value === 'Prior to Day 4'));
  assert.equal(spanning.length, 3, 'three assessments carry it');

  // Checked by the days it reaches, not by how many cells it fills: the
  // rule-based pass splits day 3 into two bands on this page, so counting cells
  // would pin a defect instead of the fact that matters.
  const dayOf = new Map(table.columns.map((c) => [c.id, c.studyDay]));
  for (const row of spanning) {
    const days = new Set(row.cells.filter((c) => c.value === 'Prior to Day 4').map((c) => dayOf.get(c.col)));
    for (const day of ['1', '2', '3']) assert.ok(days.has(day), `${row.label} reaches day ${day}`);
  }
});

test('a word printed vertically loses its letters, not the visit beside it', async (t) => {
  if (!existsSync(at('protocol12')) || !existsSync(at('protocol15'))) return t.skip('protocols not present');
  /*
   * This test used to assert the opposite, and pinned a bug for weeks.
   *
   * Both documents rule a narrow column for the word they print down the
   * middle of the schedule, and no mark stacks inside it — so no band is built
   * there, and the nearest band to the word is the Treatment Week 1-3 column
   * beside it. That column was renamed "RANDOMIZATION", flagged a divider, and
   * had every one of its cells deleted. A whole visit of each schedule went
   * missing, the week row shifted with it, and this test called it correct
   * because a column labelled RANDOMIZATION did indeed exist.
   *
   * What has to be true is narrower: the letters must not become cells, and
   * the visit they were printed across must keep its marks.
   */
  for (const name of ['protocol12', 'protocol15']) {
    const table = (await run(readFileSync(at(name)), { assist: false })).tables[0];
    const letters = table.rows.flatMap((r) => r.cells.filter((c) => /^[A-QS-WYZ]$/i.test(c.value)));
    assert.equal(letters.length, 0, `${name}: none of its letters became cell values`);
    const week = table.columns.find((c) => /^1-3$/.test(String(c.studyWeek || '')));
    assert.ok(week, `${name}: the week 1-3 column is still a visit`);
    const marks = table.rows.flatMap((r) => r.cells.filter((c) => c.col === week.id));
    assert.ok(marks.length >= 10, `${name}: and it kept its marks (${marks.length})`);
  }
});

test('a name that wraps inside its row stays one row', async (t) => {
  if (!existsSync(at('protocol9'))) return t.skip('protocol9.pdf not present');
  const result = await run(readFileSync(at('protocol9')), { assist: false });
  const labels = result.tables[0].rows.map((r) => r.label);
  assert.ok(labels.includes('Informed Consent, Screening (01), Opiate Screening (02)'),
    'the wrapped assessment is one row, not two');
  assert.ok(!labels.includes('Opiate Screening (02)'), 'and its second line is not a row of its own');
});

test('rows the page rules apart stay apart', async (t) => {
  if (!existsSync(at('protocol1'))) return t.skip('protocol1.pdf not present');
  const result = await run(readFileSync(at('protocol1')), { assist: false });
  const labels = result.tables[0].rows.map((r) => r.label);
  // Four assessments in a row, three of them bracketed together on the page and
  // the fourth ruled off from them. Reading the lines ran all four into one.
  assert.ok(labels.includes('TTS Acceptability Survey'), 'not swallowed by the row above it');
  assert.ok(labels.includes('Adverse events'), 'nor is the row after that');
});

test('a page whose rules do not account for every mark is not read from them', async (t) => {
  if (!existsSync(at('protocol9'))) return t.skip('protocol9 not present');
  // The gate that keeps a better source of structure from becoming a worse
  // answer: a ruled reading is adopted only if it accounts for every mark the
  // inferred one found. protocol9 is ruled throughout and says so.
  //
  // This used to be tested against protocol5, whose page 51 was said to
  // "lose two marks" and fall back. It did not lose them — a plain underline
  // fifty points below the table's own border, drawn under a footnote note,
  // was being read as one more row, and the sponsor's running footer under
  // it supplied the two "marks" ("-", "51") the ruled reading correctly
  // never produced. Once that stray rule is excluded rather than mistaken
  // for a row divider, protocol5's own schedule is ruled throughout too, and
  // there is no longer a real case among these documents where the guard
  // has something to refuse.
  const nine = await run(readFileSync(at('protocol9')), { assist: false });
  assert.equal(nine.tables[0].provenance.rowsAreRuled, true, 'protocol9 rows come from the rules');
});

test('a running footer is not one more row of the table above it', async (t) => {
  if (!existsSync(at('protocol5'))) return t.skip('protocol5 not present');
  const result = await run(readFileSync(at('protocol5')), { assist: false });
  const [t1, t2] = result.tables;
  assert.equal(t1.provenance.rowsAreRuled, true, 'the main schedule is ruled throughout');
  assert.ok(!t1.ambiguities.some((a) => /ruled row boundaries/.test(a)), 'and needs no fallback notice');

  // The blood-collection appendix on the same page: its own rows, not a
  // phantom one made of the sponsor's running footer and legend line.
  assert.ok(t2, 'the appendix is returned as its own table');
  assert.equal(t2.title, 'APPENDIX II: Schedule of Blood Collections');
  const labels = t2.rows.map((r) => r.label);
  assert.ok(!labels.includes('a'), 'the legend line is not a row named "a"');
  assert.ok(!labels.some((l) => /^-?$/.test(l) || /NIDA-CPU|Interaction Study/.test(l)), 'nor the page footer');
  // The two-line header names every column: "Type a" and "Total Volume" are
  // each their own leaf column, and the twelve day columns sit under one
  // banding heading ("Number of Samples per Day b") — which the label
  // carries verbatim, same as the page prints it, while studyDay carries
  // each column's own day so a reader (or the UI's own facts row) still
  // gets "Screening", "D-8", "D1" … distinctly per column.
  assert.equal(t2.columns[0].label, 'Volume Per Sample');
  assert.equal(t2.columns[1].label, 'Type a');
  assert.equal(t2.columns[t2.columns.length - 1].label, 'Total Volume');
  assert.deepEqual(
    t2.columns.slice(2, -1).map((c) => c.studyDay),
    ['Screening', 'D-8', 'D-1', 'D1', 'D2', 'D3', 'D6', 'D8', 'D11', 'D13', 'D17', 'D31'],
    'each day column keeps its own day, even where the label above it is one heading shared by all twelve',
  );
  assert.ok(t2.footnotes.some((f) => f.marker === 'a' && /serum/.test(f.text)), 'the legend is read as a footnote');
  assert.ok(t2.footnotes.some((f) => /b D = day/.test(f.text)), 'and the second definition on the same line with it');
});

test('a footnote marker is kept beside its value, not glued onto it', async (t) => {
  if (!existsSync(at('protocol12'))) return t.skip('protocol12.pdf not present');
  const result = await run(readFileSync(at('protocol12')), { assist: false });
  const cells = result.tables[0].rows.flatMap((r) => r.cells);
  assert.ok(cells.some((c) => c.value === '3X/week' && (c.markers || []).includes('d')), '"3X/week" with marker d');
  assert.equal(cells.filter((c) => /^\d?X?\/?week[a-z]$/i.test(c.value)).length, 0, 'no marker glued into a value');
});

test('a phase heading bands exactly the columns its cell encloses', async (t) => {
  if (!existsSync(own)) return t.skip('Prot_000.pdf not present');
  // The page rules "Screening Period" over two visits and "Treatment Period"
  // over thirteen. Inferring the span from where the heading's ink falls read
  // it as five and seven — a heading centred over its group reaches columns it
  // does not cover, and the document draws the answer.
  const result = await run(readFileSync(own), { assist: false });
  const runs = [];
  for (const column of result.tables[0].columns) {
    const phase = column.path[column.path.length - 1];
    const last = runs[runs.length - 1];
    if (last && last.phase === phase) last.n++;
    else runs.push({ phase, n: 1 });
  }
  assert.deepEqual(runs.map((r) => `${r.phase}×${r.n}`), [
    'Run-in×1', 'Screening Period×2', 'Treatment Period×13', 'Follow-up Period×2',
  ]);
});

test('lines inside one ruled header cell are one header row', async (t) => {
  if (!existsSync(own)) return t.skip('Prot_000.pdf not present');
  // The page sets each visit as "Visit 0" over "Stabilization", and puts the
  // caption "Visits" on the SECOND line. Read line by line, the first has no
  // caption and is taken as the wrap of the window row above it — so "Visit 0"
  // and "Visit 1.1" were filed as visit windows and the row naming the visits
  // described nothing.
  const result = await run(readFileSync(own), { assist: false });
  const table = result.tables[0];
  assert.equal(table.columns[0].label, 'Visit 0 Stabilization');
  assert.equal(table.columns[17].label, 'V 9 (Safety Follow-up Visit)');
  assert.deepEqual(table.columns.slice(4, 8).map((c) => c.label), ['V 2.1', 'V 2.2', 'V2.3', 'V 3']);
  // And no visit identifier ended up filed as a visit window.
  assert.equal(table.columns.filter((c) => /visit/i.test(c.window || '')).length, 0);
});

test('the numbered narrative after a schedule is not read as footnotes', async (t) => {
  if (!existsSync(at('protocol12')) || !existsSync(at('protocol5'))) return t.skip('protocols not present');
  // Both documents set a numbered list of prose immediately after the
  // schedule, and both had it read as footnotes 1..6 — thousands of characters
  // about eligibility filed under a table that never refers to them. A footnote
  // marker has to be one the grid prints, or take the next place in the block's
  // own sequence; "1." after "j" does neither, and once it is refused its "2."
  // has nothing to continue either.
  for (const name of ['protocol12', 'protocol5']) {
    const result = await run(readFileSync(at(name)), { assist: false });
    const numbered = result.tables[0].footnotes.filter((f) => /^\d+$/.test(f.marker));
    assert.deepEqual(numbered.map((f) => f.marker), [], `${name} invents no numbered footnotes`);
  }
  // And the last real one stops where the prose starts, instead of absorbing it.
  const twelve = await run(readFileSync(at('protocol12')), { assist: false });
  const last = twelve.tables[0].footnotes.find((f) => f.marker === 'J');
  assert.ok(last, 'footnote J is still read');
  assert.ok(!/eligibility requirements/.test(last.text), 'and it does not swallow the paragraph after it');
});

test('a legend marker the grid writes as a whole cell is read', async (t) => {
  if (!existsSync(at('protocol1'))) return t.skip('protocol1.pdf not present');
  // protocol1 writes "P" into four cells and defines "P = Practice only" under
  // the table. Nothing trails anything — the marker IS the cell — so the
  // patterns that find "Xa" and "examination d" cannot see it, and the legend
  // it belongs to was being appended to the footnote above it instead.
  const result = await run(readFileSync(at('protocol1')), { assist: false });
  const legend = result.tables[0].footnotes.find((f) => f.marker === 'P');
  assert.ok(legend, 'the P legend is read as its own footnote');
  assert.match(legend.text, /^Practice only/);
});
