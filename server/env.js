import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Loads <project>/.env into process.env without overriding variables that are already set. */
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (typeof process.loadEnvFile !== 'function') {
    console.warn(`This Node.js (${process.versions.node}) cannot read the .env file, so your keys are not loaded. Install Node.js 20.12 or newer from https://nodejs.org`);
    return;
  }
  try {
    process.loadEnvFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not read ${file}: ${error.message}`);
  }
}
