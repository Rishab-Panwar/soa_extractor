# SoA Extractor

Give it a clinical trial protocol. It finds the Schedule of Activities — whatever
the sponsor called it, wherever it sits, however many pages it runs across — and
rebuilds the grid verbatim, with footnotes bound to the cells they modify.

It reads the table **from the grid the document draws**: free, offline, about a
second for a 97-page protocol. Then it **scores that reading against itself**.
Only where the self-checks say the reading cannot be trusted does it ask a model
for a second opinion — and every value that comes back is **validated against
the words actually on the page**, so a model can miss a cell but cannot invent
one.

Reading the drawn grid is the thing that matters, and it was the second design.
The first inferred the table from where the marks were: cluster the X's into
columns, cluster the text lines into rows. That works until it doesn't, and the
ways it fails are the ways a schedule is hardest to read. A visit with one mark
in it never becomes a column. An assessment whose name wraps merges into its
neighbour, or splits in half. A row of shaded cells has no marks at all and
disappears. Each failure got patched separately, and each patch was a guess
about *content* standing in for a fact about *layout*.

These are ruled tables. The lines are in the PDF as vector paths, and reading
them turns inference into measurement — the columns *are* the vertical rules,
the rows *are* the horizontal ones. On our own held-out mock that took the
schedule from 11 columns to the 18 it actually has.

Every figure below was checked against the source PDF.

| Protocol | Schedule | Read by | Columns | Rows | Footnotes |
|---|---|---|---|---|---|
| protocol1 | Schedule of Events | geometry | 14 | 28 | 4 |
| protocol5 | Appendix I — Time and Events | review | 11 | 31 | 10 |
| protocol5 | Appendix II — Blood Collections | review | 15 | 8 | 2 |
| protocol9 | Table 4 — Schedule of Measures | review | 11 | 39 | 6 |
| protocol12 | Table 3 — Overview of Assessments | review | 9 | 40 | 14 |
| protocol15 | Table 1 — Overview of Assessments | review | 10 | 34 | 5 |
| Prot_000 (held out) | Table 1 — Time and Events | geometry | 18 | 29 | 12 |

protocol5 is listed twice because it carries **two** schedules, and both are
extracted: the main Time and Events table, and a separate blood-collection
appendix with its own grid. Finding the second one rather than running it into
the first is a requirement the brief names explicitly.

The rule-based path alone — no key, no network, no cost — now reads every one of
them with **no unnamed column and no unlabelled row**:

| Protocol | Columns | Rows | Cells | Audited against its own pages |
|---|---|---|---|---|
| protocol1 | 14 | 28 | 139 | clean |
| protocol5 | 11 | 31 | 107 | clean |
| protocol9 | 11 | 32 | 168 | 2 rows the rules leave out, 1 value |
| protocol12 | 9 | 39 | 132 | clean |
| protocol15 | 9 | 33 | 132 | clean |
| Prot_000 | 18 | 29 | 141 | clean |
| 3041835 (unseen) | 6 | 33 | 86 | clean |
| Prot_111 (unseen) | 7 | 16 | 35 | cannot be checked — draws no column rules |

The last column is `npm run audit` comparing the rule-based reading against the
table the page draws, cell by cell. protocol9's three are rows and a value the
rules leave out on a rotated page and the review recovers; Prot_111's is a
verification gap, not a clean bill, and the audit says so in those words.

Two honest qualifications. The geometric rules were developed against these
protocols, so those numbers are in-sample; Prot_000 is the only document held
out, and it is one we wrote. And the review path is nondeterministic — the same
pages can come back with a different row count on a second run, which is why the
regression suite pins the rule-based reading and not the published one.

## Running it

```bash
npm install
npm run serve            # UI on http://localhost:3100 — drop in any protocol PDF
npm run serve:geometry   # the same, with the model review forced OFF
npm run serve:review     # the same, with it forced ON
npm run extract -- path/to/protocol.pdf [more.pdf ...]   # writes outputs/<name>.json
```

Node 22.13+ — that is what pdfjs-dist needs, and CI proves it: a Node 20 run
fails on `Promise.withResolvers`, which the PDF reader calls and Node 20 does not
have. The UI and the batch script run the same pipeline, so the committed
`outputs/` are reproducible.

**The second opinion is optional.** Without a key the tool runs geometry only,
and says where it is unsure instead of silently guessing. To enable it, put a
key in `.env` (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
# SOA_MODEL=claude-opus-5     # the default; any Claude model works
```

`--no-assist` forces the geometric path even with a key configured, which is how
the two columns of the table above were measured.

A key in `.env` used to be enough to turn the review on, with nothing announcing
it — so the same upload could cost an API call or not depending on a file last
looked at weeks ago, and there was no way to run the two readings side by side.
`SOA_ALLOW_REVIEW` now decides when it is set (`0` off, `1` on), the server says
which mode it started in, and every upload logs what the pipeline did. That last
part matters: the review only runs on a table the checks distrust, so a
well-read protocol comes out **identical either way and costs nothing** — of the
eight documents here, seven never reach it. Without the log there is no telling
"the switch did nothing" from "the switch is broken".

## Deploying it

```bash
npm run sync-outputs     # copy outputs/ to the page's public/outputs/
npx vercel               # or push to a repo and import it at vercel.com
```

`public/index.html` is the page and `api/extract.js` the endpoint; the local
server serves the same file, so what you test is what ships.

**The hosted version runs the geometric reader only, deliberately.** Two
reasons, and both are constraints rather than preferences:

- A serverless function is killed at 60 seconds. Geometry takes about a second; a review
  takes 90–150s and would be cut off mid-flight, returning nothing instead of
  something honest.
- A key on a public URL with no authentication is a key any visitor can spend.

So the deployment reads the protocol, reports its confidence, and says plainly
when a table is one its own checks do not trust — with the note that running the
tool locally with a key sends those pages for a second opinion. The five
committed outputs are loadable from the page, clearly labelled as committed
results rather than as the product.

Set `SOA_ALLOW_REVIEW=1` plus a key in the Vercel project to enable reviews
there, accepting both consequences above.

## Architecture

```
PDF ─▶ ingest ─▶ locate ─▶ extract ─▶ assess ──trust/check──▶ JSON ─▶ UI
       words +   page      grid from   self-        │
       rules,    scores    the drawn   checks    fallback
       upright             lines          │
                                   review the same words with Claude,
                                   validate every value, then put back
                                   the facts the review dropped
```

**ingest.js** turns the PDF into pages of positioned words and does one thing
that everything else depends on: **it applies page rotation rather than
reporting it**. A continuation page of a schedule is frequently landscape, and
on those pages the raw coordinates are transposed — the column headers run down
what the PDF calls x. Composing each text item's transform with a rotated
viewport makes every page upright, after which one set of geometric rules works
on all of them. Reading order is discarded; position is the data.

**locate.js** scores every page on four independent signals and keeps the
reasons: a title in the family sponsors actually use (Schedule of
Events/Assessments/Measures, Time and Events, Study Flow Chart, Overview of
Study Assessments…), header rows pairing a word like *Study Day* with a run of
numbers, a dense field of cell-like marks, and blocks of footnote definitions.
Each signal alone is a false positive — a contents page has the title, a
statistics chapter has numbers — so they are summed, and a page above the seed
threshold starts a candidate that **grows in both directions** through pages
carrying the grid, then follows a footnote block up to two pages further.

Two decisions came out of being wrong first:

- **Rank by the best single page, not the summed score.** Summing favoured an
  eight-page run of weak footnote pages over the two pages that hold the actual
  schedule; protocol5 ranked its synopsis above its real Appendix I.
- **A continuation page must carry the grid, not merely score well.** A
  narrative page mentioning Screening and Follow-up clears a score threshold and
  contains no table, and the candidate then grows through half a chapter.

The locator's per-page evidence is shown in the UI so a reviewer can argue with
its choice rather than trust it.

**rules.js** reads the lines the page draws. It walks the content stream keeping
a transform stack, and treats any path whose bounding box is long one way and
hair-thin the other as a rule. Two details decide whether this works at all:
rules are drawn as thin filled *rectangles* far more often than as strokes, and
a column boundary **stops wherever cells are merged** — protocol9 leaves a
fifty-point hole in two of its rules exactly where a value spans three columns.
Read as "the rule ended there", those boundaries fail the "does this run the
height of the grid" test and are thrown away, taking three columns with them. So
collinear segments are joined across the gap.

**extract.js** rebuilds the table, from the rules where the page draws them and
from the marks where it does not — not every schedule is ruled, and the
inference remains as the fallback rather than being replaced.

The switch is guarded, because a better source of structure is still a change,
and a change that loses a mark has made the output worse however sound its
reasoning. Both readings of the rows are built and the ruled one is adopted
**only if it accounts for every mark the inferred one did**, compared over the
ruled area so that content outside the table is not held against it. It cannot
quietly drop a row's contents to make the boundaries tidy; where it would, the
inferred reading stands and the table says so in `ambiguities`. protocol5 page
51 currently refuses on those grounds, and the output records `rowsAreRuled:
false` so a consumer knows which it has.

Everything else is layered on that: header lines are read per column, keeping
visit number, study day, study week and window as separate facts; headings that
band several columns are matched by their ink and spread across what they cover;
values written as words rather than marks ("Prior to Day 4" across three days)
become cells; a word set vertically down the grid is recognised as a divider
rather than as a column of one-letter values.

**confidence.js** scores the finished table against itself. Every check is a
property a correct extraction must have, computable with no ground truth, no
model and no human — and each came from a failure this pipeline actually had:

| Check | What it catches |
|---|---|
| unidentified columns | a column with no visit number, day, week or short label cannot be matched to the same visit on another page — before the drawn grid was read, protocol9's 11 study days came out as 30 columns |
| column count disagrees | pages of one table finding 14, 5 and 11 columns; at most one is right |
| duplicate columns | an identical, long mark pattern where one side is unidentified: a column counted twice, not two similar visits |
| unlabelled rows | marks with no activity name: prose or a page footer read as a row |
| unlinked footnotes | definitions whose markers appear nowhere in the grid |
| sparse grid | marks falling outside every detected column |

The verdict is the operative part: **trust**, **check**, or **fallback**. This is
what stopped the tool reporting those 30 columns as though it were sure, and it
is still what decides whether a reading is worth a model's time.

Two false alarms were fixed here rather than left in, because a score that
distrusts a correct answer is as useless as one that trusts a wrong one: a
column labelled `3`, `ET` or `RT` is identified even with no typed day/week
field, and two visits sharing an assessment set (protocol1's weeks 4 and 6) is
normal — only a duplicate where one side is *unidentified* signals a failure.

**assist.js** is the second opinion, and it runs only on `fallback`. What it
sends is the deliberate part: **positioned text, not page images** — every word
with its x and y, already read out of the PDF. Three reasons, in order:

1. **The verbatim guarantee survives.** The model never transcribes anything; it
   says which of *our* words belong in which cell, and every value it returns is
   checked against the page text. Anything not found is discarded and recorded.
   On protocol12 that guard fired on 3 proposed values. "Be faithful, not
   clever" becomes mechanical rather than a hope.
2. It addresses the actual weakness. Reading these pages was never the problem —
   grouping them was.
3. No rasteriser, so nothing native to install.

The cost of that choice is real: a **scanned** page has no text layer, so there
is nothing to send and this cannot help. Page images would be the answer there.

Two design decisions came from getting it wrong:

- **Send the whole table, not just the flagged pages.** Asking only about
  protocol12's footnote pages got the honest answer "there is no table here",
  which replaced a correct extraction with an empty one.
- **Never accept an empty review.** Dropping rows wholesale is the failure the
  brief penalises most heavily, so the geometric read stands unless the review
  at least matches it.

Both readings are kept: a reviewed table carries a `geometric` block recording
what the rule-based pass produced and why it was distrusted.

## Output schema

```jsonc
{ "tables": [ {
  "title", "pages": [53,54],
  "columns": [ { "id", "label", "path": [],        // period grouping
                 "visitNumber", "studyDay", "studyWeek", "window", "page" } ],
  "rows":    [ { "id", "kind": "assessment"|"category", "label", "category",
                 "cells": [ { "col", "value", "markers": ["a"] } ], "markers" } ],
  "footnotes": [ { "marker", "text", "pages", "continued", "appliesTo": [...] } ],
  "ambiguities": [ "..." ],
  "locatorEvidence": [ { "page", "score", "reasons" } ]
} ] }
```

Why this shape:

- **Cells are sparse and verbatim.** `3X/week`, `(X)`, `1X`, `Xa`, `12/ Term` are
  the information the table exists to carry. An empty cell is meaningful only by
  absence; inventing empty cells invites inventing content.
- **Column hierarchy is denormalised per column** rather than a nested header
  tree. Every consumer — rendering, diffing, mapping into an EDC — stays simple,
  and no grouping information is lost.
- **Rows carry `kind`**, so "Safety" as a category header is structure, not an
  assessment that never happens.
- **Footnote linkage is stored both ways**: markers sit on the cells and rows
  that carry them, and each footnote lists its targets.
- **`ambiguities` is a first-class field.** It is "be faithful, not clever" made
  concrete — where the tool cannot represent something honestly it says so
  instead of guessing.

## Tools evaluated

**pdfjs-dist — chosen.** The only reader benchmarked that exposes a per-item
transform matrix, which is what makes rotated pages recoverable: composing it
with a rotated viewport gives upright coordinates for landscape continuation
pages, where protocol9's four pages live. It also keeps superscript markers
attached to their mark (`Xa` arrives as one string), which is what allows
footnote linkage without character-level font analysis.

**pdftotext / plain text layers — rejected for extraction.** Reading order on a
schedule is meaningless: the marks arrive as a stream with no column identity.
Used here only via pdf.js for the locator's scoring, where reading order does
not matter.

**Three models benchmarked on the same task**, all reading positioned text and
judged against protocol9, whose correct answer (11 columns) was established by
hand from the printed header:

| Model | Columns | Rows | Cost | Verdict |
|---|---|---|---|---|
| `claude-opus-5` (effort high) | 11 ✅ | 39 | $0.69 | correct, and the most expensive thing here |
| **`claude-sonnet-5` (effort medium)** | **11 ✅** | **40** | **$0.125** | **chosen** — same answer, 5× cheaper |
| `openai/gpt-oss-120b` (Groq, free) | 11 ✅ | **21 ❌** | free | rejected: dropped 18 of ~39 rows |

Every one of them got the column axis right, which is the part geometry fails
at. They differ on recall, and a dropped assessment is the failure the brief
penalises most — so the free option was rejected on quality, not on principle.
Sonnet at medium effort matched Opus at high effort on this task and cost a
fifth as much: the work is *grouping words already read*, not reasoning, and
thinking tokens are where the money goes.

That comparison also produced a fix: the Groq run revealed we rejected an
*empty* review but accepted a *shrunken* one. A review returning fewer named
rows than were already found is now discarded and the geometric read stands.

**Groq remains supported** — set `GROQ_API_KEY` and `SOA_PROVIDER=groq`. It is
genuinely fast (18s against 90s) and free, and if recall improves it would be
the better default. Note the brief's rule about not uploading protocols where
they would be retained: Anthropic's API does not train on API inputs; check a
free tier's terms before sending protocol content to it.

**Vision on page images — not used.** It is the stronger option for *scanned*
protocols, and none of the five are scanned. Against it: a native rasteriser,
higher cost per page, and — deciding the matter — it makes the model
*transcribe*, which is where a model is quietly wrong. Sending words we have
already read keeps the verbatim guarantee and lets every value be checked
mechanically. If scans mattered, this is the first thing to add.

**Not evaluated: Camelot, Tabula, AWS Textract, Azure Document Intelligence.**
The cloud services need paid accounts, and their table models flatten multi-row
grouped headers, which is a graded requirement here. This is a judgement call,
not a measurement.

Camelot and Tabula deserve a straighter answer, because their "lattice" mode
does what this tool ended up doing: read the ruled lines. That approach is
right, and arriving at it the slow way is the most useful thing this exercise
taught me. What is not in a general table library is the part that makes a
schedule readable — a footnote bound to the cell its marker sits on, a value
written across three columns, a heading that bands a group of visits, a word
set vertically between two phases, and a guard that refuses a better structural
reading when it would lose a mark. Those are the graded requirements, they are
most of the code here, and they would have had to be written on top of Camelot
regardless. Given the week again I would still read the rules directly, but I
would look at lattice mode on day one rather than on day six.

## Manual verification, per protocol

Method: render the source pages, put them beside the extracted grid, compare.
Every count below was read off the printed page, not taken from anywhere else.

**protocol1 (Lilly LZZT, pages 53–54) — geometry only, exact.** 14 visit
columns, 28 rows, 4 footnotes, `Xa`/`Xb`/`P` linked to the right cells. The
printed table has a **blank spacer column** where visit 6 would be; no visit is
invented for it and the gap is recorded as an ambiguity. Multi-line labels merge
into one row, and page 54's "Hemoglobin A1c" stitches onto page 53's
"Hemoglobin A1C" rather than becoming a second row. **No API call.**

**protocol5 (atomoxetine, Appendix I + II, rotated, pages 50–53) — exact, and
two schedules.** Appendix I: 11 columns (Up to −35, −15* to −9, −6, −2, −1, 7,
8, 12, 13, 17, 31), 31 rows, 10 footnotes — all correct. **Appendix II is
returned as a separate table**, 15 columns × 8 rows with its own 2 footnotes,
which is the brief's multi-SoA requirement working. It also satisfies a check
the document implies: PK samples for cocaine, 5 mL × (15+15+15) = **225 mL**,
exactly the printed Total Volume; grand total 390 mL.

**protocol12 (modafinil, Table 3, page 48 + notes on 49–50) — exact.** 9
columns, 40 rows with `Screening`/`Safety`/`Efficacy` as category rows, and all
14 footnotes including the block spilling onto the two following pages.

The ninth column is `RANDOMIZATION`, which the page prints **turned on its side
between the screening and treatment phases** — thirteen separate single-letter
items at one x. Read literally that is thirteen cells saying "R", "A", "N",
"D"…; read as a word it is a divider, flagged `divider: true` so anything
counting visits can exclude it. What separates it from a genuine column of
one-letter values is variety: protocol1 writes "P" for practice-only over and
over, and a word does not repeat itself that way. Markers
link per cell: `Alcohol breathalyzer` reads `X[a] X[b] X[b] X[b] X[b] X[c]`,
matching the printed superscripts. Values `3X/week`, `2X/week`, `Twice`,
`Weekly`, `12/ Term` verbatim.

**protocol15 (cabergoline, Table 1, page 25) — exact.** 10 columns including
its own vertical `RANDOMIZATION` divider, 34 rows, 5 footnotes (`*`, `Xa`–`Xd`).
Geometry alone originally got this wrong on every count, because the page prints
its superscripts as separate text items and its footnotes as `*Baseline...` and
`X a – Blood...`. The checks caught it and the review fixed it; the validator
discarded 5 unsupported values on the way. Reading the drawn grid has since
brought the rule-based path to 9 columns and 33 rows on its own — the printed
week row has eight timepoints plus the divider, so this is the count the page
supports.

**protocol9 (lofexidine, Table 4, four rotated pages 26–29) — columns correct,
one page of four verified.** Inferring the grid from the marks produced **30
columns for an 11-day study**. The review produced **11**, which the printed
header confirms (Study Day 1–11 under four phase bands) — and reading the ruled
grid now produces 11 with no model at all. Page 26 checked row by row and exact,
including three things worth naming:

- **Shaded-only rows** (`* Morphine`, `**Lofexidine or Placebo`,
  `Prior Medications`, `Emesis Tracking`) carry **no cells**. The document marks
  those with grey shading and no printed character, and neither path invents an
  "X" — it goes into `ambiguities` as a question for a clinician instead.
- **Spanning cells** printed as `Prior to Day 4` across days 1–3 survive verbatim.
- **CRF form numbers** `(01)`–`(14)` stay in the row labels, and
  `Primary Outcome Measure:` is correctly a category row.

Pages 27–29 were not checked cell by cell.

**What the confidence score is worth.** It ranked the five protocols in the same
order a by-hand check does, from the output alone — no ground truth, no model.
It found protocol9's failure without anyone opening the PDF, naming all four
symptoms, and it is what routed protocol15 to the review that fixed it.

**One reliability note.** On one run protocol15's review failed transiently and
the tool silently kept the geometric read — correct behaviour, but invisible.
The review now retries once before giving up.

## Where it breaks, and what it does

- **The confidence checks are the real limit.** They decide what gets reviewed,
  so a failure mode none of these five protocols exhibits will score `trust`,
  fire no review, and ship looking confident. protocol15 sat at `check` while
  being wrong on every count until a threshold was corrected. This is the
  honest residual risk on an unseen protocol.
- **The geometric rules are tuned in-sample.** Every one came from a failure on
  these five. Reading the drawn grid narrows this — a vertical rule is a fact
  about the document, not a threshold — but the parts around it are still
  judgement: which caption words name a header row, when a heading is banding
  several columns rather than naming one.
- **The word lists are English and finite.** A protocol captioning its phase row
  "Segment" or "Etapa" would not have that row recognised as a header. The shape
  of the rule generalises; the vocabulary does not.
- **A schedule drawn without rules** falls back to inferring the grid from the
  marks, with every weakness that has: a sparse column can go missing, a wrapped
  label can merge. All five assignment protocols and our mock are ruled, so the
  fallback is the *less* tested path despite being the original one.
- **A column whose cells hold words instead of marks is still not found.** This
  is the one known loss left. Columns are located from where the marks stack, so
  a visit recorded by *writing* in its column — a protocol listing which samples
  are collected at each visit — has no column to be found in. On the one unseen
  document that does this, five items of its sample list reach no cell. They are
  **named in the ambiguities** rather than dropped in silence, which is the
  difference between a known gap and an invisible one. Two attempts at reading
  the label boundary from the page's own whitespace were measured, changed
  nothing on the other seven documents, still failed to place the words, and
  were reverted.
- **Two unseen protocols were run end to end** and are the honest measure of how
  far the in-sample tuning travels. One reads clean against its printed page —
  37 rows, no missing values, nothing in the wrong column — after a single fix.
  The other exposed three faults at once and still has the loss above. Both sets
  of fixes were general: a row merged into a section heading it merely begins
  like, a header printed outside the box it belongs to, a timepoint read as a
  mark, placeholder column names blocking a continuation page from attaching.
- **Scanned pages.** No text layer means nothing to read and nothing to send.
  The tool says so; it does not invent a table. Page images would be the fix.
- **Visit windows.** The schema holds the field and it populates — Prot_000
  carries `±1` and `±2` windows — but only one document exercises it.
- **A review costs 30–150s** against about a second for geometry, which is why
  it is a fallback and not the default.
- **Reviews are not deterministic.** Two runs of the same pages can differ in
  row count by one or two, usually over blank rows like "Date" and "Day of
  Week". Within one output the linkage is self-consistent.
- **It never invents.** A ruled column with no heading and nothing in it does
  not become a visit — protocol1 draws a cell where the visit 6 it skips would
  be, and that column is recorded rather than reported. A shaded cell with no
  printed character does not become an "X". A value the model proposes that is
  not in the page text is discarded and recorded. A review that drops named rows
  is thrown away in favour of the rule-based read.

## Checking the output against the page

```bash
npm run audit                       # every document, BOTH readings
node scripts/audit.mjs protocol9    # one of them, in full
node scripts/audit.mjs ../any.pdf   # a document that is not in this repo:
                                    # extracted on the spot, then compared
```

Every defect found early in this build was found by eye, one cell at a time,
which is slow and misses things. This does it mechanically: it rebuilds the
table **as the page draws it** — straight from the ruled intersections and the
words inside them, with none of the extractor's row assembly, header roles,
footnote logic or continuation handling — and reports every place the two
disagree.

The third command is the one that earns its keep. The documents that find real
faults are the ones nobody has looked at, and those cannot be committed here, so
the audit takes a path and extracts on the spot. Both unseen protocols tried
this way were read correctly bar one row each, and both faults were general
enough to have been waiting for any document with the same shape.

**Both readings, because this repo makes two claims and only one was ever
checked.** For most of this build the audit read `public/outputs/*.json` and
nothing else — files that carry a model review. So it checked the FILES and
never the reader, while anyone dropping a PDF into the UI gets the rule-based
path. A bug living only there was structurally invisible, and one did live
there: protocol15's Treatment Week 1-3 column was being deleted outright by the
reader while the committed file held it correctly, and every run of this audit
called the document clean. Each document is now checked twice — as committed,
and as the reader produces it today.

Turning that on found, in its first run, a column rule drawn as two segments
that made `ruledBands` discard protocol12's entire drawn grid; a whole visit
column deleted on two documents by the word printed down the middle of the
schedule; and a phase heading banded by how far its ink reaches rather than by
what it is centred over, which put week 12 under Follow-up.

### What it compares

| Checked against the printed page | Count | Result |
|---|---|---|
| Rows and their values, every page, both readings | **546 rows** | 2 rows the rules leave out |
| Every cell, in the column the page prints it in | every paired column | 2 reports, both traced |
| Column headings, every page | **127 headings** | 0 unaccounted for |
| Footnote text, whole | **53 footnotes** | 0 not found on the page |

**Placement is the check that took longest to earn.** For most of this build the
audit compared each row's values as a multiset — "the page shows seven marks
here and we hold seven" — and never asked *which* column each was in. Cell by
cell had been tried twice and abandoned both times, because the two grids were
aligned by **position** and one narrow rule dropping out of the reconstruction
slid everything after it into forty reports that were the audit's own fault.

That blindness had a price. protocol15 prints "Weekly x 2 weeks" under Baseline
for five assessments and the published output filed all five under Screening;
every run passed, because every value was present. It took reading the two
tables side by side to see it.

What makes cell-by-cell work is pairing columns by **what they contain** — the
set of assessments marked in each — rather than by position or by heading.
Headings repeat, abbreviate on continuation pages, and collapse to a bare number
that matches anything containing it. A contents fingerprint survives all of
that, and one cell in the wrong place shifts a single member of a set of many,
so the pairing still lands and the stray cell falls out as the report. Two
further rules keep it honest: a pairing that **crosses** is wrong whatever it
scored, since neither table reorders its visits; and an exact heading match is
worth a great deal rather than a nudge, including for headings one character
long, which is every day column protocol9 has.

Comparison is deliberately forgiving where the page and the schema differ in
form but not in fact: cells match as token sets, so "a x" and "x a" are the same
cell; a marker counts as printed content, because "X" and its superscript "b"
are stored apart on purpose; a value written across **merged** cells is printed
once and held in every column it covers; and a bare marker letter alone in a
cell is not compared at all, because a superscript sits above its mark and
crosses the rule into the row above.

### What it says it cannot check

A checker that reports a clean bill for a document it never opened is worse than
no checker, because it is believed. So:

- **Pages with no ruled columns are counted and named**, and the run ends by
  saying that a count of zero on such a document means nothing was compared.
  Prot_111 draws no column rules at all: every page of it is skipped, and it
  used to finish with "0 discrepancy line(s) in all".
- **Columns with no counterpart in our table are listed with their headings**,
  not summed. Of 27 on these six documents, 13 belong to a *second grid* on
  protocol5's page 51 — the blood-collection appendix, never this schedule's to
  hold — and 2 are the divider column, which the extractor holds nothing in by
  design. Twelve are genuine gaps and are named so they can be argued with.
- Pages carrying no grid, and pages where a *different* table begins, are not
  compared against this one: protocol5's footnotes spill onto the page its
  appendix starts on, and audited naively the main schedule was told it had lost
  every row of a table that is not its own.

Reaching further by guessing was tried and rejected. Pairing on a heading that
merely *contains* the visit closes one of those twelve gaps and opens a false
report, matching a column headed "2 / 14 / ±1 / V 3" against "V 5".

### What it found

Eight cells across three documents, every one of them in output a model had
already reviewed, every one invisible to the checks that existed at the time:

| Document | Fault | Evidence on the page |
|---|---|---|
| protocol15 ×5 | "Weekly x 2 weeks" filed under Screening | The words sit at x257–294; Screening is ruled x202–251 and Baseline x251–301 |
| protocol12 ×1 | AISRS mark filed under Study Week 1-3 | The mark sits at x373, inside the cell ruled 362–389, which is Week 4 |
| protocol12 ×1 | ASI-Lite's Week 5-7 cell stripped of its "X" | "X" at y449 with "b" at y446 over "wk 6" at y457 — one cell, two lines |
| 3041835 ×1 | "Randomisation via Sealed Envelope" merged into the section head above it | Row matching allowed a prefix of any length |

The last one is worth reading twice: the row's mark was filed against a section
heading the page marks nowhere, and the row's own name was gone from the table.

Footnote text is compared with the spaces taken out and then word by word,
because the page breaks a footnote wherever its column ends, and sets "FEV1" as
"FEV" and a small "1" — which reads back with a space. Comparing literally
called a footnote that is verbatim on the page missing.


## Guarding against regression

`npm test` runs sixteen checks over the six documents, pinned to counts verified
against the printed pages. They skip rather than fail when the protocols are not
beside the project, since those are not redistributable.

They are also what makes it safe to keep changing the reader. Every fix in this
build was measured against **all eight** documents before it was kept, and the
bar was that the seven it was not aimed at come back byte-identical — same rows,
same labels, same cells, same columns. Three changes that did not clear that bar
were reverted rather than argued for, and two more were removed once measurement
showed they changed nothing on any document.

The suite exists because almost every defect found while building this was a
*regression*: a rule added for one protocol quietly took a row or a column away
from another, and nothing said so. Reading the output of the document you are
working on cannot tell you that — an empty cell looks exactly like a cell the
protocol left empty, and a row that is gone leaves no trace at all. One such bug
removed "Adverse events" from protocol1 entirely and survived several rounds of
review by eye.

The suite was mutation-tested rather than trusted: reintroducing that bug turns
it red. Doing so also showed that one of the two changes made to fix it was not
load-bearing, and the comment claiming otherwise was corrected.

It runs on every push (`.github/workflows/test.yml`). Most cases skip in CI for
want of the protocols; what runs there is the held-out mock, which is enough to
prove the pipeline loads, reads a 97-page PDF and still finds the eighteen
columns it should.

## Questions for a clinical SME

- protocol9 marks some rows by **grey shading with no printed character**. Is
  shaded-equals-scheduled the intended reading? The tool refuses to invent an
  "X" and describes the situation instead.
- protocol1 prints "Study drug record / Medications dispensed / Medications
  returned" as one bordered row with three lines. Is that one activity or three?
- Where a document's own footnote usage is inconsistent (protocol15 uses `Xb`
  where neighbouring rows use `Xc`), the tool preserves the inconsistency. Should
  it be flagged more loudly?

## What I would build next, given two more weeks

1. **More self-checks, and better ones.** They are the ceiling: the extractor is
   only as good as its ability to notice it is wrong. A check for "footnote
   markers that appear nowhere in the grid" already exists but is weighted low;
   protocol15 needed it weighted higher. Every new failure mode should become a
   check before it becomes a rule.
2. **A held-out corpus.** Everything here was tuned against five protocols, so
   every number is in-sample. Public protocols from ClinicalTrials.gov, run once
   before fixing anything, would give a real first-contact figure.
3. **A vision path for scanned protocols**, behind the same confidence gate —
   the one failure neither current path can touch.
4. **Cache the page text per protocol** so a re-review costs input tokens once.
5. **Cell-level provenance** — page and coordinates per cell, so the UI can point
   at the exact spot on the source page rather than showing the page's text.

## AI tools used

Claude (via Claude Code) throughout: the pipeline, the UI, this README. Claude
is also *in* the product, as the review path — `claude-sonnet-5`.

**Where it helped:** turning a symptom into a cause. "protocol12 reports 30
footnotes" became "wrapped lines beginning with a two-letter word are parsed as
definitions" in one pass of instrumenting rather than several of guessing. The
same for protocol15's superscripts, which turned out to be drawn as separate
text items.

**Where it got in the way, specifically:**

- It proposed a **wrong cause** for protocol9's column bug — "the header row is
  misclassified by position" — and the fix built on that theory changed nothing
  on protocol9 while breaking protocol5 from 14 columns to 25. Reverted. The
  real cause was upstream, in how those pages are banded.
- It was **wrong about cost twice**, in the same direction, and only stopped
  being wrong when the code was made to print `usage` per call. Estimating
  replaced measuring for far too long.
- Iterating **against the paid path** rather than `--no-assist` burned a trial
  credit on re-runs that a local flag would have made free.

Those three are the same failure: **confidence without measurement**. It is also
exactly what `confidence.js` exists to catch in the extractor and what the
source-text validator exists to catch in the model's own output. The rule the
tool follows is the one that had to be learned building it — *do not report a
result you have not checked against the source*, whether it came from rules or
from a model.

## Layout

```
src/ingest.js     PDF → upright positioned words
src/locate.js     page scoring, candidate ranges, evidence
src/extract.js    grid reconstruction, footnotes, linkage, ambiguities
src/confidence.js self-checks, verdict, which pages need a second opinion
src/assist.js     the second opinion: Claude on positioned text, values validated
src/env.js        loads .env if there is one; the tool works without it
src/schema.js     one published shape, whichever path read the table
src/pipeline.js   the sequence the CLI and UI share
src/server.js     the UI server (no framework, no build step)
src/ui.html       upload, rendered grid, clickable footnote linkage
src/cli.js        batch extraction to outputs/
outputs/          committed output for all five protocols
```
