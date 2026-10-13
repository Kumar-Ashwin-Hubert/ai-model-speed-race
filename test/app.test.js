import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createRuntime } from '../server/runtime.js';
import { SAMPLE_PAPERS } from '../shared/rulebook.js';
import { chatReply, startStub } from './helpers.js';

async function withApp(config, runtime, fn) {
  const server = http.createServer(createApp(config, runtime));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const mockSetup = () => {
  const config = loadConfig({}, { mock: true });
  return { config, runtime: createRuntime(config) };
};

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const validBody = (extra = {}) => ({ deskId: 1, paper: { id: 1, dossier: SAMPLE_PAPERS.reject, ...extra } });

/** Raw request so tests can control the Host header and the exact path. */
function rawRequest(port, { path, headers = {}, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/config exposes the desks and the mode, with security headers', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base) => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const json = await res.json();
    assert.equal(json.mock, true);
    assert.equal(json.desks.length, 3);
    assert.deepEqual(json.desks.map((d) => d.id), [1, 2, 3]);
  });
});

test('POST /api/decide returns a decision', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base) => {
    const res = await post(`${base}/api/decide`, validBody({ hint: { truth: 'reject', violations: ['contraband'] } }));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(['approve', 'reject'].includes(json.decision));
    assert.equal(json.deskId, 1);
  });
});

test('POST /api/decide validates its input', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base) => {
    const url = `${base}/api/decide`;
    assert.equal((await post(url, { ...validBody(), deskId: 7 })).status, 400);
    assert.equal((await post(url, { deskId: 1, paper: { id: 0, dossier: SAMPLE_PAPERS.reject } })).status, 400);
    assert.equal((await post(url, { deskId: 1, paper: { id: 1, dossier: { ...SAMPLE_PAPERS.reject, passport: '' } } })).status, 400);
    assert.equal((await post(url, { deskId: 1, paper: { id: 1 } })).status, 400);
    assert.equal((await post(url, '{not json')).status, 400);
    assert.equal((await post(url, validBody(), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(url, JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))).status, 413);
  });
});

test('wrong methods and unknown routes are refused', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base) => {
    assert.equal((await fetch(`${base}/api/decide`)).status, 405);
    assert.equal((await post(`${base}/api/config`, {})).status, 405);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  });
});

test('cross-site and rebinding requests cannot spend credits', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base, port) => {
    const foreignOrigin = await post(`${base}/api/decide`, validBody(), { origin: 'https://evil.example' });
    assert.equal(foreignOrigin.status, 403);
    const rebinding = await rawRequest(port, { path: '/api/config', headers: { host: `evil.example:${port}` } });
    assert.equal(rebinding.status, 403);
    const sameOrigin = await post(`${base}/api/decide`, validBody(), { origin: base });
    assert.equal(sameOrigin.status, 200);
  });
});

test('only dossier fields reach the model: no ground truth, no hint, no extra keys', async () => {
  const stub = await startStub(() => chatReply('REJECT'));
  try {
    const config = loadConfig({ FOUNDRY_ENDPOINT: stub.url, FOUNDRY_API_KEY: 'k', DESK2_MODEL: 'm' });
    await withApp(config, createRuntime(config), async (base) => {
      const res = await post(`${base}/api/decide`, {
        deskId: 2,
        truth: 'reject',
        paper: {
          id: 5,
          truth: 'reject',
          violations: ['contraband'],
          hint: { truth: 'reject', violations: ['contraband'] },
          dossier: { ...SAMPLE_PAPERS.reject, truth: 'reject', secret: 'leak-me' },
        },
      });
      assert.equal((await res.json()).ok, true);
      const sent = JSON.stringify(stub.calls[0].body);
      for (const forbidden of ['truth', 'violations', 'hint', 'leak-me', 'secret']) assert.ok(!sent.includes(forbidden), `${forbidden} must not be forwarded`);
    });
  } finally {
    await stub.close();
  }
});

test('/api/test and /api/prepare answer per desk', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base) => {
    const prepared = await (await post(`${base}/api/prepare`, {})).json();
    assert.equal(prepared.desks.length, 3);
    const tested = await (await post(`${base}/api/test`, {})).json();
    assert.equal(tested.desks.length, 3);
    assert.ok(tested.desks.every((d) => d.checks.length === 2));
  });
});

test('a client disconnect aborts the in-flight model call', async () => {
  let aborted = false;
  const runtime = {
    publicConfig: () => ({}),
    decide: (_request, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ ok: false });
        });
      }),
  };
  await withApp(loadConfig({}, { mock: true }), runtime, async (base) => {
    const controller = new AbortController();
    const pending = post(`${base}/api/decide`, validBody()).catch(() => null);
    const aborting = fetch(`${base}/api/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody()), signal: controller.signal }).catch(() => null);
    setTimeout(() => controller.abort(), 100);
    await aborting;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(aborted, true);
    void pending;
  });
});

test('static files: shared modules are served, secrets and traversal are not', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base, port) => {
    const rulebook = await fetch(`${base}/shared/rulebook.js`);
    assert.equal(rulebook.status, 200);
    assert.match(rulebook.headers.get('content-type'), /javascript/);
    assert.match(await rulebook.text(), /export const RULES/);

    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/shared/.env`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
    for (const path of ['/..%2fpackage.json', '/%2e%2e/package.json', '/shared/..%2f.env', '/shared/%2e%2e%2fserver.js', '/..%5cpackage.json']) {
      const res = await rawRequest(port, { path });
      assert.equal(res.status, 404, path);
      assert.ok(!res.body.includes('"name"'), `${path} must not leak files`);
    }
    assert.equal((await rawRequest(port, { path: '/shared/rulebook.js', method: 'POST' })).status, 405);
  });
});
