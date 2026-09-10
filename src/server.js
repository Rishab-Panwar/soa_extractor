/*
 * server.js — upload a protocol, see what came out of it.
 *
 * No framework and no build step: the point of the UI is that a reviewer can
 * drop in a PDF the tool has never seen and check the result against the
 * source, and every dependency between them is a thing that can fail to
 * install. One file, one page, `node src/server.js`.
 */

import { loadEnv } from './env.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { run } from './pipeline.js';
import { available } from './assist.js';

// Imports are hoisted, so this runs before any code below reads process.env.
loadEnv();

const PORT = Number(process.env.PORT || 3100);
const page = fileURLToPath(new URL('../public/index.html', import.meta.url));

/*
 * Whether the model review may run, said out loud at startup.
 *
 * A key in .env was enough to turn the review on, and nothing announced it —
 * so the same upload could cost money or not depending on a file you last
 * looked at weeks ago, and there was no way to run the geometric path alone to
 * compare against. SOA_ALLOW_REVIEW now decides when it is set; unset, the
 * behaviour is what it has always been.
 */
const asked = process.env.SOA_ALLOW_REVIEW;
const ALLOW_REVIEW = asked === undefined || asked === ''
  ? undefined
  : !/^(0|false|no|off)$/i.test(asked);

/** Read a whole request body, with a ceiling so a bad upload cannot fill memory. */
function body(request, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('file too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    // Serve the committed outputs so the sample buttons work locally too.
    if (request.method === 'GET' && request.url.startsWith('/outputs/')) {
      const name = request.url.slice('/outputs/'.length).replace(/[^a-zA-Z0-9._-]/g, '');
      try {
        const file = await readFile(fileURLToPath(new URL('../public/outputs/' + name, import.meta.url)));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(file);
      } catch {
        response.writeHead(404); response.end('not found');
      }
      return;
    }

    if (request.method === 'GET' && (request.url === '/' || request.url.startsWith('/?'))) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(page));
      return;
    }

    if (request.method === 'POST' && request.url === '/extract') {
      const data = await body(request);
      if (!data.length) throw new Error('no file received');
      const started = Date.now();
      // Logged, because the review only runs on a table the checks distrust —
      // so an upload that reads well is identical either way, and without this
      // there is no way to tell "the switch did nothing" from "the switch is
      // broken".
      const log = (stage, message) => console.log(`  ${stage}: ${message}`);
      const result = await run(data, ALLOW_REVIEW === undefined ? { log } : { assist: ALLOW_REVIEW, log });
      result.tookMs = Date.now() - started;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  } catch (error) {
    // The reviewer needs to know what went wrong, not just that it did.
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }));
  }
});

server.listen(PORT, () => {
  const on = ALLOW_REVIEW === undefined ? available() : ALLOW_REVIEW && available();
  console.log(`SoA extractor on http://localhost:${PORT}`);
  console.log(on
    ? `  model review: ON — a table the checks cannot trust is sent for a second opinion, which costs an API call.`
    : `  model review: OFF — everything is read from the page geometry alone, offline and free.`);
  console.log(`  set SOA_ALLOW_REVIEW=0 to force it off, =1 to force it on.`);
});
