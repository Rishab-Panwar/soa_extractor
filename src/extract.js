/*
 * extract.js — a located schedule, as a faithful grid.
 *
 * The table is rebuilt from where the words sit, not from ruled lines and not
 * from reading order. Sponsors draw these grids with whitespace as often as
 * with borders, and the one thing that is always true is that every mark in a
 * visit's column shares that column's horizontal position. So: cluster the
 * marks into columns, cluster the lines into rows, and read off what is where.
 *
 * The rules this obeys, all of them from the brief and all of them things that
 * are easy to get wrong quietly:
 *
 *   Cell values are copied verbatim. "3X/2 weeks", "(X)", "Q2W", "1X" and "Xa"
 *   are the information the table exists to carry; a boolean is not.
 *
 *   A missing row or column is the worst failure, so where this is unsure it
 *   keeps what it found and says so in `ambiguities` rather than dropping it.
 *
 *   Category rows are structure. "Safety Assessments" with no marks under it is
 *   not an assessment that never happens.
 *
 *   A footnote's text is worth little without knowing what it marks, so markers
 *   are read off the cells and rows that carry them and linked both ways.
 */

const CELL_TOKEN = /^(?:x|\(x\)|\[x\]|✓|✔|●|•|◆|■|†|‡|§|\*|-|–|—|→|←|↔|\d{1,3}(?:[.,]\d+)?|\d{1,2}\s*x|x\s*\d{1,2}|q\d+[wdhm]|b?id|tid|qd|qw|prn|y\/n|yes|no|n\/a|na)[a-z0-9,.\/\)\]\*†‡§¶#\s-]*$/i;

/** Typographic marks that are footnote markers in any document. */
const LEGEND_MARK = /^(?:[*†‡§¶#]{1,3}|x)$/i;

/** A footnote definition line: a marker, then its text. */
/**
 * A footnote definition line, in the forms documents actually print.
 *
 *   "*Baseline assessments must..."   a symbol running straight into its text
 *   "X a – Blood is collected..."     the marker printed ON an X — footnote "a"
 *   "a. text"  "b) text"  "c - text"  marker then a separator
 *   "d  text"                         marker then a space
 *
 * The middle form is the one that bites: read naively it becomes footnote "X"
 * with the real marker stranded in the text, so four definitions collapse into
 * one and the letters they link to are lost.
 */
const FOOTNOTE_DEF = /^(?:(?<sym>[*†‡§¶#]{1,3})\s*|(?<on>[Xx✓●•]\s*)?(?<marker>[a-z]|\d{1,2}|\([a-z0-9]{1,2}\))\s*(?:[.):=–—-]\s*|\s+))(?<text>\S.*)$/i;

/*
 * Words that name what a header row is telling you.
 *
 * The optional qualifier matters more than it looks. Sponsors write "Study
 * Phase", "Trial Period", "Visit Window" — the dimension is the second word.
 * Anchoring on the dimension alone means "Study Phase" is not recognised as a
 * header at all, so the phase band becomes the first DATA row, everything above
 * it is then out of range of the header reader, and every column ends up named
 * "Column 7". One unmatched word costs the entire header.
 */
const QUALIFIER = String.raw`(?:study|trial|protocol|treatment|visit)?\s*`;
const HEADER_ROLES = [
  [/^visit\s*(no\.?|number|#)/i, 'visitNumber'],
  [new RegExp(`^${QUALIFIER}day`, 'i'), 'studyDay'],
  [new RegExp(`^${QUALIFIER}week`, 'i'), 'studyWeek'],
  [new RegExp(`^${QUALIFIER}month`, 'i'), 'studyMonth'],
  [new RegExp(`^${QUALIFIER}window`, 'i'), 'window'],
  [/^visits?\b/i, 'visitName'],
  /*
   * "Trial Activity", "Assessment", "Procedure" caption the ACTIVITY COLUMN,
   * not the columns to their right — they are the label column's own heading,
   * and the row they sit on carries the study phases. Reading them as visit
   * names takes the slot the real visit row needs: Prot_000 captions its
   * phases "Trial Activity" and its visits "Visits", and naming the first one
   * left the second with nowhere to go, so the columns came out called
   * "Screening Period" instead of "Stabilization", "V 2.1", "V 2.2".
   */
  [new RegExp(`^${QUALIFIER}(?:period|phase|stage|epoch|activit(?:y|ies)|assessments?|procedures?|events?)`, 'i'), 'period'],
  [/^cycle/i, 'cycle'],
];

/** A row label that announces a header line rather than an assessment. */
const HEADER_LABEL = new RegExp(
  `^${QUALIFIER}(?:visit|activity|assessment|procedure|day|week|month|cycle|window|`
  + `period|phase|stage|epoch|timepoint|time\\s*point|event)s?\\b`, 'i');

// "events" is deliberately absent. "Adverse events" is a row every one of these
// protocols has, and this test decides what is a header rather than a row; a
// header captioned only "Events" is rare enough to lose in exchange. Verified
// not to be load-bearing on its own — putting it back keeps the suite green —
// so it is a guard, not the fix. The fix is measuring the grid's extent over
// every marked row, further down.
const DIMENSION = /\b(?:visits?|activit(?:y|ies)|assessments?|procedures?|days?|weeks?|months?|cycles?|windows?|periods?|phases?|stages?|epochs?|time\s*points?)\b/i;

/**
 * Does this caption name what its row is telling you about the columns?
 *
 * Only the first two words are looked at, and that limit is the whole point.
 * Sponsors caption these rows loosely — "Allowed window for visit (days)" is a
 * window row even though it does not begin with the word — so anchoring at the
 * start misses them and the row is swallowed into the one above. But looking
 * anywhere in the caption is worse: protocol9 sets the table's own title down
 * the left of its header, and "Collection for Lofexidine Phase 3" would then
 * pass as a phase row and tear the real phase banding into pieces.
 */
const namesDimension = (label) => DIMENSION.test(clean(label).split(/\s+/).slice(0, 2).join(' '));

/**
 * A caption that names a table by number: "Table 4", "APPENDIX II", "Figure 3".
 *
 * Only useful for spotting where ONE table ends and another begins, which is
 * why it insists on the number. "Schedule of Events" is a title; "Appendix II"
 * is a table's address in the document.
 */
const NEW_TABLE = /^(?:table|appendix|figure|exhibit)\s+[\divxlc]+\b/i;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Two lines of one heading, put back together.
 *
 * A word broken across lines keeps its hyphen — "Pre-" then "intake" is
 * "Pre-intake", not "Pre- intake", and "Dis" "-" then "charge" is "Dis-charge".
 * Anything else is two words and gets a space.
 */
const joinWrapped = (a, b) => (/-\s*$/.test(a) ? `${a.replace(/\s*-\s*$/, '-')}${b}` : `${a} ${b}`);
const centre = (w) => w.x + w.w / 2;

/**
 * How two printings of the same row label are recognised as one row.
 *
 * A continuation page reprints its labels, and sponsors are not careful about
 * it: "Hemoglobin A1C" on one page and "Hemoglobin A1c" on the next. Comparing
 * the text as printed turns one assessment into two, which is a fabricated row.
 */
const labelKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * What identifies a visit column across pages.
 *
 * The printed header is the only evidence available, so the key is what it
 * says: the visit number, day and week together. Two columns that agree on all
 * of those are the same visit reprinted; a column whose header says nothing at
 * all cannot be matched and stays distinct, which is the safe direction.
 */
function columnKey(column) {
  const facts = [column.visitNumber, column.studyDay, column.studyWeek]
    .map((v) => labelKey(v || '')).filter(Boolean);
  if (facts.length) return facts.join('|');

  // No timepoint fact. A SHORT label can still identify a visit — "3", "ET",
  // "V2", "Follow-up" — but a sentence cannot, and neither can this tool's own
  // "Column 7" placeholder.
  const label = labelKey(column.label || '');
  if (!label || /^columnd+$/.test(label) || label.length > 14) return null;
  return label;
}

/** The existing row this label refers to, allowing for a different line wrap. */
function findRow(index, label) {
  const key = labelKey(label);
  if (!key) return null;
  if (index.has(key)) return index.get(key);
  for (const [other, row] of index) {
    const shorter = key.length < other.length ? key : other;
    if (shorter.length >= 12 && (key.startsWith(other) || other.startsWith(key))) return row;
  }
  return null;
}

/**
 * A superscript drawn as its own item, immediately after a mark.
 *
 * Recognised by position, not by font tables: it starts within a couple of
 * points of the mark's right edge, is no taller than the mark, and is one or
 * two characters. Sponsors draw these both ways — protocol1 gives "Xa" as a
 * single string, protocol15 draws "X" and "b" separately — and an extractor
 * that only handles the first way silently loses every marker in the second.
 */
function superscriptAfter(mark, candidates) {
  const right = mark.x + mark.w;
  for (const w of candidates) {
    const t = clean(w.text);
    if (!t || t.length > 2) continue;
    if (!/^[a-z0-9*†‡§¶#]{1,2}$/i.test(t)) continue;
    if (w.x < right - 1 || w.x > right + 3.5) continue;
    if (w.h > mark.h + 0.5) continue;
    return t;
  }
  return null;
}

/**
 * Is this word a cell mark rather than prose?
 *
 * Deliberately NOT any single letter. A schedule may define its own shorthand
 * in a legend — protocol1 uses "P" for "Practice only" — and those cells are
 * lost here as a result. Accepting bare letters was tried and is worse: this
 * same test decides where the row label ends and the grid begins, so a label
 * containing a lone letter moves that boundary and the whole table dissolves.
 * The review path recovers such cells; the rule-based path records the loss.
 */
function isMark(word) {
  const t = clean(word.text);
  if (!t || t.length > 14) return false;
  return CELL_TOKEN.test(t);
}

/**
 * Where the columns are.
 *
 * Built from the marks themselves rather than from the header, because the
 * header is the least reliable part of these tables — it is stacked, abbreviated
 * and sometimes absent on a continuation page, while the marks below it line up
 * perfectly by construction.
 */
/**
 * The columns a ruled page draws, taken from the rules themselves.
 *
 * This is the whole point of reading the vector layer. Clustering marks can
 * only find a column that something happens in: a visit with one X, or none,
 * simply is not there, and the schedule comes out with a third of its visits
 * missing and no sign that anything is wrong. The vertical rules say where the
 * columns are whether or not anything is written in them.
 *
 * Only rules that run the height of the grid count. Sponsors box individual
 * cells, and a one-cell-tall rule is a cell border, not a column.
 */
function ruledBands(page, dataRows, gridLeft) {
  const rules = page.rules?.verticals;
  if (!rules || rules.length < 3 || !dataRows.length) return null;

  const top = Math.min(...dataRows.map((r) => r.y));
  const bottom = Math.max(...dataRows.flatMap((r) => r.lines.map((l) => l.bottom)));
  const height = bottom - top;
  if (height <= 0) return null;

  // A rule that covers most of the rows is a column boundary.
  const spanning = rules
    .filter((v) => Math.min(v.y1, bottom) - Math.max(v.y0, top) >= height * 0.6)
    .map((v) => v.x)
    .sort((a, b) => a - b);

  // Double-ruled borders arrive as two lines a point apart; they are one edge.
  const edges = [];
  for (const x of spanning) {
    if (!edges.length || x - edges[edges.length - 1] > 3) edges.push(x);
  }
  if (edges.length < 3) return null;

  const bands = [];
  for (let i = 1; i < edges.length; i++) {
    // The activity column is ruled like any other, and it is not a visit.
    if (edges[i] <= gridLeft + 2) continue;
    bands.push({
      id: `c${bands.length + 1}`,
      left: edges[i - 1],
      right: edges[i],
      centre: (edges[i - 1] + edges[i]) / 2,
      hits: 0,
      ruled: true,
    });
  }
  return bands.length >= 2 ? bands : null;
}

export function columnBands(rows, pageWidth) {
  const centres = [];
  for (const row of rows) for (const w of row.marks) centres.push(centre(w));
  if (centres.length < 4) return [];
  centres.sort((a, b) => a - b);

  // A gap wider than this starts a new column. Derived from the marks' own
  // spacing so it survives a dense 30-column table and a sparse 5-column one.
  // Consecutive centres are either the same column (a gap of nearly nothing)
  // or the next one (a gap of a column's width). The threshold has to land
  // between those two populations: measuring the typical NON-zero gap gives the
  // column pitch, and a third of it separates jitter from a real boundary.
  const gaps = [];
  for (let i = 1; i < centres.length; i++) {
    const g = centres[i] - centres[i - 1];
    if (g > 1) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[Math.floor(gaps.length * 0.5)] : 20;
  const split = Math.max(5, Math.min(pitch * 0.35, pageWidth / 8));

  const bands = [];
  let current = [centres[0]];
  for (let i = 1; i < centres.length; i++) {
    if (centres[i] - centres[i - 1] > split) {
      bands.push(current);
      current = [];
    }
    current.push(centres[i]);
  }
  bands.push(current);

  return bands
    .filter((b) => b.length >= 1)
    .map((b, i) => ({
      id: `c${i + 1}`,
      left: Math.min(...b),
      right: Math.max(...b),
      centre: b.reduce((s, v) => s + v, 0) / b.length,
      hits: b.length,
    }));
}

/** The column a word belongs to, or null when it sits between them. */
function columnFor(word, bands) {
  const c = centre(word);
  let best = null;
  let bestGap = Infinity;
  for (const band of bands) {
    const gap = c < band.left ? band.left - c : c > band.right ? c - band.right : 0;
    if (gap < bestGap) { bestGap = gap; best = band; }
  }
  // A mark more than half a column away from every band is not in the grid.
  const tolerance = Math.max(14, (bands[1] ? bands[1].centre - bands[0].centre : 30) * 0.55);
  return bestGap <= tolerance ? best : null;
}

/**
 * Split each line into a label on the left and marks on the right.
 *
 * The boundary is found per page from where the marks start, rather than
 * assumed: some sponsors put the activity column at the far left, some indent
 * it, and one of the five protocols prints CRF form numbers between the label
 * and the first column.
 */
export function splitLines(page) {
  /*
   * A symbol printed at the head of a row label is not a grid mark.
   *
   * protocol9 names two of its rows "* Morphine (0600, 1100, 1630, 2200 h)" and
   * "**Lofexidine or Placebo", and on its continuation page it bullets every
   * row — the symbol comes FIRST, at the page's left margin, and there are
   * enough of them to look exactly like a column. Counted as marks they put the
   * label/grid boundary at the margin, and from there nothing works: every row
   * label reads as empty, the header rows stop being recognised, the day row is
   * consumed as data, and the columns come out unnamed.
   */
  const startOfLine = (line, word) => word.x <= Math.min(...line.words.map((w) => w.x)) + 1;
  const LEADING = /^[*†‡§¶#•●◆■\-–—]{1,3}$/;
  const gridMarks = (line) => line.words.filter((w) =>
    isMark(w) && !(LEADING.test(clean(w.text)) && startOfLine(line, w)));

  const marky = page.lines
    .map((l) => ({ line: l, marks: gridMarks(l) }))
    .filter((r) => r.marks.length >= 2);
  if (marky.length < 3) return { gridLeft: null, rows: [] };

  /*
   * The grid begins at the leftmost place where marks STACK.
   *
   * Taking the leftmost mark on each line and reading off a low percentile
   * looked robust and is not: it only takes a couple of row labels beginning
   * with something mark-shaped — a dash on "- ( ARCI-MBG ) (1000h)", a number
   * on "(15)" — to put the boundary at the page margin. Then every row label
   * reads as empty, the header rows stop being recognised, and the whole page
   * comes apart. What actually distinguishes the grid is that a real column has
   * marks from several different rows at the same x; a label's first word has
   * whatever happens to be under it, which is usually nothing.
   */
  const centres = marky.flatMap((r) => r.marks.map((w) => ({ c: centre(w), left: w.x })))
    .sort((a, b) => a.c - b.c);
  const width = marky.flatMap((r) => r.marks.map((w) => w.w)).sort((a, b) => a - b);
  const near = Math.max(6, (width[Math.floor(width.length / 2)] || 6) * 1.5);

  const stacks = [];
  for (const mark of centres) {
    const last = stacks[stacks.length - 1];
    if (last && mark.c - last.c <= near) { last.n++; last.c = mark.c; last.left = Math.min(last.left, mark.left); }
    else stacks.push({ c: mark.c, left: mark.left, n: 1 });
  }
  const columns = stacks.filter((s) => s.n >= 3);
  const gridLeft = columns.length
    ? columns[0].left
    // Nothing stacks: fall back to the old reading rather than refusing a page.
    : marky.map((r) => Math.min(...r.marks.map((w) => w.x))).sort((a, b) => a - b)[Math.floor(marky.length * 0.15)];

  const rows = [];
  for (const line of page.lines) {
    const labelWords = line.words.filter((w) => w.x + w.w <= gridLeft + 2);
    const rest = line.words.filter((w) => w.x + w.w > gridLeft + 2);
    rows.push({
      y: line.y,
      bottom: line.bottom,
      label: clean(labelWords.map((w) => w.text).join(' ')),
      labelWords,
      marks: rest.filter(isMark),
      other: rest.filter((w) => !isMark(w)),
      words: line.words,
      text: line.text,
    });
  }
  return { gridLeft, rows };
}

/**
 * Rows that carry marks, plus the label-only lines that belong to them.
 *
 * A label that wraps onto a second line is part of the row above it, not a new
 * row: "CT Scan (if not within / last year and patient passes / all other
 * screens)" is one assessment. A label-only line that is NOT a wrap is a
 * category heading, and the difference is whether a marked row follows it
 * before the next marked row's label starts.
 */
function assembleRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.label && !row.marks.length) continue;

    if (row.marks.length) {
      const entry = { kind: 'assessment', label: row.label, y: row.y, marks: [...row.marks], lines: [row] };
      // Absorb following lines that continue this row: more of its name on the
      // left, or the rest of a cell value on the right. A cell whose value is
      // words wraps like any other text — protocol15 sets "Weekly x 2" with
      // "weeks" beneath it — and taking only the first line stores a value the
      // page does not contain.
      // Either more label or more value, never both: a line carrying its own
      // name AND its own value is the next row, not the rest of this one.
      const isWrap = (r) => !r.marks.length && (Boolean(r.label) !== Boolean(r.other.length));
      let j = i + 1;
      while (j < rows.length && isWrap(rows[j])) {
        const gap = rows[j].y - rows[j - 1].bottom;
        if (gap > 6) break;                       // a real gap: a new row, not a wrap
        if (rows[j].label && /^[A-Z][a-z]+ [A-Z]/.test(rows[j].label) && rows[j].label.length < 40) break;
        entry.label = `${entry.label} ${rows[j].label}`.trim();
        entry.lines.push(rows[j]);
        j += 1;
      }
      i = j - 1;
      out.push(entry);
    } else if (row.label) {
      const entry = { kind: 'label-only', label: row.label, y: row.y, marks: [], lines: [row] };
      let j = i + 1;
      while (j < rows.length && rows[j].label && !rows[j].marks.length && !rows[j].other.length
             && rows[j].y - rows[j - 1].bottom <= 6) {
        entry.label = `${entry.label} ${rows[j].label}`.trim();
        entry.lines.push(rows[j]);
        j += 1;
      }
      i = j - 1;
      out.push(entry);
    }
  }
  return out;
}

/** A caption sitting above the grid — the table's name, not a header row. */
const CAPTION = /^(?:table|figure|appendix|exhibit|schedule)\s+[\divxlc]/i;

/**
 * Place a header line's words into the bands they sit in, left to right.
 *
 * Each value keeps the extent of the words that produced it. A heading printed
 * across several columns has to be matched against the columns by where its ink
 * actually is, and a single centre point cannot say that.
 */
function placeCells(values, cells, bands, join) {
  const byBand = new Map();
  for (const word of [...cells].sort((a, b) => a.x - b.x)) {
    const band = columnFor(word, bands);
    if (!band) continue;
    const seen = byBand.get(band.id);
    byBand.set(band.id, seen
      ? { text: `${seen.text} ${word.text}`, x0: seen.x0, x1: Math.max(seen.x1, word.x + word.w) }
      : { text: word.text, x0: word.x, x1: word.x + word.w });
  }
  for (const [id, found] of byBand) {
    const seen = values.get(id);
    values.set(id, seen
      ? { text: join(seen.text, clean(found.text)), x0: Math.min(seen.x0, found.x0), x1: Math.max(seen.x1, found.x1) }
      : { text: clean(found.text), x0: found.x0, x1: found.x1 });
  }
}

/**
 * The next line of a heading, joined to the heading it continues.
 *
 * Not to the column it lands in. A heading spanning four columns wraps wherever
 * the words happen to break, so its second line sits under a different column
 * from its first: protocol9 prints "Detoxification:" over one column and
 * "Medication or Placebo Phase" — the rest of the same phrase — over the one
 * beside it. Filed by column, the phrase is torn into pieces and each piece
 * banded over the wrong part of the table. Filed by proximity, it stays one
 * heading, which is what it is on the page.
 */
function continueHeading(values, cells, bands, reach) {
  if (!values.size) return;
  // Measured against where the headings were BEFORE this line was read. Judging
  // against the extents as they grow lets one value snowball: the first word of
  // a row of four visit names starts a heading, and each of the next three then
  // lands within a column's width of what the previous one just extended, so all
  // four fuse into "Visit 0 Visit 1 Visit 1.1 Visit 2" in a single column.
  const before = [...values.values()].map((v) => ({ value: v, x0: v.x0, x1: v.x1 }));
  for (const word of [...cells].sort((a, b) => a.x - b.x)) {
    const middle = centre(word);
    let nearest = null;
    let best = Infinity;
    for (const { value, x0, x1 } of before) {
      const gap = middle < x0 ? x0 - middle : middle > x1 ? middle - x1 : 0;
      if (gap < best) { best = gap; nearest = value; }
    }
    // Beyond about a column's width it is not a continuation of that heading —
    // it is a heading of its own that the line above happened not to print.
    if (!nearest || best > reach) { placeCells(values, [word], bands, (a, b) => `${a} ${b}`); continue; }
    nearest.text = joinWrapped(nearest.text, clean(word.text));
    nearest.x0 = Math.min(nearest.x0, word.x);
    nearest.x1 = Math.max(nearest.x1, word.x + word.w);
  }
}

/**
 * A banding heading, applied to exactly the columns its cell encloses.
 *
 * The document draws this. A header row is ruled like any other, and the cell
 * holding "Screening Period" has borders that say precisely which visits sit
 * under it — no inference required. The rules that matter here are SHORT: they
 * cross the heading row only, and are skipped when the data columns are read
 * because a rule that does not run the height of the grid is not a column
 * boundary. Read for this row alone, they are exactly the boundaries wanted.
 *
 * Without this the span has to be guessed from where the ink falls, and a
 * heading centred over its group reaches columns it does not cover: Prot_000
 * showed "Screening Period" over five visits where the page rules it over two.
 */
function ruledSpans(values, bands, page, top, bottom) {
  const crossing = (page.rules?.verticals || [])
    .filter((v) => v.y0 <= top + 2 && v.y1 >= bottom - 2)
    .map((v) => v.x)
    .sort((a, b) => a - b);

  const edges = [];
  for (const x of crossing) if (!edges.length || x - edges[edges.length - 1] > 3) edges.push(x);
  // Fewer cells than headings means this row is not ruled into cells at all.
  if (edges.length < 3 || edges.length - 1 < values.size) return null;

  const spread = new Map();
  for (const value of values.values()) {
    const middle = (value.x0 + value.x1) / 2;
    const at = edges.findIndex((x, i) => i < edges.length - 1 && middle >= x && middle <= edges[i + 1]);
    if (at < 0) return null;
    for (const band of bands) {
      if (band.centre >= edges[at] && band.centre <= edges[at + 1]) spread.set(band.id, value);
    }
  }
  if (!spread.size) return null;

  values.clear();
  for (const [id, value] of spread) values.set(id, value);
  return [];
}

/**
 * A banding heading, applied to every column it bands.
 *
 * "Treatment Infusions" is printed once across four columns, so read literally
 * it names one and leaves three anonymous — which is how a schedule with a
 * perfectly clear header renders as "Treatment Infusions | Column 9 | Column 10
 * | Column 11". A heading row with far fewer values than there are columns is a
 * banding row, and a column belongs to the heading whose ink is drawn over it.
 *
 * Where no heading covers a column — the heading is centred and the column sits
 * in the gap between two of them — the nearest one is used and the caller is
 * told, because that part is inference and the document does not say it.
 */
function spanSparse(values, bands) {
  if (values.size < 2 || values.size >= bands.length) return [];
  /*
   * What makes a row a BANDING row rather than a row of timepoints.
   *
   * Counting headings against columns cannot tell them apart: protocol5 bands
   * eleven visits under seven phases, and protocol1 heads eight columns with
   * seven visit numbers because the study skips visit 6. Same shape, opposite
   * meaning — and filling the second one forward invents a visit.
   *
   * The difference is what the headings ARE. A phase is a word, drawn across
   * the columns it groups; a timepoint is a number sitting in one. So: ink
   * across two columns, or a heading long enough to be a name.
   */
  const covers = (value) => bands.filter((b) => b.centre >= value.x0 && b.centre <= value.x1).length;
  const banding = [...values.values()].some((value) => covers(value) >= 2 || clean(value.text).length >= 4);
  if (!banding) return [];
  const spans = [...values.values()].sort((a, b) => a.x0 - b.x0);
  const inferred = [];
  values.clear();
  for (const band of bands) {
    const covering = spans.find((s) => s.x0 <= band.centre && band.centre <= s.x1);
    if (covering) { values.set(band.id, covering); continue; }
    let nearest = null;
    let best = Infinity;
    for (const s of spans) {
      const gap = band.centre < s.x0 ? s.x0 - band.centre : band.centre - s.x1;
      if (gap < best) { best = gap; nearest = s; }
    }
    if (!nearest) continue;
    values.set(band.id, nearest);
    inferred.push(band.id);
  }
  return inferred;
}

/**
 * Values written as words across the grid, rather than as a mark per column.
 *
 * "Prior to Day 4" spanning the first three columns, "weekly x 2 weeks", "As
 * needed" — these are cell values, and the brief is explicit that values are
 * copied verbatim. Read as marks they are not marks, so they fall out of the
 * grid entirely: the row ends up with no cells at all and, having no cells, is
 * then filed as a category heading. Three of protocol9's assessments were
 * showing as empty rows for exactly this reason, with the value nowhere in the
 * output.
 *
 * A phrase is the run of words with no gap wider than a column, and it belongs
 * to every column its ink covers — which is what spanning means.
 */
function phrasesIn(lines, bands, pitch, labelRight, marks = []) {
  const runs = [];
  // Line by line, top to bottom. Sorting every word by x instead would read
  // "Weekly x 2" over "weeks" as "Weekly weeks x 2" — a value the page does not
  // contain — because the second line's word starts left of the first line's
  // last one. Reading order within a line, then lines in order, is the order a
  // person reads the cell in.
  for (const line of lines) {
    const here = [];
    for (const word of [...line].sort((a, b) => a.x - b.x)) {
      const last = here[here.length - 1];
      if (last && word.x - last.x1 <= pitch * 0.9) {
        last.text += ` ${word.text}`;
        last.x1 = Math.max(last.x1, word.x + word.w);
      } else {
        here.push({ text: word.text, x0: word.x, x1: word.x + word.w });
      }
    }
    for (const run of here) {
      // A run sitting under one already found continues it: the cell wrapped.
      const above = runs.find((r) => run.x0 <= r.x1 && run.x1 >= r.x0);
      if (above) {
        above.text += ` ${run.text}`;
        above.x0 = Math.min(above.x0, run.x0);
        above.x1 = Math.max(above.x1, run.x1);
      } else {
        runs.push(run);
      }
    }
  }

  const out = [];
  for (const run of runs) {
    const value = clean(run.text);
    if (!value || value.length > 60) continue;
    // A lone letter sitting just after a mark is that mark's superscript, drawn
    // far enough away that the superscript reader did not claim it — not a
    // value of its own. A lone letter standing clear of every mark IS a value:
    // protocol1 fills four cells with "P" for "practice only".
    if (value.length <= 2 && marks.some((m) => run.x0 - (m.x + m.w) > -1 && run.x0 - (m.x + m.w) < 10)) continue;
    // A long assessment name overruns the label column and its tail lands in
    // the grid — "Objective Opiate Withdrawal Scale (15)" is a row, not a value
    // written across the visits. What separates the two is the gap: a value is
    // set in its column, a name simply keeps going.
    if (labelRight != null && run.x0 - labelRight < pitch * 0.4) continue;
    /*
     * A merged cell is wider than the words printed in it.
     *
     * "Prior to Day 4" is set once, centred, across the three days of the
     * opiate agonist phase — but the ink is only as wide as the phrase, so
     * measuring the ink alone reaches days 1 and 2 and stops just short of day
     * 3. The output then says the assessment happens on two of the three days
     * the protocol gives, which is worse than saying nothing: it is a specific
     * claim, and it is wrong. Half a column either side is the tolerance for a
     * value that is centred in a cell whose borders are not in the text layer.
     */
    const reach = pitch * 0.5;
    let covered = bands.filter((b) => b.centre >= run.x0 - reach && b.centre <= run.x1 + reach);
    if (!covered.length) {
      const nearest = bands.reduce((best, b) => {
        const gap = Math.min(Math.abs(b.centre - run.x0), Math.abs(b.centre - run.x1));
        return !best || gap < best.gap ? { band: b, gap } : best;
      }, null);
      if (!nearest || nearest.gap > pitch) continue;
      covered = [nearest.band];
    }
    out.push({ value, bands: covered });
  }
  return out;
}

/**
 * Words set on their side, one letter per line.
 *
 * protocol12 and protocol15 both print "RANDOMIZATION" turned vertically
 * between the screening and treatment columns. Every letter is a separate drawn
 * item at the same x, so to a grid builder it looks like a column of one-letter
 * values — thirteen cells reading "R", "A", "N", "D"… Found here, on the page,
 * because by the time the letters have been sorted into cells the ones that
 * strayed near a mark are gone and the word can no longer be read.
 *
 * Repetition is what separates this from a real column of one-letter values: a
 * column of values says the same thing over and over — protocol1 writes "P" for
 * practice only, protocol5 "S" for serum — while a word does not.
 */
function verticalWords(page) {
  // Sorted on a ROUNDED centre. Letters in one vertical word sit at the same x
  // to within a rounding error, and comparing the raw floats makes that error
  // the sort key: the tie-break on y never runs, the letters come back in
  // scrambled order, and the run reads as thirteen separate single letters.
  const column = (w) => Math.round(centre(w));
  const singles = page.words
    .filter((w) => /^[A-Za-z]$/.test(clean(w.text)))
    .sort((a, b) => (column(a) - column(b)) || (a.y - b.y));

  const runs = [];
  for (const word of singles) {
    const last = runs[runs.length - 1];
    const stacked = last && Math.abs(centre(word) - last.x) <= 3
      && word.y >= last.bottom - 2 && word.y - last.bottom <= word.h * 2.5;
    if (stacked) {
      last.letters.push(word);
      last.bottom = word.y + word.h;
    } else {
      runs.push({ x: centre(word), letters: [word], bottom: word.y + word.h });
    }
  }

  return runs
    .filter((r) => r.letters.length >= 5
      && new Set(r.letters.map((w) => clean(w.text).toUpperCase())).size >= 4)
    .map((r) => ({ x: r.x, text: r.letters.map((w) => clean(w.text)).join('') }));
}

/**
 * The rows a ruled page draws, taken from the rules themselves.
 *
 * The other half of reading the vector layer. Rows built by clustering lines
 * have to guess where an assessment's name stops: a name too long for its
 * column wraps, and a wrapped line looks exactly like the next row's name. Every
 * guess is wrong somewhere — protocol1 runs four assessments together, protocol9
 * splits one in half — and the guess cannot be improved because the evidence is
 * not there. The horizontal rules ARE the row boundaries, and a name that wraps
 * inside one is a name that wraps, whatever it looks like.
 *
 * Returns entries shaped exactly like the inferred ones, so the caller cannot
 * tell which it got and nothing downstream has to know.
 */
function ruledRows(page, splitRows, gridLeft) {
  const rules = page.rules?.horizontals;
  if (!rules || rules.length < 4) return null;

  // Only rules that cross the grid: a rule under one cell is a cell border.
  const width = page.width - gridLeft;
  const spanning = rules
    .filter((h) => Math.min(h.x1, page.width) - Math.max(h.x0, gridLeft) >= width * 0.5)
    .map((h) => h.y)
    .sort((a, b) => a - b);

  const edges = [];
  for (const y of spanning) {
    if (!edges.length || y - edges[edges.length - 1] > 3) edges.push(y);
  }
  if (edges.length < 4) return null;

  const bands = [];
  for (let i = 1; i < edges.length; i++) bands.push({ top: edges[i - 1], bottom: edges[i], lines: [] });

  for (const row of splitRows) {
    const middle = (row.y + row.bottom) / 2;
    const band = bands.find((b) => middle >= b.top - 1 && middle < b.bottom + 1);
    if (band) band.lines.push(row);
  }

  const out = [];
  for (const band of bands) {
    if (!band.lines.length) continue;
    const lines = band.lines.sort((a, b) => a.y - b.y);
    const label = clean(lines.map((l) => l.label).filter(Boolean).join(' '));
    const marks = lines.flatMap((l) => l.marks);
    if (!label && !marks.length && !lines.some((l) => l.other.length)) continue;
    out.push({
      kind: marks.length ? 'assessment' : 'label-only',
      label,
      y: lines[0].y,
      marks,
      lines,
    });
  }
  // The extent is returned with the rows so the caller can compare like with
  // like: marks printed above the first rule or below the last are outside the
  // ruled table, and counting them against it would fail every page for
  // content it was never asked about.
  return out.length >= 3
    ? { entries: out, top: edges[0], bottom: edges[edges.length - 1] }
    : null;
}

/**
 * Header lines: everything above the first marked row that describes columns.
 *
 * Kept per column rather than flattened, so "Screening / Visit 2 / Day -14 /
 * ±3 days" survives as four facts about one visit instead of one run-on string.
 */
/**
 * What a header row's caption says it is telling you about the columns.
 *
 * The caption is read first and only then the whole line: "ACTIVITY WEEK -2 0 2"
 * is a week row whose caption begins with the word the activity column is titled
 * with, and only the first two words are searched, because "Allowed window for
 * visit (days)" ends in the word "days" and would otherwise be filed as a second,
 * competing day row.
 */
function roleOf(label, text) {
  const head = clean(label).split(/\s+/).slice(0, 2).join(' ');
  for (const [pattern, name] of HEADER_ROLES) {
    const anywhere = new RegExp(pattern.source.replace(/^\^/, '\\b'), 'i');
    if (anywhere.test(head)) return name;
  }
  for (const [pattern, name] of HEADER_ROLES) if (pattern.test(text || '')) return name;
  return null;
}

function readHeader(rows, bands, firstDataY, page) {
  const pitch = bands.length > 1
    ? (bands[bands.length - 1].centre - bands[0].centre) / (bands.length - 1) : 40;

  // Which ruled cell of the header block a line falls in, where the page rules
  // one. Null when the header is not ruled, which turns the grouping below back
  // into the line-by-line reading.
  const edges = [...new Set((page?.rules?.horizontals || [])
    .filter((h) => h.y < firstDataY + 2).map((h) => Math.round(h.y)))].sort((a, b) => a - b);
  const cellOf = (y) => {
    if (edges.length < 3) return null;
    const at = edges.findIndex((e, i) => i < edges.length - 1 && y >= e - 2 && y < edges[i + 1] - 2);
    return at < 0 ? null : at;
  };

  const header = [];
  for (const row of rows) {
    if (row.y >= firstDataY) break;
    const cells = [...row.marks, ...row.other].filter((w) => columnFor(w, bands));
    if (!cells.length) continue;
    // The running head is above the table, not part of it. "TJ301 Protocol
    // No.: CTJ301UC201 Date: 16 May 2017" spreads across the page like a
    // header row and was being banded over the columns as though it named
    // them.
    if (PAGE_FURNITURE.test(row.text || '')) continue;

    // The left-hand text of a header line counts as that line's caption only
    // when it names a dimension. The table's own title is frequently set INSIDE
    // the activity column, wrapping down the left of the page while the phase
    // headings wrap down the right of the same lines — protocol9 prints "Table
    // 4. / Schedule of Measures and Data / Collection for Lofexidine Phase 3"
    // beside "Opiate Agonist Phase / Detoxification: … / Post Med/Detox Phase".
    // Read as captions, those three lines break one banding row into three and
    // the phases end up spread over the wrong columns.
    const label = namesDimension(row.label) ? row.label : '';

    /*
     * Lines inside one ruled cell are one header row, whatever they look like.
     *
     * Prot_000 sets its visit column as "Visit 0" over "Stabilization" — two
     * lines, and the caption "Visits" is on the SECOND of them. Read line by
     * line, the first has no caption and is taken as the wrap of the window row
     * above it, so "Visit 0" and "Visit 1.1" end up filed as visit windows and
     * the row that names the visits is left describing nothing. The page draws a
     * cell around all three lines and says they are one row.
     */
    const previous = header[header.length - 1];
    const cell = cellOf(row.y);
    const sameCell = previous && cell !== null && cell === previous.cell;

    if (sameCell || (!label && previous && cell === null)) {
      // Inside a ruled cell the column is already known, so the second line of
      // a heading goes to its own column rather than to whichever value it
      // happens to sit nearest. Proximity is for unruled pages, where a heading
      // too wide for its column wraps under its neighbour and the nearest
      // heading is the only evidence of which one it continues.
      if (sameCell && bands[0]?.ruled) placeCells(previous.values, cells, bands, (a, b) => `${a} ${b}`);
      else continueHeading(previous.values, cells, bands, pitch);
      previous.bottom = Math.max(previous.bottom, row.bottom);
      // The caption may arrive on a later line of the same cell.
      if (label && !previous.label) {
        previous.label = label;
        previous.role = roleOf(label, row.text);
      }
      continue;
    }

    // One stray word above the grid — a title, a page number — is not a header
    // row. A header row says something about several columns at once.
    if (new Set(cells.map((w) => columnFor(w, bands).id)).size < 2) continue;

    // The dimension is not always the first word of the caption: "ACTIVITY WEEK
    // -2 -.3 0 2" is a week row whose caption begins with the word the activity
    // column is titled with. Read as a name row it takes the visitName slot, the
    // weeks are demoted to an unnamed grouping, and the schedule loses its
    // timepoints. So the caption is searched, and only then the whole line.
    // Searched over the same first two words as the caption test, and for the
    // same reason. "Allowed window for visit (days)" is a window row; read to
    // the end of the caption it matches "day" first — days come before windows
    // in the role list — and it is filed as a second, competing day row.
    const role = roleOf(label, row.text);
    const entry = {
      role, label, y: row.y, top: row.y, bottom: row.bottom, cell: cellOf(row.y), values: new Map(),
    };
    placeCells(entry.values, cells, bands, (a, b) => `${a} ${b}`);
    // "VISIT 1 2 3 4" names visits by number, whatever the caption calls them.
    if (role === 'visitName' && [...entry.values.values()].every((v) => /^\d{1,3}[a-z]?$/i.test(v.text))) {
      entry.role = 'visitNumber';
    }
    header.push(entry);
  }
  const inferred = new Set();
  for (const entry of header) {
    // The drawn cell first, the inference only where the row is not ruled.
    const ruled = ruledSpans(entry.values, bands, page, entry.top, entry.bottom);
    if (ruled) continue;
    for (const id of spanSparse(entry.values, bands)) inferred.add(id);
  }
  return { header, inferred: [...inferred] };
}

/**
 * Page furniture: a running header or footer, not part of any footnote.
 *
 * These sit below the footnote block and would otherwise be absorbed as
 * continuation text, appending a copyright line to a clinical instruction.
 * Recognised by what they are made of — a page number, a version stamp, a
 * copyright — rather than by where they sit, because sponsors put them at
 * different heights.
 */
const PAGE_FURNITURE = /(?:^|\s)(?:page\s+\d{1,4}\s*$|copyright|©\s*\d{4}|version\s*(?:no\.?|number)?\s*[:.]?\s*\d|confidential|clinical\s+study\s+protocol|protocol\s+(?:no\.?|number)\s*[:.]?)/i;

/** Footnote definitions on a page, including lines that continue one. */
export function readFootnotes(page, fromY = 0, plausible = null) {
  const found = [];
  let current = null;
  for (const line of page.lines) {
    if (line.y < fromY) continue;
    const text = clean(line.text);
    if (!text) continue;
    const m = FOOTNOTE_DEF.exec(text);
    // A short line that starts with a marker begins a footnote; anything else
    // that follows one continues it. Continuations are the failure the brief
    // singles out, and they carry no marker of their own by definition.
    // A line begins a new footnote only when its marker is one the grid
    // actually uses, or a legend symbol. Without that test, an ordinary wrapped
    // line — "be recorded at each visit", "to resolution" — reads as a new
    // footnote called "be", which both invents a footnote and truncates the one
    // it was continuing. The document's own markers are the only authority on
    // what a marker looks like in this document.
    const marker = m ? clean(m.groups.sym || m.groups.marker).replace(/[().:=-]+$/, '') : '';
    // How the document prints it. "X a – Blood is collected..." is footnote "a"
    // written on an X, and the reader looking for it in the grid is looking for
    // "Xa" — so that is what gets shown, while `marker` stays the thing that
    // matches cells.
    const printed = m && m.groups.on ? clean(m.groups.on) + marker : marker;
    const key = marker.toLowerCase();
    // "Xa" in the footnote list is the marker "a" printed on an X in the grid,
    // so both spellings count as the same marker.
    const bare = key.replace(/^x/, '');
    const believable = m && (
      !plausible
      || plausible.has(key) || (bare && plausible.has(bare))
      || LEGEND_MARK.test(marker)
      // A single character is the ordinary shape of a footnote marker. Two
      // letters is the shape of a word, and "be recorded..." is not a footnote.
      || /^[a-z0-9]$/i.test(marker)
    );
    if (m && believable && text.length > 3) {
      if (current) found.push(current);
      current = {
        marker,
        printed,
        text: clean(m.groups.text),
        page: page.number,
        continued: false,
      };
    } else if (current) {
      // The block has ended if this line is page furniture; everything after it
      // belongs to the page, not to the footnote.
      if (PAGE_FURNITURE.test(text)) { found.push(current); current = null; continue; }
      current.text = `${current.text} ${text}`.trim();
    }
  }
  if (current) found.push(current);
  return found;
}

/**
 * Markers carried by a cell value.
 *
 * Read off the value itself — "Xa", "X b", "1X(13)" — because that is where the
 * document puts them. Only markers the page actually defines are accepted, so a
 * value like "3X/2 weeks" does not turn its own letters into footnote links.
 */
function markersIn(value, known) {
  const markers = [];
  for (const marker of known) {
    if (!marker) continue;
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`^[Xx✓●•]\\s*${escaped}$`),      // Xa
      new RegExp(`^${escaped}$`),                   // a
      new RegExp(`\\(${escaped}\\)`),               // (a)
      new RegExp(`[Xx0-9]\\s*${escaped}\\b`),       // 1X a
    ];
    if (patterns.some((p) => p.test(value))) markers.push(marker);
  }
  return markers;
}

/**
 * Extract one table from a run of pages.
 *
 * Pages are stitched, not concatenated: a continuation page repeats or
 * abbreviates the header and its rows are the same rows, so the second page's
 * columns are appended and its cells attach to the rows already found by label.
 */
export function extractTable(pages, { title = '' } = {}) {
  const ambiguities = [];
  const unnamed = [];
  const footnotePages = [];
  const verticals = [];
  // Whether EVERY page's rows came from the drawn grid. A later pass may only
  // trust these row boundaries if none of them were inferred.
  let rowsAreRuled = true;
  const allFootnotes = [];
  const columns = [];
  const rowsByLabel = new Map();
  const rowOrder = [];
  const pageNumbers = [];

  for (const page of pages) {
    pageNumbers.push(page.number);
    for (const word of verticalWords(page)) verticals.push({ page: page.number, word });
    const { gridLeft, rows } = splitLines(page);
    if (gridLeft === null) {
      // No grid here. It may still be the page the footnotes spilled onto.
      footnotePages.push({ page, fromY: 0, spilled: true });
      continue;
    }

    /*
     * The drawn rows where the page draws them, but never at a cost.
     *
     * A better source of structure is still a change, and a change that loses a
     * mark has made the output worse however sound its reasoning. So both
     * readings are built and the ruled one is taken only if it accounts for
     * every mark the inferred one did. It cannot quietly drop a row's contents
     * to make the boundaries tidy; if it would, the inferred reading stands and
     * the page says so.
     */
    const byLines = assembleRows(rows);
    const drawn = ruledRows(page, rows, gridLeft);

    let assembled = byLines;
    if (!drawn) rowsAreRuled = false;
    if (drawn) {
      const inside = (e) => e.y >= drawn.top - 2 && e.y <= drawn.bottom + 2;
      const marksIn = (list) => list.filter(inside).reduce((n, e) => n + e.marks.length, 0);
      const kept = marksIn(drawn.entries);
      const had = marksIn(byLines);
      if (kept >= had) {
        assembled = drawn.entries;
      } else {
        rowsAreRuled = false;
        ambiguities.push(`Page ${page.number}: the ruled row boundaries account for ${kept} of the ${had} marks `
          + 'found by reading the lines, so the rules were not used for rows on this page.');
      }
    }
    /*
     * "VISIT 1 2 3 4" is a header, not an assessment performed at four visits.
     *
     * This test is deliberately only used to decide where the COLUMNS are. It
     * over-reaches — "Psychiatric Assessment (SCID, Axis I, DSM IV)" is a real
     * assessment whose name happens to contain a word the captions use — and
     * excluding such a row here costs nothing, because its marks are read from
     * the same bands as every other row's. Using the test to decide what is a
     * ROW is what cost protocol9 its "Prior to Day 4" values, and it no longer
     * does that.
     */
    const dataRows = assembled.filter((r) => r.marks.length && !namesDimension(r.label));
    if (!dataRows.length) continue;

    // The drawn grid where the page draws one, the marks where it does not.
    // Not all schedules are ruled — some are set entirely in whitespace — so
    // the inference stays as the fallback rather than being replaced.
    const bands = ruledBands(page, dataRows, gridLeft) || columnBands(dataRows, page.width);
    if (bands.length < 2) {
      ambiguities.push(`Page ${page.number}: marks found but no column structure could be resolved; the page was skipped.`);
      continue;
    }

    /*
     * A page that announces a different table is a different table.
     *
     * protocol5 ends its schedule on page 50 and starts "APPENDIX II: Schedule
     * of Blood Collections" on page 51. Read as a continuation its fifteen
     * columns are appended to the eleven above, and the output becomes a
     * twenty-five-column table that exists in no document.
     *
     * Comparing the two grids geometrically was tried and is wrong: a genuine
     * continuation page reprints the same columns in DIFFERENT places, because
     * it holds a different span of visits — protocol1's second page shifts
     * every rule — so position cannot tell a continuation from a new table. The
     * document says which it is, in the caption, and that is what is read.
     *
     * The page's footnotes are still taken, because a schedule's footnotes are
     * frequently printed under whatever comes after it.
     */
    const startsAnother = columns.length && page.lines.slice(0, 14).some((line) => {
      const text = clean(line.text);
      if (!NEW_TABLE.test(text) || /continued/i.test(text)) return false;
      return labelKey(text).slice(0, 24) !== labelKey(title).slice(0, 24);
    });
    if (startsAnother) {
      ambiguities.push(`Page ${page.number} carries the caption of a different table, so its grid has not been `
        + 'appended to this schedule. Only the footnotes printed on the page have been read.');
      footnotePages.push({ page, fromY: 0, spilled: true });
      continue;
    }

    const firstDataY = dataRows[0].y;
    // Measured over every marked row, not just the ones the column-finding pass
    // kept. A row excluded there for what it is CALLED is still a row, and when
    // it is the last one on the page — as "Adverse events" is — a window drawn
    // without it cuts it off and the row is lost.
    const marked = assembled.filter((r) => r.marks.length);
    const lastDataBottom = Math.max(...marked.flatMap((r) => r.lines.map((l) => l.bottom)));
    const { header, inferred } = readHeader(rows, bands, firstDataY, page);
    if (inferred.length) {
      ambiguities.push(`Page ${page.number}: ${inferred.length} column(s) sit between two banding headings rather than under either. `
        + `They were given the nearer heading, which the page does not state.`);
    }

    // Columns for this page, described by whatever the header rows say.
    const pageColumns = bands.map((band, i) => {
      const facts = {};
      const path = [];
      for (const h of header) {
        const value = h.values.get(band.id)?.text;
        if (!value) continue;
        if (h.role && !facts[h.role]) facts[h.role] = value;
        else path.push(value);
      }
      // The study phase is the grouping above the column, which is what `path`
      // is for — and where no row names the visits, it is also the best name
      // the document gives them.
      if (facts.period) path.unshift(facts.period);

      return {
        id: `p${page.number}c${i + 1}`,
        label: facts.visitName || facts.visitNumber || facts.period || path[0] || `Column ${i + 1}`,
        path,
        visitNumber: facts.visitNumber || null,
        studyDay: facts.studyDay || null,
        studyWeek: facts.studyWeek || null,
        window: facts.window || null,
        page: page.number,
        pageWidth: page.width,
        centre: Math.round(band.centre * 10) / 10,
        pitch: bands.length > 1 ? Math.round((bands[bands.length - 1].centre - bands[0].centre) / (bands.length - 1)) : 30,
        _band: band,
      };
    });

    // A blank column in the printed grid is a real thing and is not invented
    // away — but it is also not turned into a visit that does not exist.
    for (let i = 1; i < pageColumns.length; i++) {
      const gap = pageColumns[i]._band.left - pageColumns[i - 1]._band.right;
      const typical = pageColumns[1]._band.centre - pageColumns[0]._band.centre;
      if (typical > 0 && gap > typical * 1.6) {
        ambiguities.push(
          `Page ${page.number}: an unusually wide gap sits between column "${pageColumns[i - 1].label}" and "${pageColumns[i].label}". `
          + 'The printed table may contain a blank spacer column; no visit has been invented for it.',
        );
      }
    }
    // A continuation page usually reprints the SAME visits, not new ones.
    // Appending them blindly turns an eleven-visit schedule into forty-one
    // columns — a fabricated study four times the size of the real one. So a
    // column is matched to one already found by what the header calls it; only
    // genuinely new visits are appended.
    for (const column of pageColumns) {
      const key = columnKey(column);
      // Never against a column from the SAME page. Two bands side by side are
      // two columns by construction, whatever their headers happen to say — and
      // a header can say the same thing twice, because a phase heading is
      // carried across the visits it bands. Matching on the header alone folded
      // a divider into its neighbour and lost a column that is plainly drawn.
      let existing = key ? columns.find((c) => c.page !== column.page && columnKey(c) === key) : null;
      if (!key) {
        unnamed.push(column);
        // Fall back to geometry, but only against a page of the same width and
        // only for columns that are themselves unidentified — so a page whose
        // header DOES name its visits is never overridden by position.
        existing = columns.find((c) => c.page !== column.page
          && c.pageWidth === column.pageWidth
          && !columnKey(c)
          && Math.abs(c.centre - column.centre) <= column.pitch * 0.5);
      }
      if (existing) {
        column.id = existing.id;
        existing.pages = [...new Set([...(existing.pages || [existing.page]), column.page])];
      } else {
        columns.push(column);
      }
    }

    // Rows, attaching cells to the columns of this page.
    let lastCategory = null;
    for (const entry of assembled) {
      if (HEADER_LABEL.test(entry.label || '') && entry.marks.length) continue;
      if (entry.y < firstDataY - 2 || entry.y > lastDataBottom + 2) continue;
      // Words in the grid that are not marks may still be the row's values.
      const pitch = bands.length > 1
        ? (bands[bands.length - 1].centre - bands[0].centre) / (bands.length - 1) : 40;
      const labelWords = entry.lines.flatMap((l) => l.labelWords || []);
      const labelRight = labelWords.length ? Math.max(...labelWords.map((w) => w.x + w.w)) : null;
      // A phrase is only a value when there is a row for it to be a value OF,
      // and when it is not the sponsor's name running along the foot of the
      // page. Without a label to measure the gap from, there is no way to tell
      // a spanning value from a row label that simply starts inside the grid,
      // so nothing is claimed.
      const spans = !entry.label
        ? []
        : phrasesIn(entry.lines.map((l) => l.other || []).filter((w) => w.length), bands, pitch, labelRight, entry.marks)
          .filter((s) => !PAGE_FURNITURE.test(s.value));

      if (!entry.marks.length && !spans.length) {
        if (findRow(rowsByLabel, entry.label)) continue; // already a row elsewhere
        // A label with nothing under it, that was not absorbed as a wrap.
        lastCategory = entry.label;
        if (!rowsByLabel.has(labelKey(entry.label))) {
          const row = { id: `r${rowOrder.length + 1}`, kind: 'category', label: entry.label, category: null, cells: [], markers: [] };
          rowsByLabel.set(labelKey(entry.label), row);
          rowOrder.push(row);
        }
        continue;
      }
      let row = findRow(rowsByLabel, entry.label);
      if (!row) {
        row = { id: `r${rowOrder.length + 1}`, kind: 'assessment', label: entry.label, category: lastCategory, cells: [], markers: [] };
        rowsByLabel.set(labelKey(entry.label), row);
        rowOrder.push(row);
      }
      // Everything on this row that is not itself a mark: a superscript marker
      // hides among these.
      const loose = entry.lines.flatMap((l) => l.other || []);
      for (const word of entry.marks) {
        const band = columnFor(word, bands);
        if (!band) continue;
        const column = pageColumns.find((c) => c._band === band);
        if (!column) continue;
        // The marker is kept BESIDE the value, not glued onto it. A cell
        // printed as "3X/week" with a superscript d is a "3X/week" cell that
        // footnote d qualifies — storing "3X/weekd" is neither the value the
        // page shows nor a marker anything can be linked to, so the footnote
        // has nothing to highlight and the value is not verbatim.
        const suffix = superscriptAfter(word, loose);
        row.cells.push({
          col: column.id,
          value: clean(word.text),
          ...(suffix ? { markers: [suffix] } : {}),
        });
      }

      // A spanning value belongs to every visit it is written over. It is
      // repeated per column rather than merged, because the schema says what is
      // true of each visit and a consumer reading one column must not have to
      // know that the answer was printed across its neighbour.
      for (const span of spans) {
        for (const band of span.bands) {
          const column = pageColumns.find((c) => c._band === band);
          if (!column || row.cells.some((c) => c.col === column.id)) continue;
          row.cells.push({ col: column.id, value: span.value });
        }
      }
    }

    // Footnotes printed under this page's grid.
    const lastRowY = Math.max(...dataRows.map((r) => r.y));
    footnotePages.push({ page, fromY: lastRowY + 1, spilled: false });
  }

  // Markers the document actually printed on its cells and row labels.
  const plausible = new Set();
  const TRAILING = /(?:^|[Xx0-9)s])([a-z]{1,2}|[*†‡§¶#]{1,3})$/;
  for (const row of rowOrder) {
    const fromLabel = TRAILING.exec(clean(row.label));
    if (fromLabel) plausible.add(fromLabel[1].toLowerCase());
    for (const cell of row.cells) {
      for (const marker of cell.markers || []) plausible.add(marker.toLowerCase());
      const fromCell = TRAILING.exec(clean(cell.value));
      if (fromCell) plausible.add(fromCell[1].toLowerCase());
    }
  }
  // Markers are unique within a table: "a, b, c" then "a" again is a second
  // list, not a second footnote a. That is how a numbered narrative section on
  // the page after the schedule gets read as forty more footnotes. Once a
  // marker repeats, the footnote block has ended and the rest is prose.
  const claimed = new Set();
  for (const { page, fromY, spilled } of footnotePages) {
    for (const f of readFootnotes(page, fromY, plausible)) {
      const key = f.marker.toLowerCase();
      if (claimed.has(key)) {
        // Not a footnote — but it may be the continuation of the last one.
        const previous = allFootnotes[allFootnotes.length - 1];
        if (previous && previous.page === f.page) previous.text = `${previous.text} ${f.marker} ${f.text}`.trim();
        continue;
      }
      claimed.add(key);
      if (spilled) f.continued = true;
      allFootnotes.push(f);
    }
  }

  // A repeated header means repeated footnotes: the same definition printed
  // under each page of the table is one footnote, not several.
  const seenFootnotes = new Map();
  for (const f of allFootnotes) {
    const key = `${f.marker}::${f.text.slice(0, 60).toLowerCase()}`;
    const existing = seenFootnotes.get(key);
    if (existing) {
      if (f.text.length > existing.text.length) existing.text = f.text;
      existing.pages = [...new Set([...(existing.pages || [existing.page]), f.page])];
    } else {
      f.pages = [f.page];
      seenFootnotes.set(key, f);
    }
  }
  allFootnotes.length = 0;
  allFootnotes.push(...seenFootnotes.values());

  // Link markers now that every footnote is known.
  // "X = Performed at this visit" is a legend for the whole table, not a marker
  // sitting on one cell. Linking it would put a footnote on every mark in the
  // grid and bury the markers that actually qualify something.
  /*
   * A drawn column that says nothing.
   *
   * Reading the rules means reading every column the sponsor ruled, including
   * ones the study does not use: protocol1 numbers its visits 1 2 3 4 5 7 8 and
   * still draws a cell where visit 6 would be. That column has no heading and
   * nothing in it on any row, so reporting it adds a visit to the schedule that
   * the protocol does not have. It is recorded instead, because a reader
   * checking against the page will see it and should not think we missed it.
   */
  for (let i = columns.length - 1; i >= 0; i--) {
    const column = columns[i];
    // Only where the page drew the column: an inferred one is only there
    // because something was in it, so this cannot apply.
    if (!column._band?.ruled) continue;
    const named = column.visitNumber || column.studyDay || column.studyWeek
      || (column.label && !/^column \d+$/i.test(column.label));
    if (named || rowOrder.some((r) => r.cells.some((c) => c.col === column.id))) continue;
    ambiguities.push(`Page ${column.page} rules a column at x≈${Math.round(column.centre)} that carries no heading `
      + 'and no marks on any row. It has been left out rather than reported as a visit.');
    columns.splice(i, 1);
  }

  // A tick is a value wherever it appears; only letters that are not the
  // table's own marks can belong to a word set on its side.
  const LETTER = /^(?![x✓✔●•◆■]$)[A-Za-z]$/i;
  for (const { page, word } of verticals) {
    // The column the letters were sorted into: the nearest one on that page.
    const column = columns
      .filter((c) => c.page === page)
      .reduce((best, c) => (!best || Math.abs(c.centre - word.x) < Math.abs(best.centre - word.x) ? c : best), null);
    if (!column || Math.abs(column.centre - word.x) > 40) continue;

    /*
     * A divider holds nothing, so nothing is left in it.
     *
     * Dropping only its letters was not enough. A value written as words is
     * given to every column its ink covers, and "3X/week" set in the screening
     * column reaches far enough to be handed to the rule beside it as well —
     * so ten rows of protocol12 gained a second copy of their value, filed
     * under a column that is a line between two phases. The copies were
     * duplicates of a cell already recorded correctly next door, which is the
     * only reason this is safe: a divider is a boundary, and a schedule does
     * not perform an assessment inside one.
     */
    for (const row of rowOrder) {
      row.cells = row.cells.filter((c) => c.col !== column.id);
    }
    // The word printed down it IS its name. Whatever the banding above put
    // there — it inherits the phase heading it happens to sit under — says less
    // than "RANDOMIZATION" does about what this column is.
    column.label = word.text;
    // Marked so a consumer counting visits can leave it out: it divides the
    // schedule, it is not a timepoint anything happens at.
    column.divider = true;
    column.dividerLabel = word.text;
    ambiguities.push(`"${word.text}" is printed vertically down the column at x≈${Math.round(word.x)} on page ${page}. `
      + 'Its letters are not cell values, and the column divides the schedule rather than naming a visit.');
  }

  const LEGEND = /^[x✓✔●•◆■]$/i;
  const known = [...new Set(allFootnotes.map((f) => f.marker))].filter((m) => !LEGEND.test(m));
  for (const row of rowOrder) {
    row.markers = markersIn(row.label, known);
    for (const cell of row.cells) {
      // A marker set after a written-out value arrives as the last word of the
      // phrase: "Weekly i" is a "Weekly" cell that footnote i qualifies. Split
      // only when the tail is a marker this document actually defines, so a
      // real value ending in a letter is left alone.
      const tail = /^(.*\S)\s+([a-z]|[*†‡§¶#]{1,3})$/i.exec(cell.value);
      if (tail && tail[1].length > 1 && known.includes(tail[2].toLowerCase())) {
        cell.value = tail[1];
        cell.markers = [...(cell.markers || []), tail[2].toLowerCase()];
      }
      // Markers already read off the page as superscripts are kept; the value
      // is searched only for the ones printed inside it, such as "(a)".
      const markers = [...new Set([...(cell.markers || []), ...markersIn(cell.value, known)])]
        .filter((m) => known.includes(m));
      if (markers.length) cell.markers = markers; else delete cell.markers;
    }
  }
  for (const footnote of allFootnotes) {
    footnote.appliesTo = [];
    for (const row of rowOrder) {
      if (row.markers.includes(footnote.marker)) footnote.appliesTo.push({ target: 'row', row: row.id });
      for (const cell of row.cells) {
        if (cell.markers && cell.markers.includes(footnote.marker)) {
          footnote.appliesTo.push({ target: 'cell', row: row.id, col: cell.col });
        }
      }
    }
    if (!footnote.appliesTo.length) footnote.appliesTo.push({ target: 'table' });
  }

  // Columns whose header could not be read cannot be recognised on a later
  // page, so a schedule spread over several pages may report the same visit
  // more than once. Saying so is the point: a reader can see the count is wrong
  // where a silently merged table would look plausible and be false.
  if (unnamed.length) {
    ambiguities.push(
      `${unnamed.length} column(s) carry no readable visit number, day or week in the printed header `
      + '(pages ' + [...new Set(unnamed.map((c) => c.page))].join(', ') + '). '
      + 'Those columns could not be matched against the same visit on another page, so a table that '
      + 'spans pages may list a visit more than once. The cells under them are still verbatim.',
    );
  }

  // A row may only hold one value per column. Duplicates come from a wrapped
  // label whose lines both fell inside the row, and they read as the assessment
  // happening twice at one visit.
  for (const row of rowOrder) {
    const seen = new Set();
    row.cells = row.cells.filter((c) => (seen.has(c.col) ? false : seen.add(c.col)));
  }

  // A band that ended up with no cells and no timepoint fact is not a visit —
  // it is a gap in the printed grid that happened to attract a stray mark, or a
  // vertical divider. Reporting it inflates the column count.
  const used = new Set();
  for (const row of rowOrder) for (const cell of row.cells) used.add(cell.col);
  const before = columns.length;
  const kept = columns.filter((c) => used.has(c.id)
    || c.visitNumber || c.studyDay || c.studyWeek || c.window
    || (c.label && !/^Column d+$/.test(c.label)));
  if (kept.length !== before) {
    ambiguities.push(`${before - kept.length} empty column(s) were detected in the grid and dropped: `
      + 'they carried no cells and no visit number, day, week or window. If the printed table has a '
      + 'column there, it holds nothing this reader could see.');
    columns.length = 0;
    columns.push(...kept);
  }

  for (const column of columns) delete column._band;

  return {
    title: title || null,
    pages: pageNumbers,
    columns,
    rows: rowOrder,
    footnotes: allFootnotes,
    ambiguities,
    // True only when every page's rows came from the drawn grid. A row boundary
    // that was inferred is a guess, and a later pass that treats these labels
    // as authoritative must know the difference.
    rowsAreRuled,
  };
}
