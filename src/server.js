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

// Imports are hoisted, so this runs before any code below reads process.env.
loadEnv();

const PORT = Number(process.env.PORT || 3100);
const page = fileURLToPath(new URL('../public/index.html', import.meta.url));

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
      const result = await run(data);
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
  console.log(`SoA extractor on http://localhost:${PORT}`);
});
