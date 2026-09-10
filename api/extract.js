/*
 * api/extract.js — the deployed extractor.
 *
 * A serverless function has a wall clock, and that decides what runs here.
 * Reading a 250-page protocol geometrically takes under a second; a model
 * review of a four-page schedule takes ninety and would be killed mid-flight,
 * returning nothing at all rather than something honest. So the deployment runs
 * the geometric path and reports its own confidence — including, when the
 * self-checks fail, that this table would benefit from a review the hosted
 * version does not perform.
 *
 * That is also the safe default for a public URL: a key on a server with no
 * authentication in front of it is a key any visitor can spend. Reviews stay
 * where they can be watched — the CLI, run locally.
 *
 * Set SOA_ALLOW_REVIEW=1 with a key configured to override this, understanding
 * both consequences.
 */

import { run } from '../src/pipeline.js';

export const config = { api: { bodyParser: false } };

/** Collect the raw request body, refusing anything implausible for a protocol. */
function readBody(request, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('file too large — the hosted version accepts up to 12 MB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'POST a PDF to this endpoint' });
    return;
  }

  try {
    const data = await readBody(request);
    if (!data.length) throw new Error('no file received');

    const started = Date.now();
    /*
     * The visitor chooses, within what the deployment allows.
     *
     * The page offers both readings side by side, so the choice arrives as
     * ?review=1 — but the key belongs to whoever deployed this, and a button on
     * a public URL must not be able to spend it against their wishes. So the
     * request can only ever turn the review OFF relative to what the
     * environment permits, never on.
     */
    const permitted = process.env.SOA_ALLOW_REVIEW === '1';
    const asked = new URL(request.url, 'http://localhost').searchParams.get('review') === '1';
    const assist = permitted && asked;

    const result = await run(data, { assist, log: () => {} });
    result.tookMs = Date.now() - started;
    result.reviewAsked = asked;
    result.reviewRan = assist;
    result.hosted = {
      reviewAvailable: permitted,
      note: permitted
        ? null
        : 'This deployment runs the geometric reader only — a review takes 90–150s against a '
          + '60s serverless limit, and an unauthenticated button must not spend an API key. '
          + 'Tables marked "fallback" are ones the checks do not trust; running the tool '
          + 'locally with a key sends those pages for a second opinion.',
    };

    response.status(200).json(result);
  } catch (error) {
    // A reviewer needs to know what went wrong, not merely that it did.
    response.status(400).json({ error: String(error && error.message ? error.message : error) });
  }
}
