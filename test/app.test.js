import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.js';
import { createRuntime } from '../server/runtime.js';
import { createUsageService } from '../server/usage.js';
import { SAMPLE_PAPERS } from '../shared/rulebook.js';
import { chatReply, createFakeStore, post, startStub, withApp } from './helpers.js';

/** A mock-mode config with usage control enabled, backed by an in-memory store (no Azure/network calls). */
function usageEnabledSetup(overrides = {}) {
  const config = loadConfig(
    {
      USAGE_CONTROL_ENABLED: 'true',
      USAGE_DAILY_GLOBAL_RACES: '1000',
      USAGE_SIGNING_SECRET: 'app-test-signing-secret',
      USAGE_TABLE_ENDPOINT: 'https://example.table.core.windows.net',
      ...overrides.env,
    },
    { mock: true },
  );
  const store = createFakeStore();
  const usage = createUsageService({ ...config.usage, ...overrides.usage }, { store, clock: overrides.clock });
  return { config, runtime: createRuntime(config), usage, store };
}

/** A runtime double that records calls instead of doing any real work, so tests can prove it was/was not reached. */
function spyRuntime(config) {
  const calls = { prepare: 0, test: 0, decide: 0 };
  return {
    calls,
    publicConfig: () => ({}),
    async prepare(options) {
      calls.prepare += 1;
      return config.desks.map((desk) => ({ deskId: desk.id, ok: true }));
    },
    async test(options) {
      calls.test += 1;
      return [];
    },
    async decide(request, options) {
      calls.decide += 1;
      return { ok: true, deskId: request.deskId, paperId: request.paper.id, decision: 'approve', latencyMs: 1, attempts: 1 };
    },
  };
}

const START = { runId: 'run-app-1', queueSize: 10, profiles: ['JEV', 'FAST_LLM'] };

const mockSetup = () => {
  const config = loadConfig({}, { mock: true });
  return { config, runtime: createRuntime(config) };
};

const validBody = (extra = {}) => ({ deskId: 1, paper: { id: 1, dossier: SAMPLE_PAPERS.reject, ...extra } });
/** A valid decide body with a top-level operationId, as a permit-protected request requires. */
const authedDecideBody = (operationId) => ({ ...validBody(), operationId });

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

// ---- U3: usage-control enforcement at the HTTP layer ---------------------------------------------

test('disabled usage control preserves existing /api/prepare, /api/test, and /api/decide behavior', async () => {
  const { config, runtime } = mockSetup();
  await withApp(config, runtime, async (base) => {
    assert.equal((await post(`${base}/api/prepare`, {})).status, 200);
    assert.equal((await post(`${base}/api/test`, {})).status, 200);
    const decide = await post(`${base}/api/decide`, validBody());
    assert.equal(decide.status, 200);
    assert.equal((await decide.json()).ok, true);
    const start = await post(`${base}/api/races/start`, START);
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { enabled: false });
  });
});

test('an enabled Start request accepts each supported queue size and known profiles, sets the visitor cookie, and never calls the runtime', async () => {
  const { config, usage } = usageEnabledSetup();
  const runtime = spyRuntime(config);
  await withApp(config, runtime, usage, async (base) => {
    for (const queueSize of [10, 20, 30, 50]) {
      const res = await post(`${base}/api/races/start`, { ...START, runId: `run-${queueSize}`, queueSize });
      assert.equal(res.status, 200, queueSize);
      assert.equal(res.headers.get('cache-control'), 'no-store, private');
      const json = await res.json();
      assert.equal(typeof json.permit, 'string');
      assert.ok(json.resetAt && json.expiresAt);
      assert.match(res.headers.get('set-cookie') ?? '', /^av=/);
    }
    assert.deepEqual(runtime.calls, { prepare: 0, test: 0, decide: 0 });
  });
});

test('unknown profiles, unsupported queue sizes, malformed run ids, malformed JSON, foreign origins, and wrong methods are rejected before allocation', async () => {
  const { config, usage, store } = usageEnabledSetup();
  const runtime = spyRuntime(config);
  await withApp(config, runtime, usage, async (base) => {
    const url = `${base}/api/races/start`;
    assert.equal((await post(url, { ...START, profiles: ['NOPE'] })).status, 400);
    assert.equal((await post(url, { ...START, queueSize: 15 })).status, 400);
    assert.equal((await post(url, { ...START, runId: 'bad run id!' })).status, 400);
    assert.equal((await post(url, { ...START, runId: '' })).status, 400);
    assert.equal((await post(url, '{not json')).status, 400);
    assert.equal((await post(url, START, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(url)).status, 405);
    assert.equal(store.rows.size, 0, 'no usage row was ever created for a rejected request');
    assert.deepEqual(runtime.calls, { prepare: 0, test: 0, decide: 0 });
  });
});

test('missing, invalid, expired, and visitor-mismatched permits prevent runtime.prepare and runtime.decide from being called', async () => {
  const { config, usage } = usageEnabledSetup();
  const runtime = spyRuntime(config);
  await withApp(config, runtime, usage, async (base) => {
    // Missing permit header entirely.
    const noPermit = await post(`${base}/api/prepare`, { operationId: 'op-1' });
    assert.equal(noPermit.status, 401);
    assert.equal((await noPermit.json()).code, 'race_permit_required');

    // A start grants a permit...
    const start = await post(`${base}/api/races/start`, START);
    const { permit } = await start.json();
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];

    // ...but an altered permit does not authorize anything.
    const altered = permit.slice(0, -1) + (permit.at(-1) === 'a' ? 'b' : 'a');
    const badPermit = await post(`${base}/api/prepare`, { operationId: 'op-1' }, { 'x-race-permit': altered, cookie });
    assert.equal(badPermit.status, 403);
    assert.equal((await badPermit.json()).code, 'race_permit_invalid');

    // ...and a permit used without its matching visitor cookie does not authorize anything either.
    const noCookie = await post(`${base}/api/prepare`, { operationId: 'op-1' }, { 'x-race-permit': permit });
    assert.equal(noCookie.status, 403);
    assert.equal((await noCookie.json()).code, 'race_permit_invalid');

    assert.deepEqual(runtime.calls, { prepare: 0, test: 0, decide: 0 });
  });
});

test('a permit rejected as expired by a later clock prevents runtime.prepare from being called', async () => {
  const store = createFakeStore();
  const baseEnv = {
    USAGE_CONTROL_ENABLED: 'true',
    USAGE_DAILY_GLOBAL_RACES: '1000',
    USAGE_SIGNING_SECRET: 'expiry-secret',
    USAGE_TABLE_ENDPOINT: 'https://example.table.core.windows.net',
  };
  const config = loadConfig(baseEnv, { mock: true });
  const startInstant = Date.parse('2026-10-14T10:00:00Z');
  const usageAtStart = createUsageService({ ...config.usage, permitMinutes: 1 }, { store, clock: () => startInstant });

  let permit, cookie;
  await withApp(config, spyRuntime(config), usageAtStart, async (base) => {
    const start = await post(`${base}/api/races/start`, START);
    ({ permit } = await start.json());
    cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
  });

  // A later instance (or restart) of the same deployment, five minutes on, sees the permit as expired.
  const usageLater = createUsageService({ ...config.usage, permitMinutes: 1 }, { store, clock: () => startInstant + 5 * 60_000 });
  const laterRuntime = spyRuntime(config);
  await withApp(config, laterRuntime, usageLater, async (base) => {
    const res = await post(`${base}/api/prepare`, { operationId: 'op-1' }, { 'x-race-permit': permit, cookie });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'race_permit_invalid');
    assert.deepEqual(laterRuntime.calls, { prepare: 0, test: 0, decide: 0 });
  });
});

test('a valid permit authorizes exactly one preparation and the race decision budget, preserving existing response shapes', async () => {
  const { config, usage } = usageEnabledSetup();
  const runtime = createRuntime(config); // the real runtime: proves response bodies are unchanged, not just that it was called
  await withApp(config, runtime, usage, async (base) => {
    const start = await post(`${base}/api/races/start`, { ...START, queueSize: 10, profiles: ['JEV', 'FAST_LLM'] });
    const { permit } = await start.json();
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];
    const auth = { 'x-race-permit': permit, cookie };

    const prepared = await post(`${base}/api/prepare`, { operationId: 'op-prep', profiles: ['JEV', 'FAST_LLM'] }, auth);
    assert.equal(prepared.status, 200);
    const preparedJson = await prepared.json();
    assert.equal(preparedJson.desks.length, 2, 'response shape (one entry per requested desk) is unchanged');

    // Repeating the same operation id is recognized, not replayed.
    assert.equal((await post(`${base}/api/prepare`, { operationId: 'op-prep', profiles: ['JEV', 'FAST_LLM'] }, auth)).status, 200);
    // A different operation id for the same permit is a replay refusal, not another preparation.
    const secondPrep = await post(`${base}/api/prepare`, { operationId: 'op-prep-2' }, auth);
    assert.equal(secondPrep.status, 409);
    assert.equal((await secondPrep.json()).code, 'race_operation_replayed');

    // queueSize 10 x deskCount 2 = 20 decisions are authorized; the 21st is refused before reaching the runtime.
    // Run concurrently: the simulated per-model delay would make 20 sequential mock calls too slow for a unit test.
    const decideBody = (i) => ({ deskId: (i % 2) + 1, profile: (i % 2) === 0 ? 'JEV' : 'FAST_LLM', paper: { id: i, dossier: SAMPLE_PAPERS.reject }, operationId: `d-${i}` });
    const results = await Promise.all(Array.from({ length: 20 }, (_, idx) => post(`${base}/api/decide`, decideBody(idx + 1), auth)));
    for (const [idx, res] of results.entries()) assert.equal(res.status, 200, `decision ${idx + 1}`);
    for (const res of results) assert.equal((await res.json()).ok, true, 'each decision keeps its existing response shape');
    const over = await post(`${base}/api/decide`, decideBody(21), auth);
    assert.equal(over.status, 403);
    assert.equal((await over.json()).code, 'race_permit_invalid');
  });
});

test('repeating one decide operation id is recognized and does not call runtime.decide a second time', async () => {
  const { config, usage } = usageEnabledSetup();
  const runtime = spyRuntime(config);
  await withApp(config, runtime, usage, async (base) => {
    const start = await post(`${base}/api/races/start`, START);
    const { permit } = await start.json();
    const auth = { 'x-race-permit': permit, cookie: (start.headers.get('set-cookie') ?? '').split(';')[0] };
    const body = { deskId: 1, profile: 'JEV', paper: { id: 1, dossier: SAMPLE_PAPERS.reject }, operationId: 'd-1' };

    assert.equal((await post(`${base}/api/decide`, body, auth)).status, 200);
    assert.equal(runtime.calls.decide, 1);
    const replay = await post(`${base}/api/decide`, body, auth);
    assert.equal(replay.status, 200, 'the same operation id is recognized, not re-run');
    assert.equal((await replay.json()).recognized, true);
    assert.equal(runtime.calls.decide, 1, 'runtime.decide is not called a second time for a replayed operation id');
  });
});

test('visitor, global, and burst limit failures return 429, stable codes, reset data, and Retry-After, without calling the runtime', async () => {
  const visitor = usageEnabledSetup({ usage: { visitorDailyLimit: 1 } });
  const visitorRuntime = spyRuntime(visitor.config);
  await withApp(visitor.config, visitorRuntime, visitor.usage, async (base) => {
    const first = await post(`${base}/api/races/start`, { ...START, runId: 'visitor-1' });
    assert.equal(first.status, 200);
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0];
    // fetch() has no cookie jar; the second request must carry the same visitor cookie explicitly to hit its limit.
    const res = await post(`${base}/api/races/start`, { ...START, runId: 'visitor-2' }, { cookie });
    assert.equal(res.status, 429);
    const json = await res.json();
    assert.equal(json.code, 'visitor_daily_limit');
    assert.ok(json.resetAt);
    assert.ok(res.headers.get('retry-after'));
    assert.deepEqual(visitorRuntime.calls, { prepare: 0, test: 0, decide: 0 });
  });

  const { config, usage } = usageEnabledSetup({ usage: { dailyGlobalRaces: 0 } });
  const runtime = spyRuntime(config);
  await withApp(config, runtime, usage, async (base) => {
    const res = await post(`${base}/api/races/start`, START);
    assert.equal(res.status, 429);
    const json = await res.json();
    assert.equal(json.code, 'global_daily_limit');
    assert.ok(json.resetAt);
    assert.ok(res.headers.get('retry-after'));
    assert.deepEqual(runtime.calls, { prepare: 0, test: 0, decide: 0 });
  });

  const burst = usageEnabledSetup({ usage: { startsPerMinute: 1 } });
  const burstRuntime = spyRuntime(burst.config);
  await withApp(burst.config, burstRuntime, burst.usage, async (base) => {
    assert.equal((await post(`${base}/api/races/start`, { ...START, runId: 'burst-1' })).status, 200);
    const res = await post(`${base}/api/races/start`, { ...START, runId: 'burst-2' });
    assert.equal(res.status, 429);
    const json = await res.json();
    assert.equal(json.code, 'start_rate_limit');
    assert.ok(res.headers.get('retry-after'));
    assert.deepEqual(burstRuntime.calls, { prepare: 0, test: 0, decide: 0 });
  });
});

test('storage failure returns 503 usage_control_unavailable and does not call a provider-facing runtime method', async () => {
  const { config, usage, store } = usageEnabledSetup();
  store.submitTransaction = async () => { throw Object.assign(new Error('network down'), { code: 'unavailable' }); };
  const runtime = spyRuntime(config);
  await withApp(config, runtime, usage, async (base) => {
    const res = await post(`${base}/api/races/start`, START);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'usage_control_unavailable');
    assert.deepEqual(runtime.calls, { prepare: 0, test: 0, decide: 0 });
  });
});

test('live protected mode (usage control enabled, not mock) returns not found for /api/test; mock mode retains it', async () => {
  const { config, usage } = usageEnabledSetup();
  const protectedConfig = { ...config, mock: false };
  const runtime = spyRuntime(config);
  await withApp(protectedConfig, runtime, usage, async (base) => {
    assert.equal((await post(`${base}/api/test`, {})).status, 404);
  });

  const mockEnabled = usageEnabledSetup();
  await withApp(mockEnabled.config, spyRuntime(mockEnabled.config), mockEnabled.usage, async (base) => {
    assert.equal((await post(`${base}/api/test`, {})).status, 200, 'mock mode keeps the test route even with usage control enabled');
  });
});

test('start and protected responses prevent caching, and permits never appear in error bodies', async () => {
  const { config, usage } = usageEnabledSetup();
  const runtime = spyRuntime(config);
  await withApp(config, runtime, usage, async (base) => {
    const start = await post(`${base}/api/races/start`, START);
    assert.equal(start.headers.get('cache-control'), 'no-store, private');
    const { permit } = await start.json();
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0];

    const altered = permit.slice(0, -1) + (permit.at(-1) === 'a' ? 'b' : 'a');
    const bad = await post(`${base}/api/decide`, authedDecideBody('d-1'), { 'x-race-permit': altered, cookie });
    assert.equal(bad.headers.get('cache-control'), 'no-store, private');
    const text = await bad.text();
    assert.ok(!text.includes(permit), 'the valid permit never leaks into an unrelated error body');
    assert.ok(!text.includes(altered), 'the rejected permit itself is never echoed back');
  });
});

test('a client disconnect still aborts an authorized in-flight runtime call', async () => {
  let aborted = false;
  const { config, usage } = usageEnabledSetup();
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
  await withApp(config, runtime, usage, async (base) => {
    const start = await post(`${base}/api/races/start`, START);
    const { permit } = await start.json();
    const auth = { 'x-race-permit': permit, cookie: (start.headers.get('set-cookie') ?? '').split(';')[0] };
    const controller = new AbortController();
    const aborting = fetch(`${base}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(authedDecideBody('d-1')),
      signal: controller.signal,
    }).catch(() => null);
    setTimeout(() => controller.abort(), 100);
    await aborting;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(aborted, true);
  });
});

test('an upstream provider failure keeps its own classification: it is a 200 ok:false runtime result, not a UsageError, and the reservation is still consumed', async () => {
  const { config, usage } = usageEnabledSetup();
  const runtime = {
    publicConfig: () => ({}),
    decide: async () => ({ ok: false, error: 'HTTP 502: upstream exploded', code: 'upstream', status: 502 }),
  };
  await withApp(config, runtime, usage, async (base) => {
    const start = await post(`${base}/api/races/start`, START);
    const { permit } = await start.json();
    const auth = { 'x-race-permit': permit, cookie: (start.headers.get('set-cookie') ?? '').split(';')[0] };

    const first = await post(`${base}/api/decide`, authedDecideBody('d-1'), auth);
    assert.equal(first.status, 200, 'an upstream failure is reported in the body, not as an HTTP/usage error');
    const firstJson = await first.json();
    assert.equal(firstJson.ok, false);
    assert.equal(firstJson.code, 'upstream', 'the upstream classification is preserved, distinct from any usage code');

    // KTD5: the reservation is consumed even though the provider call failed, so the *same* operation id now replays.
    const replay = await post(`${base}/api/decide`, authedDecideBody('d-1'), auth);
    assert.equal(replay.status, 200, 'a replayed operation id is recognized, not re-reserved or re-run');
    assert.equal((await replay.json()).recognized, true, 'the replay is answered from the reservation alone, without re-invoking the runtime');
  });
});
