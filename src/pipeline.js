/*
 * pipeline.js — document in, schedules out.
 *
 * The one place that knows the whole sequence, so the CLI and the web UI cannot
 * drift apart: whatever you see in the browser is what the batch script wrote.
 */

import { readPdf } from './ingest.js';
import { locate } from './locate.js';
import { extractTable } from './extract.js';
import { assess } from './confidence.js';
import { available, secondOpinion } from './assist.js';
import { normalise } from './schema.js';

/** The heading a page carries, if it names the table. */
function titleOn(page) {
  const TITLE = /(schedule of (activities|assessments|events|procedures|measures|evaluations|study procedures)|time (and|&) events|study flow ?chart|flow ?chart|table of events|visit schedule|study schedule|overview of study assessments)/i;
  for (const line of page.lines.slice(0, 12)) {
    if (TITLE.test(line.text) && line.text.length < 120) return line.text.trim();
  }
  return '';
}

/** What a column can be recognised by across two readings of the same page. */
const columnKeys = (c) => [c.visitNumber, c.studyDay, c.studyWeek, c.label]
  .map((v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ''))
  .filter((v) => v.length > 0);

/**
 * Facts the rule-based pass found, put back into a reviewed table.
 *
 * A review reads the page again and answers in its own words, and what it
 * leaves out is genuinely lost: on one protocol it returned every column named
 * by its study day and no visit names or study phases at all, so a schedule
 * whose header clearly reads "Pre-intake Screening / Intake Screening /
 * Treatment Infusions" rendered as three identical rows of day numbers. The
 * geometry had those headings the whole time.
 *
 * Nothing the review said is overwritten — only the blanks are filled, and only
 * from a column both readings agree is the same column.
 */
export function restoreHeader(reviewed, geometric) {
  let filled = 0;
  for (const column of reviewed.columns || []) {
    // A divider is a rule between phases. It has no visit number, no day and no
    // week, so every attempt to match it against a real column matches the
    // wrong one — and on a second pass it was handed its neighbour's heading,
    // losing the name the page prints down it.
    if (column.divider) continue;
    const keys = columnKeys(column);
    if (!keys.length) continue;
    // Never against the geometry's divider either: it is the only column whose
    // "name" is a word rather than a timepoint, so a reviewed column with no
    // timepoint of its own matches it readily and inherits "RANDOMIZATION" as
    // the phase it sits under.
    const match = (geometric.columns || [])
      .find((g) => !g.divider && columnKeys(g).some((k) => keys.includes(k)));
    if (!match) continue;
    for (const fact of ['visitNumber', 'studyDay', 'studyWeek', 'window']) {
      if (!column[fact] && match[fact]) { column[fact] = match[fact]; filled++; }
    }
    // The grouping above the column. Which field the geometry put it in depends
    // on how the page captioned that row — "Study Phase" makes it a period and
    // it lands in `path`, an uncaptioned band lands in the column's own label —
    // so both are accepted here rather than only the tidy one.
    const path = Array.isArray(column.path) ? column.path : (column.period ? [column.period] : []);
    const banding = match.path?.length ? match.path
      : (match.label && !/^column \d+$/i.test(match.label) ? [match.label] : []);
    if (!path.length && banding.length) { column.path = [...banding]; filled++; }
    // A column whose "name" is just its own study day has not been named at
    // all, and the phase it sits under is the only name the page gives it.
    const key = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const unnamed = key(column.label) === key(column.studyDay) || key(column.label) === key(column.studyWeek);
    if (unnamed && column.path?.length) { column.label = column.path[column.path.length - 1]; filled++; }
  }
  return filled;
}

/**
 * One row the review read as two, put back together.
 *
 * protocol9 prints "Informed Consent, Screening (01), Opiate Screening (02)" as
 * one assessment wrapped over two lines. Read line by line it becomes two rows,
 * the second empty, and the schedule claims an assessment that never happens.
 *
 * This was tried once before against row labels the rule-based pass had guessed
 * at, and it fused two real assessments in protocol5 and two more in protocol9 —
 * the guessed labels were themselves over-merged, so the evidence was wrong. It
 * is only safe against labels taken from the drawn grid, where a row boundary is
 * a line the sponsor drew rather than a judgement about wrapping. Hence the
 * gate: no ruled rows, no rejoining.
 */
export function restoreRowSplits(reviewed, geometric) {
  // Either shape: the raw reading carries the flag directly, a published one
  // carries it in its provenance.
  if (!(geometric.rowsAreRuled ?? geometric.provenance?.rowsAreRuled)) return 0;
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const whole = new Set((geometric.rows || []).map((r) => key(r.label)).filter(Boolean));

  let merged = 0;
  for (let i = reviewed.rows.length - 1; i > 0; i--) {
    const row = reviewed.rows[i];
    const previous = reviewed.rows[i - 1];
    // Only an empty row can be the tail of another: a row with its own cells
    // has its own marks on the page and is its own row.
    if (row.cells.length || row.kind === 'category' || previous.kind === 'category') continue;
    if (!whole.has(key(`${previous.label} ${row.label}`))) continue;

    previous.label = `${previous.label} ${row.label}`.trim();
    previous.markers = [...new Set([...(previous.markers || []), ...(row.markers || [])])];
    reviewed.rows.splice(i, 1);
    merged++;
  }
  return merged;
}

/**
 * Doubts the review recorded that have since been settled.
 *
 * A review writes down what it could not work out, and those notes are shown to
 * the reader under "what it could not settle". They were written before the
 * header and the cells were re-read from the ruled grid — so protocol5 still
 * warned that its study phases were "best-effort guesses" that "may not exactly
 * match the intended phase boundaries" when they are now read off the lines the
 * page draws, and protocol9 still said "Prior to Day 4" could not be mapped to
 * a column when it sits in three. A stale doubt is worse than no doubt: it tells
 * a reader to discount an answer that is right.
 *
 * Only a note that says it FAILED at something, about a thing now present, is
 * retired. A note recording a real remaining limitation says no such thing and
 * stays. The count of what was retired is kept, because quietly deleting the
 * model's own reservations would be its own kind of dishonesty.
 */
export function retireSettledNotes(table) {
  const admitsDefeat = /could not|cannot|were discarded|was omitted|not captured|best-effort|may actually|no explicit|not confidently|guess|was excluded|were excluded|not included/i;

  const present = new Set();
  for (const row of table.rows || []) {
    if (row.label) present.add(String(row.label).toLowerCase());
    for (const cell of row.cells || []) if (/[a-z]{3}/i.test(cell.value)) present.add(String(cell.value).toLowerCase());
  }
  for (const column of table.columns || []) {
    for (const v of [column.label, ...(column.path || [])]) if (v) present.add(String(v).toLowerCase());
  }

  // A column the review named only by id — "no label was assignable for columns
  // c1-c5" — is settled when those columns now carry one.
  const named = new Map((table.columns || []).map((c) => [c.id.toLowerCase(),
    Boolean(c.label && !/^column \d+$/i.test(c.label)) || Boolean((c.path || []).length)]));

  const settled = [];
  table.ambiguities = (table.ambiguities || []).filter((note) => {
    if (!admitsDefeat.test(note)) return true;
    const said = note.toLowerCase();

    // Named outright, or named in the review's own words: it quotes a row it
    // thought might be two, and quotes it in an order the joined label does not
    // have, so an exact match never fires on the very note the join settled.
    const words = (s) => (s.match(/[a-z0-9]+/g) || []);
    const spoken = new Set(words(said));
    const byName = [...present].some((v) => {
      if (v.length > 3 && said.includes(v)) return true;
      const parts = words(v).filter((w) => w.length > 2);
      return parts.length >= 4 && parts.filter((w) => spoken.has(w)).length >= parts.length * 0.8;
    });
    const ids = said.match(/\bc\d+\b/g) || [];
    const byId = ids.length > 0 && ids.every((id) => named.get(id));
    if (!byName && !byId) return true;

    settled.push(note);
    return false;
  });

  if (settled.length) {
    table.ambiguities.push(`${settled.length} note(s) the review recorded as unresolved have since been settled by `
      + 'reading the ruled grid — the phase bands, spanning values and divider columns it was unsure of are in the '
      + 'output above — and are no longer listed here.');
  }
  return settled.length;
}

/**
 * Divider columns the review did not report.
 *
 * A review answers with the visits it can name, and "RANDOMIZATION" set on its
 * side between two phases is not a visit — so it comes back with the column
 * simply absent, and the schedule then shows no sign that the study randomises
 * anywhere. The geometry sees it, because it can see that a word is printed
 * down that part of the grid. It is inserted where the geometry has it, between
 * the same two neighbours.
 */
export function restoreDividers(reviewed, geometric) {
  let added = 0;
  const dividers = (geometric.columns || []).filter((c) => c.divider);

  // Whatever ended up in a divider comes out, however it got there. A value
  // written as words is given to every column its ink covers, and the column
  // beside a rule is close enough to catch a copy — so ten rows of protocol12
  // carried their value twice, once correctly and once under a line.
  for (const column of (reviewed.columns || []).filter((c) => c.divider)) {
    for (const row of reviewed.rows || []) row.cells = row.cells.filter((c) => c.col !== column.id);
  }
  for (const divider of dividers) {
    if ((reviewed.columns || []).some((c) => c.divider || c.label === divider.label)) continue;

    /*
     * Placed by counting, not by matching a neighbour.
     *
     * Anchoring on the column before it and matching that against the review
     * put protocol15's divider one place early, because the column before it
     * shares a study week with the one before that. Both readings list their
     * columns left to right, so the divider belongs after exactly as many real
     * columns as precede it in the geometry — which is a count, and cannot be
     * confused by two columns describing the same week.
     */
    const index = geometric.columns.indexOf(divider);
    const realBefore = geometric.columns.slice(0, index).filter((c) => !c.divider).length;
    let at = 0;
    let seen = 0;
    while (at < reviewed.columns.length && seen < realBefore) {
      if (!reviewed.columns[at].divider) seen++;
      at++;
    }
    if (seen < realBefore) continue;

    reviewed.columns.splice(at, 0, {
      id: `divider-${divider.label.toLowerCase().replace(/[^a-z0-9]+/g, '') || added}`,
      label: divider.label,
      path: divider.path || [],
      visitNumber: null, studyDay: null, studyWeek: null, window: null,
      markers: [], divider: true,
    });
    added++;
  }
  return added;
}

/**
 * Written-out values the review left behind, taken from the geometry.
 *
 * A review reads the page and answers in cells, and a value written as words
 * across several columns does not fit that shape: asked about protocol9 it
 * returned three assessments with no cells at all and a note saying "Rows for
 * HIV, Psychiatric Assessment and ASI show text 'Prior to Day 4' rather than a
 * column mark; this could not be mapped". The geometry can map it, and an empty
 * cell in the output is indistinguishable from a visit where nothing happens.
 *
 * Only empty cells are filled, and only with values that are words — the marks
 * are the review's to place, and second-guessing those would trade a known
 * reading for a guess.
 */
export function restoreCells(reviewed, geometric) {
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  /*
   * A value that says something beyond "this happens".
   *
   * Three letters in a row was the test, and it quietly excluded "X wk 6" —
   * "wk" is two — so a cell naming the week an assessment falls in was never
   * treated as a value worth restoring. Abbreviated timing is exactly the kind
   * of thing these tables carry, so a letter and a digit together count too.
   */
  const isPhrase = (v) => {
    const s = String(v || '').trim();
    return /[a-z]{3}/i.test(s) || (/[a-z]/i.test(s) && /\d/.test(s) && s.length > 2);
  };

  /*
   * Every geometric column a reviewed one could be, not just the first.
   *
   * Two columns can share a fact: protocol15 heads both Screening and Baseline
   * "-4 to 0*", and taking the first match sent Screening's cells to Baseline —
   * so "3 X/week for 2 weeks" was compared against a cell holding "3 X",
   * decided nothing needed restoring, and the truncated value stayed. The right
   * one is whichever actually has the value in question.
   */
  const byKey = new Map();
  for (const column of geometric.columns || []) {
    for (const k of columnKeys(column)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(column.id);
    }
  }
  const columnsFor = (reviewedColumn) => [...new Set(
    columnKeys(reviewedColumn).flatMap((k) => byKey.get(k) || []),
  )];

  let filled = 0;
  for (const row of reviewed.rows || []) {
    const rowKey = key(row.label);
    if (!rowKey) continue;
    const match = (geometric.rows || []).find((g) => {
      const other = key(g.label);
      return other && (other === rowKey
        || (Math.min(other.length, rowKey.length) >= 12 && (other.startsWith(rowKey) || rowKey.startsWith(other))));
    });
    if (!match) continue;

    // One printed cell belongs to one column. Where the review splits a visit
    // in two — protocol15 heads two columns "-4 to 0*" — filling both from the
    // same cell puts a value on the page twice.
    const spent = new Set();
    for (const column of reviewed.columns || []) {
      // A divider is a boundary between phases; nothing is scheduled in it.
      if (column.divider) continue;
      const there = columnsFor(column);
      const cell = there.length
        && (match.cells || []).find((c) => there.includes(c.col) && isPhrase(c.value) && !spent.has(c));
      if (!cell) continue;
      spent.add(cell);
      const already = (row.cells || []).find((c) => c.col === column.id);
      /*
       * A mark the review placed is the review's; it is not second-guessed.
       *
       * Except where the geometry holds that same mark with the words that
       * qualify it — "X" against "X wk 6". That is not a competing reading, it
       * is the rest of the cell, and keeping the shorter one drops the half
       * that says when the assessment happens.
       */
      const extends_ = already && cell.value.startsWith(already.value) && cell.value.length > already.value.length;
      if (already && !isPhrase(already.value) && !extends_) continue;
      if (already && already.value === cell.value) continue;
      if (already) already.value = cell.value;
      else row.cells.push({ col: column.id, value: cell.value });
      filled++;
    }

    /*
     * A written-out value printed once, held once.
     *
     * Where the review splits one visit into two columns, both can end up with
     * the same phrase — one restored, one left from an earlier pass — and the
     * row then claims the page says a thing twice. The geometry knows how many
     * times it is printed, so any copy beyond that count goes.
     */
    // Only real prose is policed this way. "3 X" appears legitimately in six
    // columns of a row, and counting copies of it against the geometry trims
    // cells that belong there.
    const spelledOut = (v) => /[a-z]{3}/i.test(String(v || ''));
    for (const [value, times] of (match.cells || []).filter((c) => spelledOut(c.value))
      .reduce((m, c) => m.set(c.value, (m.get(c.value) || 0) + 1), new Map())) {
      const copies = row.cells.filter((c) => c.value === value);
      for (const spare of copies.slice(times)) row.cells.splice(row.cells.indexOf(spare), 1);
    }
  }
  return filled;
}

/**
 * Footnote markers printed at the end of a row's name, linked to that row.
 *
 * A schedule marks a whole assessment as often as it marks a cell — protocol5
 * prints "Chemistries plus liver function tests**" and "Pregnancy Test***" —
 * and read as text those markers stay part of the label. The footnote then has
 * nothing anywhere in the table pointing at it: clicking it highlights nothing,
 * and the reader is left to guess what it qualifies. The marker is still there
 * in the label, so it is read off it.
 */
export function linkTrailingMarkers(table) {
  // Longest first, so "Pregnancy Test***" is not claimed by footnote "*".
  const markers = (table.footnotes || []).map((f) => f.marker).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!markers.length) return 0;

  let linked = 0;
  // A symbol may sit anywhere in a timepoint — "-15* to -9" marks the visit,
  // not the "-9" — while a letter marker is only a marker where it trails the
  // name it qualifies, since letters are otherwise just letters.
  const symbol = (m) => /^[*†‡§¶#]+$/.test(m);
  const attach = (holder, texts, target, key) => {
    const found = markers.find((m) => texts.some((t) => {
      const s = String(t || '').trim();
      if (s.length <= m.length) return false;
      // A symbol marker leads its name as often as it trails it: protocol9
      // writes "* Morphine (0600, 1100, 1630, 2200 h)" and "**Lofexidine or
      // Placebo", where the footnote is announced before the assessment it
      // qualifies. Looking only at the end left all three of that schedule's
      // footnotes pointing at nothing.
      if (symbol(m) && s.startsWith(m) && !s.startsWith(`${m}${m[0]}`)) return true;
      return s.endsWith(m) || (symbol(m) && target === 'column' && s.split(m).length === 2);
    }));
    if (!found) return;
    holder.markers = [...new Set([...(holder.markers || []), found])];
    const footnote = table.footnotes.find((f) => f.marker === found);
    footnote.appliesTo = (footnote.appliesTo || []).filter((a) => a.target !== 'table');
    if (!footnote.appliesTo.some((a) => a.target === target && a[key] === holder.id)) {
      footnote.appliesTo.push({ target, [key]: holder.id });
      linked++;
    }
  };

  for (const row of table.rows || []) attach(row, [row.label], 'row', 'row');
  // A marker on a timepoint qualifies the whole visit — protocol15 heads a
  // column "-4 to 0*" and protocol5 "-15* to -9". Those footnotes have no cell
  // to point at, so without this they are printed under the table linked to
  // nothing at all.
  for (const column of table.columns || []) {
    attach(column, [column.label, column.studyDay, column.studyWeek, column.visitNumber], 'column', 'column');
  }
  return linked;
}

/**
 * Find and extract every schedule in a document.
 *
 * More than one candidate is pursued on purpose: a protocol may carry a main
 * schedule and a sub-study or PK sub-schedule, and reporting only the
 * best-scoring one would silently drop a whole table. Weak candidates are
 * dropped by a floor rather than by rank, so a document with two good schedules
 * yields two and a document with one yields one.
 */
export async function run(buffer, { maxTables = 3, floor = 12, assist = true, log = () => {} } = {}) {
  const doc = await readPdf(buffer);
  const { candidates, scores } = locate(doc);

  const tables = [];
  for (const candidate of candidates.slice(0, maxTables)) {
    if (candidate.score < floor && tables.length) break;
    const pages = candidate.pages.map((n) => doc.pages[n - 1]);
    const table = extractTable(pages, { title: titleOn(pages[0]) || titleOn(pages[1] || pages[0]) });
    // A candidate that yielded no grid was a false positive from the locator,
    // and reporting an empty table would be worse than reporting none.
    if (!table.rows.length || table.columns.length < 2) continue;
    // The first candidate is the schedule. A SECOND one is only believed when
    // the document names it — a protocol that carries a sub-study or PK
    // sub-schedule prints a heading for it, while a dense narrative section
    // that merely scores well does not. Without this, a page of numbered prose
    // is reported as a schedule with a hundred rows.
    if (tables.length && !table.title) continue;
    table.id = `t${tables.length + 1}`;
    table.locatorScore = candidate.score;
    table.locatorEvidence = candidate.evidence.map((e) => ({ page: e.page, score: e.score, reasons: e.reasons }));
    // Score the extraction against itself before anyone is asked to believe it.
    // Linked BEFORE it is scored. The self-check counts footnotes that point at
    // nothing, and running it before the pass that binds markers to the rows
    // they name meant it counted footnotes that were about to be linked —
    // nine of Prot_000's twelve, when the true number is one. A check that
    // reports work not yet done sends good tables for an expensive review.
    linkTrailingMarkers(table);
    table.assessment = assess(table);
    tables.push(table);
  }

  // A second opinion, only where the self-checks say the geometric read cannot
  // be trusted, and only on the pages they name. A clean table never costs a
  // call; a broken one costs a few pages, not the document.
  if (assist && available()) {
    for (const table of tables) {
      if (table.assessment.verdict !== 'fallback') continue;
      // The WHOLE table goes, not just the pages the checks complained about.
      // A continuation page without its header page is unreadable, and asking
      // only about the footnote pages of a good table gets the honest answer
      // "there is no table here" — which then replaces a correct extraction
      // with an empty one. The flagged pages say WHETHER to ask, not what about.
      const pages = table.pages.map((n) => doc.pages[n - 1]).filter(Boolean);
      if (!pages.length) continue;

      log('assist', `${table.id}: confidence ${table.assessment.confidence} (${table.assessment.findings.filter((f) => f.severity === 'high').map((f) => f.check).join(', ')}); reviewing pages ${table.pages.join(', ')}`);
      const found = await secondOpinion(pages, { geometric: table, log });
      if (!found || !found.length) continue;
      const reviewed = found[0];

      // A second opinion that found nothing is not an improvement on something.
      // Dropping rows or columns wholesale is the failure the brief penalises
      // most heavily, so the geometric read stands unless the review at least
      // matches it in size.
      if (!reviewed.rows?.length || reviewed.columns?.length < 2) {
        log('assist', `${table.id}: the review found no table on these pages; keeping the rule-based read`);
        continue;
      }

      // A review that lost rows wholesale is worse than the reading it
      // replaces. But the rule-based pass also SPLITS rows it should not, so a
      // review returning somewhat fewer is often the correct one — protocol15
      // reads 40 rows geometrically where the page prints 34. The threshold
      // catches the real failure seen here (an open model returning 21 of 39)
      // without discarding a review that merely tidied up.
      const named = (t) => (t.rows || []).filter((r) => String(r.label || '').trim()).length;
      if (named(reviewed) < named(table) * 0.7) {
        log('assist', `${table.id}: the review returned ${named(reviewed)} named rows against ${named(table)} `
          + 'already found — it dropped rows, so the rule-based read stands');
        continue;
      }

      // Both readings are kept. The geometric one is exact where it is right,
      // and a reviewer comparing them is better served than one handed a single
      // answer with no way to see what changed.
      reviewed.id = table.id;
      reviewed.title = reviewed.title || table.title;
      reviewed.locatorScore = table.locatorScore;
      reviewed.locatorEvidence = table.locatorEvidence;
      const filled = restoreHeader(reviewed, table);
      if (filled) log('assist', `${table.id}: ${filled} header fact(s) the review left blank were restored from the geometry`);
      const cells = restoreCells(reviewed, table);
      if (cells) log('assist', `${table.id}: ${cells} written-out cell value(s) the review could not place were restored from the geometry`);
      const rejoined = restoreRowSplits(reviewed, table);
      if (rejoined) log('assist', `${table.id}: ${rejoined} row(s) the review split over two lines were rejoined from the drawn grid`);
      const dividers = restoreDividers(reviewed, table);
      const settled = retireSettledNotes(reviewed);
      if (settled) log('assist', `${table.id}: ${settled} note(s) the review left unresolved are now settled by the ruled grid`);
      if (dividers) log('assist', `${table.id}: ${dividers} divider column(s) the review did not report were restored from the geometry`);
      reviewed.assessment = assess(reviewed);
      reviewed.geometric = {
        columns: table.columns.length,
        rows: table.rows.length,
        confidence: table.assessment.confidence,
        findings: table.assessment.findings.map((f) => f.check),
      };
      tables[tables.indexOf(table)] = reviewed;
      log('assist', `${reviewed.id}: confidence ${table.assessment.confidence} → ${reviewed.assessment.confidence}`);

      // A second schedule on the same pages — a sub-study, a PK sampling or a
      // blood-collection appendix — is a table in its own right, not a
      // continuation of the first. The brief names this case explicitly.
      for (const extra of found.slice(1)) {
        if (!extra.rows?.length || extra.columns?.length < 2) continue;
        extra.id = `t${tables.length + 1}`;
        /*
         * Its own pages, not the whole range it was found in.
         *
         * A second schedule is read from the same run of pages as the first, so
         * it inherited that whole range — protocol5's blood-collection appendix
         * claimed to start on page 50, where only the main schedule is printed.
         * A reader turning to page 50 to check it finds a different table, and
         * anything comparing the two is told they occupy the same paper. Where
         * the review names the pages a row of this table actually sits on, they
         * are what the table reports.
         */
        const range = extra.pages?.length ? extra.pages : (table.pages || []);
        const title = String(extra.title || '').toLowerCase().slice(0, 24);
        const at = title ? range.findIndex((n) =>
          (doc.pages[n - 1]?.lines || []).some((l) => l.text.toLowerCase().includes(title))) : -1;
        // Row names cannot decide this: an appendix of blood collections repeats
        // the assessment names of the schedule it follows.
        if (at > 0) extra.pages = range.slice(at);
        extra.locatorScore = table.locatorScore;
        extra.locatorEvidence = table.locatorEvidence;
        extra.assessment = assess(extra);
        tables.push(extra);
        log('assist', `${extra.id}: a second schedule on the same pages — "${(extra.title || 'untitled').slice(0, 60)}"`);
      }
    }
  }

  const sourcePages = {};
  for (const table of tables) {
    for (const n of table.pages || []) {
      const page = doc.pages[n - 1];
      if (page && !sourcePages[n]) sourcePages[n] = page.lines.map((l) => l.text).filter(Boolean);
    }
  }

  return {
    pageCount: doc.pageCount,
    // The lines of every page a table came from, so the grid can be checked
    // against the document without opening the PDF separately.
    sourcePages,
    // One published shape, whichever path produced each table. Markers left in
    // the row names are linked first, so the published linkage is complete
    // however the table was read.
    // Already linked above for the tables read by rule; a reviewed table has
    // replaced one of those and needs the pass run on it too.
    tables: tables.map((table) => { linkTrailingMarkers(table); return normalise(table); }),
    // Kept so the UI can show why these pages and not others, and so a reviewer
    // can argue with the locator instead of trusting it.
    pageScores: scores.filter((s) => s.score > 0).map((s) => ({ page: s.page, score: s.score, reasons: s.reasons })),
    extractedAt: new Date().toISOString(),
  };
}
