/*
 * env.js — load a .env file if there is one.
 *
 * The tool works with no key at all, so this is deliberately quiet: a missing
 * or unreadable .env is not an error, it just means the geometric path runs on
 * its own. Node has read this format natively since 20.6, so there is no
 * dependency here and nothing to install.
 */

export function loadEnv() {
  if (typeof process.loadEnvFile !== 'function') return false;
  for (const path of ['.env', '../.env']) {
    try {
      process.loadEnvFile(path);
      return true;
    } catch {
      // No file there, or not readable. Try the next, then give up quietly.
    }
  }
  return false;
}
