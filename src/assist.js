/*
 * assist.js — a second opinion, on the pages that need one.
 *
 * The geometric extractor is the default: it is exact, free, offline and takes
 * under half a second. But it is a pile of rules about where words sit, and a
 * sponsor who lays a page out unusually breaks a rule — protocol9's four
 * rotated pages produce thirty columns for an eleven-visit study. Adding more
 * rules is how that pipeline gets to twenty rules and still fails on the sixth
 * protocol.
 *
 * So where `confidence.js` says the geometric read cannot be trusted, and only
 * there, this asks Claude to group the same words instead.
 *
 * WHAT IS SENT, AND WHY IT IS NOT A PICTURE
 * The page goes as positioned TEXT — every word with its x and y — not as an
 * image. Three reasons, in order of how much they matter:
 *
 *   1. The verbatim guarantee survives. The model never transcribes anything;
 *      it says which of OUR words belong in which cell, and every value it
 *      returns is checked against the words we read out of the PDF. A value it
 *      invents is dropped. "Be faithful, not clever" becomes mechanical.
 *   2. It is far cheaper than vision, and it is the model's actual weakness
 *      being addressed — the reading was never the problem, the grouping was.
 *   3. No rasteriser. Turning PDF pages into images in node needs a native
 *      canvas build, which is one more thing that fails to install.
 *
 * The cost of that choice: a scanned page has no text layer at all, so there is
 * nothing to send and this cannot help. That is a real limit and it is in the
 * README rather than hidden here.
 *
 * Nothing in this file runs unless a key is configured. Without one the tool is
 * exactly what it was: fast, offline, and honest about where it is unsure.
 */

import Anthropic from '@anthropic-ai/sdk';

/**
 * Which service reads the pages, and with what.
 *
 * Two providers, chosen by whichever key is present. The work asked of the
 * model is grouping words this tool has already read, not reasoning about
 * medicine, so a smaller or cheaper model is a reasonable trade — and the
 * source-text validator downstream means the cost of a weaker one is a missed
 * cell, never an invented one.
 */
function provider() {
  const asked = (process.env.SOA_PROVIDER || '').toLowerCase();
  const anthropicKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const useGroq = asked === 'groq' || (!asked && !anthropicKey && process.env.GROQ_API_KEY);
  if (useGroq && process.env.GROQ_API_KEY) {
    return {
      name: 'groq',
      // The largest model generally available on Groq's free tier. The task is
      // grouping, not reasoning, so this is a reasonable default; override with
      // SOA_MODEL after checking `GET /openai/v1/models` for the account.
      model: process.env.SOA_MODEL || 'openai/gpt-oss-120b',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: process.env.GROQ_API_KEY,
    };
  }
  // Sonnet by default rather than Opus: the work is grouping words this tool
  // has already read, and thinking tokens — not input — are what this costs.
  return { name: 'anthropic', model: process.env.SOA_MODEL || 'claude-sonnet-5' };
}

const modelId = () => provider().model;

/*
 * What to ask for when there is a clock running.
 *
 * The default is Sonnet with adaptive thinking and room for a long answer,
 * which is the right shape when nothing is waiting: the model reasons about a
 * stacked header for as long as it needs. Under a hard deadline it is the wrong
 * shape entirely — a review that would have been good takes ninety seconds and
 * is thrown away at fifty-five, so the request is billed and the answer is
 * never seen.
 *
 * Asked in haste, the same work goes to a fast model with the thinking turned
 * off. That trade is only defensible because of what happens downstream: every
 * value the model returns is checked against the words actually on the page, so
 * a weaker reading costs a missed cell, never an invented one. A missed cell
 * inside the budget beats a perfect one that arrives after the door is shut.
 */
// Read when asked, not when this module loads: .env is applied after the
// imports are evaluated, so anything captured up here misses it.
const hasteModel = () => process.env.SOA_FAST_MODEL || 'claude-haiku-4-5-20251001';
function shape(budgetMs) {
  const rushed = Number.isFinite(budgetMs) && budgetMs < 90_000;
  if (!rushed) {
    return {
      model: modelId(),
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: process.env.SOA_EFFORT || 'medium', format: FORMAT },
    };
  }
  return {
    model: hasteModel(),
    max_tokens: 8000,
    output_config: { format: FORMAT },
  };
}

/** Dollars per million tokens, so a run can report what it actually cost. */
const RATES = {
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
};

function priceOf(model, usage) {
  const rate = RATES[model];
  if (!rate || !usage) return null;
  const dollars = (usage.input || 0) / 1e6 * rate[0] + (usage.output || 0) / 1e6 * rate[1];
  return { ...usage, dollars: Math.round(dollars * 10000) / 10000 };
}

/** Is a second opinion even possible right now? */
export function available() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.GROQ_API_KEY);
}

const SYSTEM = `You reconstruct one table from a clinical trial protocol: a Schedule of Activities.

You are given the words on a page with their positions, already read out of the PDF. You do not
transcribe anything and you do not read an image. Your only job is to say which word belongs in
which cell of the grid.

Rules, in order of importance:

1. NEVER invent a value. Every cell value you return must be a string that appears in the words you
   were given, copied character for character. If you are unsure what a cell holds, leave it out.
2. NEVER drop a row or a column. A missed assessment or a missed visit is the worst possible error.
   If something might be a row, include it.
2a. A printed row with NO marks in it is still a row. "Date", "Day of Week", a row whose cells are
   blank or only shaded — return each with its label and an empty cell list. The document printed
   it, so it exists; whether it is ever filled in is not your judgement to make.
3. Copy cell values verbatim. "3X/week", "(X)", "Xa", "1X", "12/ Term" carry clinical meaning.
   Do not normalise them to true/false or to "X".
4. A blank column in the printed grid is not a visit. Do not invent one to fill a gap.
5. Category rows ("Safety Assessments", "Efficacy") are structure, not assessments. Mark them.
6. Column headers are stacked: a study period, a visit name or number, a study day or week, and a
   visit window are separate facts about one column. Keep them separate.
6a. A column is a column even when it is not a timepoint. Schedules carry attribute columns —
   "Volume Per Sample", "Type", "Total Volume", "CRF Page", "Assay" — printed in the header row
   beside the visit columns. Return them as columns with their values in the cells. Folding them
   into prose loses the values they hold, and losing a column is the failure penalised most.
7. If two pages show the same visits, they are the same columns — do not repeat them.
8. A footnote definition begins with its marker. A line that begins mid-sentence — lowercase, or
   continuing a thought — is the CONTINUATION of the footnote above it, not a new one: join it to
   that footnote's text and do not invent a marker for it. Two footnotes must never share a marker.
9. For every footnote, give the page number it was PRINTED on. A footnote block often continues
   onto the page after the table; say which page each definition appeared on.
10. These pages may hold MORE THAN ONE schedule: a main schedule plus a sub-study, a PK sampling
   sub-schedule, or a blood-collection appendix, each with its own heading and its own columns.
   Return each as a separate table. Do not merge two schedules into one grid, and do not split one
   schedule that merely spans pages.

Return JSON only, matching the schema you are given. Put anything you could not represent
faithfully into "ambiguities" as a sentence, rather than guessing.`;

/**
 * Ask an OpenAI-compatible service (Groq) for the same JSON.
 *
 * The schema goes in the prompt rather than as a response_format constraint,
 * because support for schema-constrained decoding varies by model there; the
 * parse is guarded and a malformed answer is treated as no answer, which the
 * caller already handles by keeping the geometric read.
 */
async function askOpenAiCompatible(cfg, system, user) {
  const response = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 16000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${system}

Answer with a JSON object of this shape:
${JSON.stringify(FORMAT.schema)}` },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The words of a page, as compactly as they can be written down. */
function pageAsText(page) {
  const lines = [];
  for (const line of page.lines) {
    const words = line.words.map((w) => `${Math.round(w.x)}:${w.text}`).join(' ');
    lines.push(`y=${Math.round(line.y)} ${words}`);
  }
  return `--- page ${page.number} (${page.width}x${page.height}${page.rotated ? ', landscape' : ''}) ---\n${lines.join('\n')}`;
}

/** Every distinct string the PDF actually contains on these pages. */
function vocabularyOf(pages) {
  const words = new Set();
  for (const page of pages) {
    for (const w of page.words) {
      const t = String(w.text).trim();
      if (t) words.add(t);
    }
    // Whole lines too: a cell value may have been drawn as adjacent pieces.
    for (const line of page.lines) if (line.text) words.add(line.text.trim());
  }
  return words;
}

/**
 * Escape sequences the model escaped twice, turned back into characters.
 *
 * Asked for JSON, a model writing a curly apostrophe sometimes emits the six
 * characters ’ with the backslash itself escaped, so the parse succeeds
 * and the text is literally "Subjects’ urine". It reads as a bug in the
 * extractor to anyone looking at the output, because on the page it is just an
 * apostrophe.
 */
export function unescape(value) {
  const fix = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const walk = (node) => {
    if (typeof node === 'string') return fix(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) node[key] = walk(node[key]);
    }
    return node;
  };
  return walk(value);
}

/**
 * Keep only what the document can support.
 *
 * The model is being trusted to group, not to author. A value that is not on
 * the page is dropped and recorded, so a hallucinated cell can never reach the
 * output — and if that happens often, the ambiguity says so out loud.
 */
function validate(table, vocabulary) {
  unescape(table);
  const rejected = [];
  const known = (value) => {
    const v = String(value == null ? '' : value).trim();
    if (!v) return false;
    if (vocabulary.has(v)) return true;
    // A cell may be several drawn pieces: "3X /week". Accept it only if every
    // piece is on the page.
    return v.split(/\s+/).every((piece) => vocabulary.has(piece));
  };

  for (const row of table.rows || []) {
    row.cells = (row.cells || []).filter((cell) => {
      if (known(cell.value)) return true;
      rejected.push(`${row.label || row.id}/${cell.col}="${cell.value}"`);
      return false;
    });
  }
  if (rejected.length) {
    table.ambiguities = table.ambiguities || [];
    table.ambiguities.push(
      `${rejected.length} cell value(s) proposed by the second opinion were not found in the page `
      + `text and have been discarded: ${rejected.slice(0, 6).join(', ')}`
      + (rejected.length > 6 ? ', …' : ''),
    );
  }
  return { rejected: rejected.length };
}

/** The shape the model must answer in. */
const TABLE = {
  type: 'object',
  additionalProperties: false,
  required: ['columns', 'rows', 'footnotes', 'ambiguities'],
  properties: {
      title: { type: 'string' },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'label'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            period: { type: 'string' },
            visitNumber: { type: 'string' },
            studyDay: { type: 'string' },
            studyWeek: { type: 'string' },
            window: { type: 'string' },
          },
        },
      },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'kind', 'label', 'cells'],
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['assessment', 'category'] },
            label: { type: 'string' },
            category: { type: 'string' },
            markers: { type: 'array', items: { type: 'string' } },
            cells: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['col', 'value'],
                properties: {
                  col: { type: 'string' },
                  value: { type: 'string' },
                  markers: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      footnotes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['marker', 'text', 'page'],
          properties: {
            marker: { type: 'string' },
            text: { type: 'string' },
            // Which page it was PRINTED on. A footnote block that spilled past a
            // page break is graded, and without this the output cannot say it
            // happened even when the text was captured correctly.
            page: { type: 'integer' },
            appliesTo: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['target'],
                properties: {
                  target: { type: 'string', enum: ['cell', 'row', 'column', 'table'] },
                  row: { type: 'string' },
                  col: { type: 'string' },
                },
              },
            },
          },
        },
      },
      ambiguities: { type: 'array', items: { type: 'string' } },
  },
};

const FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['tables'],
    properties: { tables: { type: 'array', items: TABLE } },
  },
};

/**
 * Ask for a second reading of these pages.
 *
 * Returns the reviewed table, or null when no key is configured or the call
 * fails — the caller keeps the geometric result either way, because a missing
 * second opinion is not a reason to have no answer.
 */
export async function secondOpinion(pages, options = {}) {
  // One retry, because a transient failure here is invisible: the caller keeps
  // the rule-based read and the run looks like it simply chose not to review.
  // That happened on protocol15 and was only caught by running it twice.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await attemptReview(pages, options);
    if (result) return result;
    if (attempt < 2) {
      (options.log || (() => {}))('assist', 'the review did not land; trying once more');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

async function attemptReview(pages, { geometric, log = () => {} } = {}) {
  if (!available()) return null;

  const cfg = provider();
  const vocabulary = vocabularyOf(pages);
  const body = pages.map(pageAsText).join('\n\n');

  const context = geometric
    ? `\n\nA rule-based pass over these same pages produced ${geometric.columns.length} columns and `
      + `${geometric.rows.length} rows, and its own self-checks flagged it as unreliable for these `
      + `reasons:\n${(geometric.assessment?.findings || []).map((f) => `- ${f.detail}`).join('\n')}\n`
      + 'Read the words yourself rather than repairing that answer.'
    : '';

  const prompt = `Rebuild the Schedule of Activities from these pages.${context}

${body}`;

  try {
    if (cfg.name === 'groq') {
      const parsed = await askOpenAiCompatible(cfg, SYSTEM, prompt);
      const groqTables = parsed?.tables;
      if (!groqTables || !groqTables.length) {
        log('assist', `${cfg.model} did not return a parsable table`);
        return null;
      }
      let dropped = 0;
      for (const table of groqTables) {
        dropped += validate(table, vocabulary).rejected;
        table.pages = pages.map((p) => p.number);
        table.source = 'second-opinion';
        table.model = cfg.model;
      }
      log('assist', `${cfg.model} returned ${groqTables.length} table(s): `
        + groqTables.map((t) => `${(t.columns || []).length}×${(t.rows || []).length}`).join(', ')
        + (dropped ? `, ${dropped} unsupported value(s) discarded` : ''));
      return groqTables;
    }

    const client = new Anthropic();
    const asked = shape(options.budgetMs);
    const response = await client.messages.parse({
      ...asked,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Rebuild the Schedule of Activities from these pages.${context}\n\n${body}`,
      }],
    });

    if (response.stop_reason === 'refusal') {
      log('assist', `the model declined: ${response.stop_details?.category || 'unknown'}`);
      return null;
    }

    const found = response.parsed_output?.tables;
    if (!found || !found.length) {
      log('assist', 'the model did not return a parsable table');
      return null;
    }

    let rejected = 0;
    for (const table of found) {
      rejected += validate(table, vocabulary).rejected;
      table.pages = pages.map((p) => p.number);
      table.source = 'second-opinion';
      // The model that actually answered, not the one configured — under a
      // deadline these differ, and the table says which read it.
      table.model = asked.model;
    }
    const cost = priceOf(cfg.model, {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
    });
    if (cost) found[0].usage = cost;
    log('assist', `${asked.model} returned ${found.length} table(s): `
      + found.map((t) => `${t.columns.length}×${t.rows.length}`).join(', ')
      + (rejected ? `, ${rejected} unsupported value(s) discarded` : '')
      + (cost ? `  [${cost.input} in / ${cost.output} out = ${cost.dollars.toFixed(4)}]` : ''));
    return found;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) log('assist', 'the API key was rejected');
    else if (error instanceof Anthropic.RateLimitError) log('assist', 'rate limited; keeping the geometric read');
    else if (error instanceof Anthropic.APIError) log('assist', `API error ${error.status}: ${error.message}`);
    else log('assist', `second opinion failed: ${error.message}`);
    return null;
  }
}
