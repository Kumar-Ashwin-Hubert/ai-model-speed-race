import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server/app.js';
import { loadConfig } from './server/config.js';
import { loadEnv } from './server/env.js';
import { createRuntime } from './server/runtime.js';

const MAX_PORT_ATTEMPTS = 10;

function listen(server, host, port, attempt = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS) {
        console.warn(`Port ${port} is busy, trying ${port + 1}...`);
        resolve(listen(server, host, port + 1, attempt + 1));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

function printBanner(config, port) {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  AI MODEL SPEED RACE  ->  http://${shownHost}:${port}\n`);
  if (config.mock) console.log('  MOCK MODE: models are SIMULATED, no API calls are made.\n');
  for (const desk of config.desks) {
    const status = desk.configured ? (config.mock ? 'simulated' : 'ready') : `NOT READY, set ${desk.missing.join(', ')}`;
    const via = desk.kind === 'systemone' ? `system one/${desk.mode}` : desk.api;
    console.log(`  Desk ${desk.id}  ${desk.label.padEnd(18)} ${desk.providerLabel.padEnd(17)} ${(desk.model || '-').padEnd(20)} ${via.padEnd(18)} ${status}`);
  }
  for (const warning of config.warnings) console.log(`\n  Warning: ${warning}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    console.log('\n  Warning: the server is reachable from your network and its API spends your credits without a login.');
  }
  console.log('\n  Tip: run "npm run check" to test every connection with real calls.\n');
}

async function main() {
  loadEnv();
  const config = loadConfig(process.env, { mock: process.argv.includes('--mock') });
  const runtime = createRuntime(config);
  const server = http.createServer(createApp(config, runtime));
  const port = await listen(server, config.host, config.port);
  printBanner(config, port);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
