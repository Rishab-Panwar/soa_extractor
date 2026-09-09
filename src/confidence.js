/*
 * confidence.js — how much of this extraction should anyone believe?
 *
 * A tool that is sometimes wrong is usable. A tool that is sometimes wrong and
 * always sounds certain is not, because every result then has to be checked by
 * hand, which is the work the tool was supposed to save.
 *
 * So the geometric extractor is scored against itself. Every check here is a
 * property the FINISHED table must have if it was read correctly, and each is
 * computable without the source document — no ground truth, no model, no human.
 * They are deliberately blunt: the purpose is not to grade the output finely,
 * it is to separate "trust this" from "look at this yourself", and later to
 * decide which pages are worth spending a vision call on.
 *
 * The checks come from the failures this pipeline actually had, not from
 * imagination. Each names the protocol that produced it.
 */

const pct = (n) => Math.round(n * 100);

/**
 * Signals that something is wrong with a table, worst first.
 *
 * Each returns null when it is satisfied, or a finding when it is not. A
 * finding carries `cost` — how much confidence it removes — and `pages`, so a
 * fallback can be spent on the pages that need it rather than the whole table.
 */
const CHECKS = [
  /**
   * Columns that say nothing about when they happen.
   *
   * A visit column carries a number, a day, a week or a short name. A column
   * identified only by prose, or by nothing, cannot be matched against the same
   * visit printed on another page — which is how protocol9's eleven study days
   * became thirty columns. This is the single most reliable signal that the
   * column axis is wrong.
   */
  function unidentifiedColumns(table) {
    const identified = (c) => Boolean(
      c.visitNumber || c.studyDay || c.studyWeek || c.window
      || (c.label && c.label.length <= 14 && !/^column\s*\d+$/i.test(c.label)),
    );
    const anonymous = table.columns.filter((c) => !identified(c));
    if (!anonymous.length) return null;
    const share = anonymous.length / table.columns.length;
    return {
      check: 'unidentified-columns',
      severity: share > 0.4 ? 'high' : 'low',
      cost: Math.min(0.55, share * 0.8),
      pages: [...new Set(anonymous.map((c) => c.page))],
      detail: `${anonymous.length} of ${table.columns.length} columns (${pct(share)}%) carry no visit number, `
        + 'study day, week or window. Columns like these cannot be recognised as the same visit on '
        + 'another page, so a schedule spanning pages may be listing the same visits more than once.',
    };
  },

  /**
   * Pages of one table that disagree about how many columns there are.
   *
   * A schedule has one column axis. If page 26 finds fourteen columns, page 27
   * finds five and page 28 finds eleven, at most one of them is right.
   */
  function columnCountDisagrees(table) {
    const perPage = new Map();
    for (const c of table.columns) perPage.set(c.page, (perPage.get(c.page) || 0) + 1);
    if (perPage.size < 2) return null;
    const counts = [...perPage.values()];
    const most = Math.max(...counts);
    const fewest = Math.min(...counts);
    if (most - fewest <= 1) return null;
    return {
      check: 'column-count-disagrees',
      severity: most >= fewest * 2 ? 'high' : 'low',
      cost: Math.min(0.4, (most - fewest) / most * 0.6),
      pages: [...perPage.keys()],
      detail: `pages of this table produced different numbers of columns (${[...perPage.entries()]
        .map(([p, n]) => `p${p}: ${n}`).join(', ')}). A schedule has one column axis, so these `
        + 'pages have not been reconciled and at most one of them is right.',
    };
  },

  /**
   * Two columns holding exactly the same marks all the way down.
   *
   * Real visits differ somewhere. Two columns with an identical, non-empty cell
   * pattern are almost always one visit counted twice — the same page's columns
   * appended instead of merged.
   */
  function duplicateColumns(table) {
    const pattern = new Map();
    for (const column of table.columns) pattern.set(column.id, []);
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (pattern.has(cell.col)) pattern.get(cell.col).push(`${row.id}=${cell.value}`);
      }
    }
    const seen = new Map();
    const pairs = [];
    for (const [id, marks] of pattern) {
      if (marks.length < 6) continue;
      const key = marks.join('|');
      if (seen.has(key)) pairs.push([seen.get(key), id]);
      else seen.set(key, id);
    }
    if (!pairs.length) return null;
    // Two visits CAN legitimately share an assessment set — week 4 and week 6
    // of the same treatment period often do, and protocol1 does exactly that
    // with every column correctly identified. What is suspicious is a duplicate
    // where at least one side could not be identified, because that is the
    // shape of a column that failed to merge rather than a visit that resembles
    // another one.
    const byId = new Map(table.columns.map((c) => [c.id, c]));
    const named = (id) => {
      const c = byId.get(id);
      return Boolean(c && (c.visitNumber || c.studyDay || c.studyWeek || c.window
        || (c.label && c.label.length <= 14 && !/^column\s*\d+$/i.test(c.label))));
    };
    const suspicious = pairs.filter(([a, b]) => !named(a) || !named(b));
    return {
      check: 'duplicate-columns',
      severity: suspicious.length ? 'high' : 'low',
      cost: Math.min(0.4, pairs.length * 0.15),
      pages: [...new Set(table.columns.filter((c) => pairs.flat().includes(c.id)).map((c) => c.page))],
      detail: `${pairs.length} pair(s) of columns hold an identical set of marks `
        + `(${pairs.map(([a, b]) => `${a}≡${b}`).join(', ')}). Real visits differ somewhere, so these are `
        + 'very likely one visit reported twice.',
    };
  },

  /**
   * Rows with marks but no label.
   *
   * Every assessment has a name. A row of marks with nothing on the left came
   * from text that was not part of the grid — a footnote paragraph, a page
   * footer — being read as a row.
   */
  function unlabelledRows(table) {
    const nameless = table.rows.filter((r) => r.cells.length && !String(r.label || '').trim());
    if (!nameless.length) return null;
    const share = nameless.length / Math.max(table.rows.length, 1);
    return {
      check: 'unlabelled-rows',
      severity: share > 0.15 ? 'high' : 'low',
      cost: Math.min(0.3, share * 1.5),
      pages: table.pages,
      detail: `${nameless.length} row(s) carry marks but no activity name. Every assessment has a name, `
        + 'so these are very likely prose or page furniture read as table rows.',
    };
  },

  /**
   * A footnote marker nobody uses.
   *
   * Markers and definitions come in pairs. A definition whose marker appears
   * nowhere in the grid was either mis-parsed out of a wrapped line, or its
   * linkage was missed — and the brief grades linkage.
   */
  function unlinkedFootnotes(table) {
    const unlinked = table.footnotes.filter(
      (f) => !f.appliesTo || f.appliesTo.every((t) => t.target === 'table'),
    );
    if (unlinked.length < 2) return null;
    const share = unlinked.length / table.footnotes.length;
    if (share < 0.5) return null;
    return {
      check: 'unlinked-footnotes',
      severity: share >= 0.55 ? 'high' : 'low',
      cost: Math.min(0.35, share * 0.45),
      pages: [...new Set(unlinked.map((f) => f.page))],
      detail: `${unlinked.length} of ${table.footnotes.length} footnotes are not linked to any cell, row `
        + 'or column. Either their markers were missed in the grid, or lines of prose were read as '
        + 'footnote definitions.',
    };
  },

  /**
   * A grid with almost nothing in it.
   *
   * A schedule is mostly marks. A table whose cells are very sparse relative to
   * its size usually means the column bands are wrong and most marks fell
   * outside all of them.
   */
  function sparseGrid(table) {
    const cells = table.rows.reduce((n, r) => n + r.cells.length, 0);
    const assessments = table.rows.filter((r) => r.kind !== 'category').length;
    const capacity = assessments * table.columns.length;
    if (!capacity) return null;
    const fill = cells / capacity;
    if (fill >= 0.08) return null;
    return {
      check: 'sparse-grid',
      severity: 'low',
      cost: 0.2,
      pages: table.pages,
      detail: `only ${pct(fill)}% of the grid is filled (${cells} cells across ${assessments} assessments `
        + `× ${table.columns.length} columns). Marks may be falling outside the detected columns.`,
    };
  },
];

/**
 * Score one table and say what to do about it.
 *
 * `verdict` is the operative part: `trust` means the geometric read is
 * self-consistent and cheap to accept; `check` means show it to a person;
 * `fallback` means this is where a second opinion — a vision model on these
 * pages — would be worth its cost. Nothing here calls one; it decides whether
 * one is warranted, so the decision is auditable on its own.
 */
export function assess(table) {
  const findings = [];
  for (const check of CHECKS) {
    const finding = check(table);
    if (finding) findings.push(finding);
  }

  const score = findings.reduce((s, f) => s * (1 - f.cost), 1);
  const confidence = Math.max(0, Math.round(score * 100) / 100);
  const high = findings.filter((f) => f.severity === 'high');

  const verdict = high.length ? 'fallback' : findings.length ? 'check' : 'trust';
  const pages = [...new Set(high.flatMap((f) => f.pages))].sort((a, b) => a - b);

  return {
    confidence,
    verdict,
    // The pages a second opinion should be spent on — not the whole document.
    fallbackPages: verdict === 'fallback' ? pages : [],
    findings,
  };
}

/** One line a person can read without opening the JSON. */
export function summarise(assessment) {
  if (assessment.verdict === 'trust') return `confidence ${assessment.confidence} — self-checks passed`;
  const worst = assessment.findings[0];
  return `confidence ${assessment.confidence} — ${assessment.verdict}: ${worst.check}`;
}
