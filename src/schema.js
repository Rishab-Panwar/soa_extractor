/*
 * schema.js — one shape, whichever path produced it.
 *
 * A table read geometrically and a table reviewed by the model arrive with
 * different field names for the same fact: the rule-based path carries the
 * period grouping as `path`, the review calls it `period`. Left alone, the
 * output shape depends on which path happened to run, so anyone consuming this
 * has to write two parsers and discover the difference by hitting it. The
 * schema is a promise to the consumer, and it cannot be conditional on how the
 * answer was reached.
 *
 * This also strips the working fields the extractor needs and nobody else does
 * — band centres, column pitch, page widths. They are how the grid was found,
 * not part of what was found.
 */

/** Normalise one column to the published shape. */
function column(raw, index) {
  // `path` is the grouping above this column — a study period banding such as
  // "Screening" or "Treatment". Both paths mean the same thing by it.
  const path = Array.isArray(raw.path)
    ? raw.path.filter(Boolean)
    : (raw.period ? [raw.period] : []);

  return {
    id: raw.id || `c${index + 1}`,
    label: raw.label ?? '',
    path,
    visitNumber: raw.visitNumber ?? null,
    studyDay: raw.studyDay ?? null,
    studyWeek: raw.studyWeek ?? null,
    window: raw.window ?? null,
    // Footnote markers printed on the column's own heading, so a footnote that
    // qualifies a whole visit is linked to it rather than to nothing.
    markers: raw.markers && raw.markers.length ? raw.markers : [],
    // A column that divides the schedule rather than naming a visit — the
    // "RANDOMIZATION" rule these protocols print on its side between phases.
    // A consumer counting visits needs to be able to leave it out.
    ...(raw.divider ? { divider: true } : {}),
    pages: raw.pages || (raw.page ? [raw.page] : []),
  };
}

/** Normalise one row, keeping cells sparse and values untouched. */
function row(raw, index) {
  return {
    id: raw.id || `r${index + 1}`,
    kind: raw.kind === 'category' ? 'category' : 'assessment',
    label: raw.label ?? '',
    category: raw.category ?? null,
    markers: raw.markers && raw.markers.length ? raw.markers : [],
    cells: (raw.cells || []).map((cell) => ({
      col: cell.col,
      value: cell.value,
      ...(cell.markers && cell.markers.length ? { markers: cell.markers } : {}),
    })),
  };
}

/**
 * Normalise one footnote, keeping its linkage.
 *
 * `continued` means this footnote's own text runs across a page break — the
 * case the brief asks about. It does NOT mean the footnote is printed on a
 * later page than the table begins on: footnote blocks are normally printed
 * under the LAST page of the table, so reading it that way marked all ten of
 * protocol5's footnotes "continued from an earlier page" — untrue, and noisy
 * enough to bury the cases that are real.
 */
export function footnote(raw) {
  const pages = raw.pages || (raw.page ? [raw.page] : []);
  const spilled = pages.length > 1;
  const marker = raw.marker ?? '';
  // A footnote that qualifies cells is one thing; an abbreviation line printed
  // in the same block is another. Separating them is how a reader can see which
  // notes change the meaning of a mark and which merely expand an acronym.
  const linked = (raw.appliesTo || []).some((t) => t.target !== 'table');
  // A note, not a footnote, when nothing in the grid carries its marker AND the
  // marker is not the kind of thing a cell carries: a word ("Detox", "SCID"),
  // or one of the symbols a schedule uses as its legend rather than as a
  // reference. protocol9's bulleted general note reads as a footnote pointing
  // at nothing, which looks like a failure to link it; it is a note about the
  // table, and saying so is both truer and less alarming.
  const isNote = !linked
    && (/^[a-z][a-z0-9 /-]{1,}$/i.test(marker) || /^[x✓✔●•◆■]$/i.test(marker));
  return {
    marker,
    // How the document prints it, when that differs — "Xa" for footnote "a".
    printed: raw.printed || marker,
    kind: isNote ? 'note' : 'footnote',
    text: raw.text ?? '',
    pages,
    continued: Boolean(raw.continued) || spilled,
    appliesTo: raw.appliesTo && raw.appliesTo.length ? raw.appliesTo : [{ target: 'table' }],
  };
}

/**
 * One marker, one footnote.
 *
 * A marker identifies exactly one note by definition, so two entries sharing
 * one are a split: a wrapped line read as a new definition. Joining them keeps
 * the text — the thing the brief grades — rather than discarding either half.
 */
function dedupeFootnotes(list) {
  const byMarker = new Map();
  for (const f of list) {
    const key = f.marker.toLowerCase();
    const seen = byMarker.get(key);
    if (!seen) { byMarker.set(key, f); continue; }
    if (!seen.text.includes(f.text)) seen.text = `${seen.text} ${f.text}`.trim();
    seen.pages = [...new Set([...seen.pages, ...f.pages])];
    seen.appliesTo = seen.appliesTo.concat(f.appliesTo.filter((t) => t.target !== 'table'));
  }
  return [...byMarker.values()];
}

/**
 * The published form of one table.
 *
 * `provenance` is deliberately part of the output rather than hidden: a reader
 * is entitled to know whether a table was read by rule or reviewed by a model,
 * what the rule-based pass had said, and why it was not trusted.
 */
export function normalise(table) {
  return {
    id: table.id,
    title: table.title || null,
    pages: table.pages || [],
    columns: (table.columns || []).map(column),
    rows: (table.rows || []).map(row),
    footnotes: dedupeFootnotes((table.footnotes || []).map(footnote)),
    ambiguities: table.ambiguities || [],
    provenance: {
      readBy: table.source === 'second-opinion' ? 'review' : 'geometry',
      model: table.model || null,
      confidence: table.assessment?.confidence ?? null,
      verdict: table.assessment?.verdict ?? null,
      findings: (table.assessment?.findings || []).map((f) => ({
        check: f.check, severity: f.severity, detail: f.detail,
      })),
      // Whether the rows came from lines the document draws or from clustering
      // the text. Published because it is the difference between a measured row
      // boundary and a guessed one, and a reader deciding how far to trust the
      // row labels is entitled to know which they have.
      rowsAreRuled: Boolean(table.rowsAreRuled),
      // What the rule-based pass produced, when a review replaced it.
      geometric: table.geometric || null,
      locatorScore: table.locatorScore ?? null,
      locatorEvidence: table.locatorEvidence || [],
    },
  };
}
