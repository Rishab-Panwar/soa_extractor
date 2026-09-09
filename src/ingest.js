/*
 * ingest.js — a protocol PDF as pages of positioned words.
 *
 * Everything downstream reads this and nothing else, which is what lets the
 * locator and the extractor share one view of the document.
 *
 * Two things happen here that matter more than they look:
 *
 *   Rotation is applied, not reported. A continuation page of a schedule is
 *   frequently landscape, and on those pages the raw text coordinates are
 *   transposed — the column headers run down what the PDF calls x. Handing
 *   that to a grid builder produces a table rotated ninety degrees, or more
 *   often, nothing at all. After this module every page is upright and every
 *   coordinate means the same thing.
 *
 *   Words keep their geometry. A schedule is a grid drawn with whitespace as
 *   often as with ruled lines, so the only reliable evidence of which column a
 *   mark belongs to is where it sits. Reading order is discarded; position is
 *   the data.
 */

import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { rulesOf } from './rules.js';

/**
 * One drawn piece of text.
 *
 * `x`/`y` are the top-left of the box in upright page space, y growing
 * downwards, which is how a person reads a page and how every later comparison
 * here is phrased.
 */
function wordFrom(item, viewport) {
  // Composing the item's own transform with the viewport's is what makes a
  // landscape page behave like an upright one: after this, the text advances
  // along +x and descends down +y whatever the page's /Rotate said.
  const m = Util.transform(viewport.transform, item.transform);
  const height = Math.hypot(m[2], m[3]);
  // The item's width is measured along its own text direction; scale it by how
  // much that direction is stretched once both transforms are applied.
  const along = Math.hypot(m[0], m[1]) / (Math.hypot(item.transform[0], item.transform[1]) || 1);
  const width = (item.width || 0) * (Number.isFinite(along) && along > 0 ? along : 1);
  return {
    text: item.str,
    x: Math.round(m[4] * 100) / 100,
    y: Math.round((m[5] - height) * 100) / 100,
    w: Math.round(width * 100) / 100,
    h: Math.round(height * 100) / 100,
    font: item.fontName || '',
  };
}

/** Read a PDF into pages of words, upright, with page geometry. */
export async function readPdf(data) {
  const doc = await getDocument({
    // A node Buffer IS a Uint8Array but pdfjs refuses it by name, so copy.
    data: Uint8Array.from(data),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    // `rotation` here is the page's own /Rotate; asking the viewport for it is
    // what turns a landscape continuation page upright.
    const viewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
    const content = await page.getTextContent({ disableNormalization: false });

    const words = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const word = wordFrom(item, viewport);
      if (word.w <= 0 && word.h <= 0) continue;
      words.push(word);
    }
    words.sort((p, q) => (Math.abs(p.y - q.y) > 2 ? p.y - q.y : p.x - q.x));

    pages.push({
      number: n,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      rotated: (page.rotate || 0) % 180 !== 0,
      words,
      // The lines the page draws, in the same upright space as the words. Where
      // a table is ruled these ARE its columns and rows, and reading them is
      // the difference between measuring the grid and guessing it from what
      // happens to be printed inside it.
      rules: await rulesOf(page, viewport),
      // Lines are a convenience for the locator, which reads the page as prose.
      // The extractor ignores them and works from `words` directly.
      lines: linesOf(words),
    });
    page.cleanup();
  }
  await doc.cleanup();
  return { pageCount: pages.length, pages };
}

/**
 * Words gathered into visual lines.
 *
 * Grouped by vertical overlap rather than by an exact y, because a superscript
 * marker and the character it modifies sit on different baselines and belong to
 * the same line — and because a table row's label and its marks are frequently
 * drawn a point or two apart.
 */
export function linesOf(words) {
  const lines = [];
  for (const word of words) {
    const middle = word.y + word.h / 2;
    // Matched on how close the two CENTRES are, not on whether one box contains
    // the other. Containment grows: each word widens the line's vertical extent,
    // the widened extent swallows the next row, and on a densely set table four
    // separate rows merge into one — their marks pooling onto whichever label
    // came first while the other labels are left with nothing under them. The
    // tolerance is a fraction of the text's own height, so it scales with the
    // type size instead of assuming one.
    const line = lines.find((l) => Math.abs(l.centre - middle) <= Math.max(word.h, l.height) * 0.6);
    if (line) {
      line.words.push(word);
      line.top = Math.min(line.top, word.y);
      line.bottom = Math.max(line.bottom, word.y + word.h);
      // The centre stays put: it is what this line IS, not what it has grown to.
      line.height = Math.max(line.height, word.h);
    } else {
      lines.push({ top: word.y, bottom: word.y + word.h, centre: middle, height: word.h, words: [word] });
    }
  }
  for (const line of lines) {
    line.words.sort((p, q) => p.x - q.x);
    line.text = line.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
    line.y = line.top;
  }
  lines.sort((p, q) => p.top - q.top);
  return lines;
}

/** A page as plain text, in reading order. Used only for scoring and display. */
export function pageText(page) {
  return page.lines.map((l) => l.text).join('\n');
}
