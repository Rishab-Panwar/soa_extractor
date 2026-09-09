/*
 * locate.js — find the Schedule of Activities in a protocol nobody has read.
 *
 * No page numbers are hardcoded and no filename is consulted. The tool is given
 * 80–250 pages and has to work out which two to four of them hold the schedule.
 *
 * Nothing here calls a model. A schedule announces itself structurally, and
 * structure is cheap to measure: a title in the family of names sponsors
 * actually use, a header row of visit or day numbers, a dense field of short
 * marks, and a block of footnote definitions. Each is weak alone — a table of
 * contents has the title, a statistics section has numbers, an appendix of
 * abbreviations has definitions — so they are scored together and the evidence
 * is kept, because a locator that cannot say WHY it chose a page cannot be
 * argued with by the person checking it.
 *
 * The part that took the longest to get right is not finding the first page.
 * It is knowing where the table stops: a schedule runs on for two to four pages
 * whose continuations may carry no title, no header and no marks at all — a
 * page of nothing but footnote text still belongs to the table two pages back.
 */

/** The names sponsors give this table. Deliberately broad; scored, not matched. */
const TITLE_WORDS = [
  'schedule of activities', 'schedule of assessments', 'schedule of events',
  'schedule of procedures', 'schedule of measures', 'schedule of evaluations',
  'schedule of study procedures', 'study schedule', 'visit schedule',
  'time and events', 'time & events', 'study flow chart', 'study flowchart',
  'flow chart', 'flowchart', 'table of events', 'trial schedule',
  'overview of study assessments', 'study assessments', 'assessment schedule',
  'schedule of time and events',
];

/** Words that head the stacked rows of a visit header. */
const HEADER_WORDS = [
  'visit', 'study day', 'study week', 'day', 'week', 'cycle', 'timepoint',
  'time point', 'window', 'visit window', 'month', 'hour', 'period', 'activity',
  'assessment', 'assessments', 'procedure', 'procedures', 'evaluation',
];

/** Period names that cluster along the top of a schedule. */
const PERIOD_WORDS = [
  'screening', 'baseline', 'randomization', 'randomisation', 'treatment',
  'follow-up', 'follow up', 'end of treatment', 'end of study', 'washout',
  'enrollment', 'enrolment', 'discharge', 'termination', 'early termination',
  'run-in', 'lead-in', 'maintenance', 'extension', 'unscheduled',
];

/**
 * A mark in a cell.
 *
 * Deliberately not just "X". The brief is explicit that cells carry 3X, Q2W,
 * (X), 2X/day, dashes and numbers, and a locator that only counts X misses the
 * schedules that use anything else — which are exactly the ones a naive tool
 * also fails to extract.
 */
const CELL_MARK = /^(?:x|\(x\)|\[x\]|✓|✔|●|•|◆|■|†|‡|\*|-|–|—|\d{1,2}\s*x|x\s*\d{1,2}|q\d+[wdhm]|b?id|tid|qd|qw|prn|y\/n|yes|no|\d{1,3}(?:\.\d+)?)[a-z0-9,\)\]\*†‡]*$/i;

/** A line that defines a footnote. */
const FOOTNOTE_DEF = /^(?:[a-z]{1,2}|[0-9]{1,2}|[*†‡§¶#]{1,3}|x[a-z]|\([a-z0-9]{1,2}\))\s*[.):=-]?\s+\S/i;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Is this line a heading rather than a sentence about a heading? */
function looksLikeHeading(line) {
  const text = line.text.trim();
  if (text.length > 110) return false;
  // Table-of-contents rows: dotted leaders, or a trailing page number.
  if (/\.{4,}\s*\d+\s*$/.test(text)) return false;
  if (/\s{3,}\d{1,3}\s*$/.test(text) && text.length < 80) return false;
  // Cross references in prose: "see the Schedule of Events in Attachment 1".
  if (/\b(see|refer to|described in|listed in|presented in|shown in)\b/i.test(text)) return false;
  return true;
}

/** Everything measurable about one page, with the reasons kept. */
export function scorePage(page) {
  const reasons = [];
  let score = 0;

  // ── a title in the family ────────────────────────────────────────────────
  for (const line of page.lines) {
    const text = norm(line.text);
    const hit = TITLE_WORDS.find((w) => text.includes(w));
    if (hit && looksLikeHeading(line)) {
      // A title alone is the strongest single signal, but it is also what a
      // contents page and a cross-reference have, hence the guards above.
      score += 6;
      reasons.push(`title "${line.text.trim().slice(0, 60)}"`);
      break;
    }
  }

  // ── a header row: a header word followed by a run of numbers ─────────────
  let headerRows = 0;
  for (const line of page.lines) {
    const text = norm(line.text);
    if (!HEADER_WORDS.some((w) => text.startsWith(w) || text.includes(` ${w} `))) continue;
    const numbers = line.words.filter((w) => /^-?\d{1,3}(?:[.,]\d+)?$/.test(w.text.trim())).length;
    if (numbers >= 3) headerRows += 1;
  }
  if (headerRows) {
    score += Math.min(headerRows, 3) * 2;
    reasons.push(`${headerRows} header row(s) of numbered timepoints`);
  }

  // ── period words clustered near each other ───────────────────────────────
  const periodHits = new Set();
  for (const line of page.lines) {
    const text = norm(line.text);
    for (const w of PERIOD_WORDS) if (text.includes(w)) periodHits.add(w);
  }
  if (periodHits.size >= 2) {
    score += Math.min(periodHits.size, 4);
    reasons.push(`${periodHits.size} study-period words`);
  }

  // ── a dense field of cell marks ──────────────────────────────────────────
  // Counted page-wide rather than per line: a rotated page that pdfjs orders
  // badly still has the same marks on it, and a grid signal that depends on
  // line structure is exactly the one that fails on the pages that need it.
  const marks = page.words.filter((w) => CELL_MARK.test(w.text.trim())).length;
  if (marks >= 8) {
    score += Math.min(marks / 8, 6);
    reasons.push(`${marks} cell-like marks`);
  }

  // Rows of marks matter more than marks: three lines each carrying several is
  // a grid, thirty scattered dashes are prose.
  const markLines = page.lines.filter((l) => {
    const m = l.words.filter((w) => CELL_MARK.test(w.text.trim())).length;
    return m >= 3 && m / l.words.length > 0.4;
  }).length;
  if (markLines >= 3) {
    score += Math.min(markLines / 2, 5);
    reasons.push(`${markLines} grid-like rows`);
  }

  // ── a block of footnote definitions ──────────────────────────────────────
  const footnoteLines = page.lines.filter((l) => FOOTNOTE_DEF.test(l.text.trim())).length;
  if (footnoteLines >= 3) {
    score += Math.min(footnoteLines / 3, 3);
    reasons.push(`${footnoteLines} footnote-definition lines`);
  }

  return { page: page.number, score: Math.round(score * 100) / 100, reasons, marks, markLines, footnoteLines };
}

/**
 * Candidate page ranges, best first.
 *
 * A page scoring above the seed threshold starts a candidate, which then grows
 * in BOTH directions through pages that look like continuations. Growing
 * backwards is what rescues a rotated first page whose text pdfjs ordered badly
 * enough to score below the seed; growing forwards through a page that is
 * nothing but footnote definitions is what stops a footnote block being
 * orphaned from the table it belongs to.
 */
export function locate(doc, { seed = 9, join = 3.5, maxPages = 8 } = {}) {
  const scores = doc.pages.map(scorePage);
  const byNumber = new Map(scores.map((s) => [s.page, s]));

  // A continuation page carries the grid itself. Scoring alone is too generous:
  // a narrative page that happens to mention Screening and Follow-up clears a
  // score threshold while containing no table at all, and the candidate then
  // grows through half a chapter.
  const hasGrid = (s) => s && s.markLines >= 3 && s.marks >= 8;
  // A footnote page is one that defines footnotes and carries no grid. The
  // test is the absence of a table, not the absence of marks: footnote prose is
  // full of dashes, dosing abbreviations and numbers, so counting marks alone
  // disqualifies exactly the pages this is meant to catch.
  const isFootnoteBlock = (s) => s && s.footnoteLines >= 3 && s.markLines < 3;

  const used = new Set();
  const candidates = [];

  for (const seedPage of [...scores].sort((a, b) => b.score - a.score)) {
    if (seedPage.score < seed || used.has(seedPage.page)) continue;

    let first = seedPage.page;
    let last = seedPage.page;
    const room = () => last - first + 1 < maxPages;

    // Grid-bearing neighbours are part of the table.
    while (first - 1 >= 1 && !used.has(first - 1) && hasGrid(byNumber.get(first - 1)) && room()) first -= 1;
    while (last + 1 <= doc.pageCount && !used.has(last + 1) && hasGrid(byNumber.get(last + 1)) && room()) last += 1;

    // A footnote block spills past ONE page break, not eight. Without the
    // limit, a contents section or an appendix of abbreviations — pages of
    // definition-shaped lines and nothing else — swallows half the document.
    // The brief is explicit that truncating a spilled footnote is a failure, so
    // this follows the block for as long as it runs — bounded, because an
    // appendix of abbreviations looks the same and does not belong here.
    let spill = 0;
    while (last + 1 <= doc.pageCount && !used.has(last + 1)
           && isFootnoteBlock(byNumber.get(last + 1)) && spill < 2 && room()) {
      last += 1;
      spill += 1;
    }

    for (let p = first; p <= last; p++) used.add(p);
    const pages = [];
    for (let p = first; p <= last; p++) pages.push(p);
    candidates.push({
      pages,
      score: seedPage.score,
      total: Math.round(pages.reduce((n, p) => n + byNumber.get(p).score, 0) * 100) / 100,
      seedPage: seedPage.page,
      evidence: pages.map((p) => byNumber.get(p)),
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.total - a.total);
  return { candidates, scores };
}
