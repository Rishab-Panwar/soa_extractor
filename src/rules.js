/*
 * rules.js — the lines the page actually draws.
 *
 * Everything this tool got structurally wrong came from one decision: the grid
 * was inferred from where the marks sat. That works until it doesn't, and the
 * ways it fails are the ways a schedule is hardest to read — a visit with only
 * one X never forms a column, an assessment whose name wraps merges into its
 * neighbour, a row of shaded cells has no marks at all and disappears. Each of
 * those was patched separately, and each patch was a guess about content
 * standing in for a fact about layout.
 *
 * These are ruled tables. The sponsor drew the grid, and the grid is in the
 * content stream as vector paths. Reading it turns inference into measurement:
 * the columns ARE the vertical rules, the rows ARE the horizontal ones, and
 * which cell a word belongs to stops being a question about clustering.
 *
 * Two things make this less simple than it sounds, and both are handled here:
 *
 *   Rules are drawn as thin filled rectangles far more often than as stroked
 *   lines, so a "line" is any path whose bounding box is long in one direction
 *   and negligible in the other.
 *
 *   Coordinates are in whatever space the current transform says, and these
 *   documents nest transforms hundreds deep. A path read without composing the
 *   transform stack lands nowhere near where it is printed.
 */

import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** A path is a rule if it is long one way and hair-thin the other. */
const THIN = 2.5;
const LONG = 12;

/**
 * A path's bounding box, in upright page space.
 *
 * Taken from the box pdfjs already computed for the path rather than by walking
 * its op codes. Walking them means knowing how many coordinates each op eats,
 * which varies by build, and reading one op wrong walks off the end of the run
 * and turns the whole page into nothing. The box is all a rule needs: a line is
 * a box that is long one way and flat the other, whichever ops drew it.
 */
function boxOf(minMax, matrix) {
  if (!minMax) return null;
  const [x0, y0, x1, y1] = Array.from(Object.values(minMax)).map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;

  // All four corners, because the transform may rotate the page. This build of
  // pdfjs transforms the point in place and returns nothing, so the array is
  // read back rather than assigned from the call.
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (const point of corners) Util.applyTransform(point, matrix);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * The horizontal and vertical rules on one page, in upright page space.
 *
 * Same coordinate space as the words: y grows downwards, rotation applied, so a
 * landscape continuation page reads like every other page.
 */
export async function rulesOf(page, viewport) {
  const ops = await page.getOperatorList();

  const stack = [];
  let matrix = viewport.transform;
  const horizontals = [];
  const verticals = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) { stack.push(matrix); continue; }
    if (fn === OPS.restore) { matrix = stack.pop() || viewport.transform; continue; }
    if (fn === OPS.transform) { matrix = Util.transform(matrix, args); continue; }
    if (fn !== OPS.constructPath) continue;

    const box = boxOf(args[2], matrix);
    if (!box) continue;
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;

    if (height <= THIN && width >= LONG) {
      horizontals.push({ y: (box.minY + box.maxY) / 2, x0: box.minX, x1: box.maxX });
    } else if (width <= THIN && height >= LONG) {
      verticals.push({ x: (box.minX + box.maxX) / 2, y0: box.minY, y1: box.maxY });
    }
  }

  return { horizontals: merge(horizontals, 'y', 'x0', 'x1'), verticals: merge(verticals, 'x', 'y0', 'y1') };
}

/**
 * Rules drawn as several segments, joined back into one.
 *
 * A table's border is drawn cell by cell, so one printed line arrives as thirty
 * collinear pieces. Left separate they look like thirty columns.
 *
 * The gap they are allowed to jump matters as much as the tolerance across
 * them. A column boundary STOPS wherever cells are merged — protocol9 leaves a
 * fifty-point hole in two of its rules exactly where "Prior to Day 4" spans
 * three columns — and a boundary read as ending there is a boundary that fails
 * the "does this run the height of the grid" test and is thrown away, taking
 * three columns with it. Collinear to within a couple of points is already
 * strong evidence of one line; the gap is where the table says something is
 * merged, not that the column ended.
 */
const JOIN_ACROSS = 80;

function merge(list, axis, from, to) {
  const sorted = [...list].sort((a, b) => a[axis] - b[axis] || a[from] - b[from]);
  const out = [];
  for (const rule of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[axis] - rule[axis]) <= 2.5 && rule[from] <= last[to] + JOIN_ACROSS) {
      last[to] = Math.max(last[to], rule[to]);
      last[from] = Math.min(last[from], rule[from]);
      last.pieces += 1;
      continue;
    }
    out.push({ ...rule, pieces: 1 });
  }
  return out;
}

/** Read one PDF's rules, page by page, keyed by page number. */
export async function readRules(data) {
  const doc = await getDocument({
    data: Uint8Array.from(data),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const byPage = new Map();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
    byPage.set(n, await rulesOf(page, viewport));
    page.cleanup();
  }
  await doc.cleanup();
  return byPage;
}
