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
    const result = await run(data, {
      // Off unless deliberately enabled: see the note at the top of this file.
      assist: process.env.SOA_ALLOW_REVIEW === '1',
      log: () => {},
    });
    result.tookMs = Date.now() - started;
    result.hosted = {
      reviewAvailable: process.env.SOA_ALLOW_REVIEW === '1',
      note: process.env.SOA_ALLOW_REVIEW === '1'
        ? null
        : 'This hosted version runs the geometric reader only. Tables marked "fallback" '
          + 'are ones its own checks do not trust; running the tool locally with an API key '
          + 'sends those pages for a second opinion.',
    };

    response.status(200).json(result);
  } catch (error) {
    // A reviewer needs to know what went wrong, not merely that it did.
    response.status(400).json({ error: String(error && error.message ? error.message : error) });
  }
}
