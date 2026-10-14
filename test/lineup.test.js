import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../server/config.js';
import { createRuntime } from '../server/runtime.js';
import { createUsageService } from '../server/usage.js';
import { SAMPLE_PAPERS } from '../shared/rulebook.js';
import { chatReply, createFakeStore, post, responsesReply, startStub, withApp } from './helpers.js';

const FOUNDRY_KEY = 'fk-test-0123456789';
const KODEKEY_KEY = 'kk-spare-secret-key';

const paper = (id = 1) => ({ id, dossier: SAMPLE_PAPERS.reject });

/** ALPHA (chat) and BETA (Responses) and GAMMA (auto) are the default line-up; SPARE (KodeKey) is only in the catalog. */
function setup(stub, env = {}) {
  const config = loadConfig({
    FOUNDRY_ENDPOINT: stub.url,
    FOUNDRY_API_KEY: FOUNDRY_KEY,
    KODEKEY_BASE_URL: `${stub.url}/v1`,
    KODEKEY_API_KEY: KODEKEY_KEY,
    LINEUP: 'ALPHA,BETA,GAMMA',
    MODEL_ALPHA_PROVIDER: 'foundry',
    MODEL_ALPHA_MODEL: 'alpha-dep',
    MODEL_BETA_PROVIDER: 'foundry',
    MODEL_BETA_URL: `${stub.url}/openai/v1/responses`,
    MODEL_BETA_MODEL: 'beta-dep',
    MODEL_GAMMA_PROVIDER: 'foundry',
    MODEL_GAMMA_MODEL: 'gamma-dep',
    MODEL_GAMMA_API: 'auto',
    MODEL_SPARE_PROVIDER: 'kodekey',
    MODEL_SPARE_MODEL: 'spare-dep',
    MAX_RETRIES: '0',
    REQUEST_TIMEOUT_MS: '5000',
    ...env,
  });
  return { config, runtime: createRuntime(config) };
}

async function withStub(handler, fn) {
  const stub = await startStub(handler);
  try {
    await fn(stub);
  } finally {
    await stub.close();
  }
}

// Chat for plain deployments; the "auto" one only works on the Responses API.
const routes = (call) => {
  if (call.body?.model === 'gamma-dep' && call.path === '/openai/v1/chat/completions') {
    return { status: 400, json: { error: { message: 'The chatCompletion operation does not work with the specified model.' } } };
  }
  if (call.path === '/openai/v1/chat/completions' || call.path === '/v1/chat/completions') return chatReply('APPROVE');
  if (call.path === '/openai/v1/responses') return responsesReply('REJECT');
  return undefined;
};

// ---- Config: the catalog -------------------------------------------------------------------------

test('the catalog lists every model profile in .env, the default line-up first, and skips stray MODEL_ variables', async () => {
  await withStub(routes, async (stub) => {
    const { config } = setup(stub, { MODEL_CACHE_DIR_LABEL: 'not a model', MODEL_NO_MODEL_PRICE_IN: '1' });
    assert.deepEqual(config.lineup, ['ALPHA', 'BETA', 'GAMMA']);
    assert.deepEqual(config.catalog.map((entry) => entry.profile), ['ALPHA', 'BETA', 'GAMMA', 'SPARE']);
    assert.deepEqual(config.desks.map((desk) => [desk.id, desk.profile]), [[1, 'ALPHA'], [2, 'BETA'], [3, 'GAMMA']]);
    assert.ok(config.catalog.every((entry) => entry.configured));
  });
});

test('a line-up that names fewer than three models is topped up with the older DESKn settings', () => {
  const config = loadConfig({ LINEUP: 'ONE', MODEL_ONE_MODEL: 'jev-x', MODEL_ONE_PROVIDER: 'kodekey', DESK3_MODEL: 'legacy-three', FOUNDRY_ENDPOINT: 'https://r.services.ai.azure.com' });
  assert.deepEqual(config.lineup, ['ONE', 'DESK2', 'DESK3']);
  assert.deepEqual(config.desks.map((desk) => desk.model), ['jev-x', '', 'legacy-three']);
  assert.equal(config.desks[1].configured, false);
  assert.deepEqual(config.catalog.map((entry) => entry.profile), ['ONE', 'DESK2', 'DESK3']);
});

test('simulated mode offers five named simulated models and seats the live line-up by default', () => {
  const config = loadConfig({}, { mock: true });
  assert.deepEqual(config.lineup, ['JEV', 'DECISION1', 'FAST_LLM']);
  assert.deepEqual(config.catalog.map((entry) => entry.profile), ['JEV', 'DECISION1', 'FAST_LLM', 'LARGE_LLM', 'REASONING_LLM']);
  assert.deepEqual(config.catalog.map((entry) => entry.sim), ['jev', 'decision1', 'fast', 'large', 'reasoning']);
  assert.deepEqual(config.catalog.map((entry) => entry.kind), ['systemone', 'systemone', 'llm', 'llm', 'llm']);
  assert.ok(config.catalog.every((entry) => entry.configured));
});

test('publicConfig exposes the catalog and line-up, never a secret, header or URL', async () => {
  await withStub(routes, async (stub) => {
    const { config } = setup(stub);
    const json = JSON.stringify(publicConfig(config));
    assert.ok(!json.includes(FOUNDRY_KEY) && !json.includes(KODEKEY_KEY));
    assert.ok(!/authorization|api-key|upstream|chatUrl|responsesUrl|systemOneUrl|http:/i.test(json));
    const shown = JSON.parse(json);
    assert.deepEqual(shown.lineup, ['ALPHA', 'BETA', 'GAMMA']);
    assert.deepEqual(shown.catalog.map((entry) => entry.profile), ['ALPHA', 'BETA', 'GAMMA', 'SPARE']);
    assert.deepEqual(shown.catalog.map((entry) => entry.provider), ['foundry', 'foundry', 'foundry', 'kodekey']);
  });
});

// ---- Runtime: any model at any desk --------------------------------------------------------------

test('a named model can sit at any desk and keeps its own route, deployment and API', async () => {
  await withStub(routes, async (stub) => {
    const { runtime } = setup(stub);

    const beta = await runtime.decide({ deskId: 3, profile: 'BETA', paper: paper() });
    assert.equal(beta.ok, true);
    assert.equal(beta.deskId, 3, 'results are reported by desk position');
    assert.equal(beta.decision, 'reject');
    assert.equal(stub.calls.at(-1).path, '/openai/v1/responses');
    assert.equal(stub.calls.at(-1).body.model, 'beta-dep');

    const spare = await runtime.decide({ deskId: 1, profile: 'SPARE', paper: paper() });
    assert.equal(spare.ok, true, 'a model outside the default line-up can be seated too');
    assert.equal(stub.calls.at(-1).path, '/v1/chat/completions');
    assert.equal(stub.calls.at(-1).body.model, 'spare-dep');
    assert.equal(stub.calls.at(-1).headers.authorization, `Bearer ${KODEKEY_KEY}`);

    const defaultDesk = await runtime.decide({ deskId: 1, paper: paper() });
    assert.equal(stub.calls.at(-1).body.model, 'alpha-dep', 'without a profile the default line-up applies');
    assert.equal(defaultDesk.ok, true);
  });
});

test('detection is remembered per model, so moving a model to another desk does not repeat it', async () => {
  await withStub(routes, async (stub) => {
    const { runtime } = setup(stub);
    const first = await runtime.decide({ deskId: 3, profile: 'GAMMA', paper: paper(1) });
    assert.equal(first.ok, true);
    assert.equal(runtime.llmApis.get('GAMMA'), 'responses');
    const callsAfterFirst = stub.calls.length;

    const moved = await runtime.decide({ deskId: 1, profile: 'GAMMA', paper: paper(2) });
    assert.equal(moved.ok, true);
    assert.equal(stub.calls.length, callsAfterFirst + 1, 'one timed call, no new detection');
    assert.equal(runtime.publicConfig().catalog.find((entry) => entry.profile === 'GAMMA').api, 'responses');
  });
});

test('an unknown model name is a failed result, not a crash', async () => {
  await withStub(routes, async (stub) => {
    const { runtime } = setup(stub);
    const result = await runtime.decide({ deskId: 2, profile: 'NOPE', paper: paper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unknown_desk');
    assert.match(result.error, /Unknown model "NOPE"/);
    assert.equal(stub.calls.length, 0);
  });
});

test('prepare and test follow the requested line-up, reporting by desk position', async () => {
  await withStub(routes, async (stub) => {
    const { runtime } = setup(stub);
    const prepared = await runtime.prepare({ profiles: ['BETA', 'ALPHA', 'GAMMA'] });
    assert.deepEqual(prepared.map((entry) => [entry.deskId, entry.ok, entry.api]), [[1, true, 'responses'], [2, true, 'chat'], [3, true, 'responses']]);

    const tested = await runtime.test({ profiles: ['SPARE', 'BETA'] });
    assert.deepEqual(tested.map((entry) => [entry.deskId, entry.ok]), [[1, true], [2, true]]);
    assert.ok(tested.every((entry) => entry.checks.length === 2));

    const onlySecond = await runtime.test({ profiles: ['SPARE', 'BETA'], deskIds: [2] });
    assert.deepEqual(onlySecond.map((entry) => entry.deskId), [2]);

    const withUnknown = await runtime.prepare({ profiles: ['ALPHA', 'NOPE'] });
    assert.deepEqual(withUnknown.map((entry) => [entry.deskId, entry.ok]), [[1, true], [2, false]]);
  });
});

test('keys of models outside the default line-up are redacted from errors too', async () => {
  const handler = (call) => (call.path === '/v1/chat/completions' ? { status: 400, json: { error: { message: `invalid key ${KODEKEY_KEY} rejected` } } } : undefined);
  await withStub(handler, async (stub) => {
    const { runtime } = setup(stub);
    const result = await runtime.decide({ deskId: 2, profile: 'SPARE', paper: paper() });
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes(KODEKEY_KEY), result.error);
    assert.match(result.error, /\*\*\*/);
  });
});

// ---- API ---------------------------------------------------------------------------------------

test('/api/config lists the catalog and the default line-up', async () => {
  const config = loadConfig({}, { mock: true });
  await withApp(config, createRuntime(config), async (base) => {
    const json = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(json.lineup, ['JEV', 'DECISION1', 'FAST_LLM']);
    assert.equal(json.catalog.length, 5);
    assert.deepEqual(json.desks.map((desk) => desk.profile), json.lineup);
  });
});

test('/api/decide accepts a known model name and refuses anything else', async () => {
  const config = loadConfig({}, { mock: true });
  await withApp(config, createRuntime(config), async (base) => {
    const url = `${base}/api/decide`;
    const ok = await post(url, { deskId: 3, profile: 'JEV', paper: { id: 1, dossier: SAMPLE_PAPERS.reject, hint: { truth: 'reject', violations: ['contraband'] } } });
    assert.equal(ok.status, 200);
    const json = await ok.json();
    assert.equal(json.ok, true);
    assert.equal(json.deskId, 3);
    assert.equal(json.detail.kind, 'systemone', 'JEV behaves like JEV at desk 3');

    for (const profile of ['NOPE', '', 7, null, ['JEV'], { name: 'JEV' }]) {
      const res = await post(url, { deskId: 1, profile, paper: { id: 1, dossier: SAMPLE_PAPERS.reject } });
      assert.equal(res.status, 400, JSON.stringify(profile));
    }
  });
});

test('/api/prepare and /api/test accept a line-up of known models only', async () => {
  const config = loadConfig({}, { mock: true });
  await withApp(config, createRuntime(config), async (base) => {
    const lineup = ['FAST_LLM', 'DECISION1', 'JEV'];
    const prepared = await (await post(`${base}/api/prepare`, { profiles: lineup })).json();
    assert.deepEqual(prepared.desks.map((desk) => desk.deskId), [1, 2, 3]);
    const tested = await (await post(`${base}/api/test`, { profiles: lineup })).json();
    assert.equal(tested.desks.length, 3);
    assert.ok(tested.desks.every((desk) => desk.ok));

    for (const profiles of [['NOPE'], [], 'JEV', ['JEV', 'JEV', 'JEV', 'JEV'], [1, 2, 3], { 0: 'JEV' }]) {
      for (const route of ['prepare', 'test']) {
        const res = await post(`${base}/api/${route}`, { profiles });
        assert.equal(res.status, 400, `${route} ${JSON.stringify(profiles)}`);
      }
    }
    assert.equal((await post(`${base}/api/prepare`, {})).status, 200, 'no line-up means the default one');
    assert.equal((await post(`${base}/api/prepare`, null)).status, 200);
  });
});

test('URLs, keys and headers sent by the browser are never used', async () => {
  await withStub(routes, async (stub) => {
    const { config, runtime } = setup(stub);
    await withApp(config, runtime, async (base) => {
      const res = await post(`${base}/api/decide`, {
        deskId: 1,
        profile: 'ALPHA',
        url: 'http://127.0.0.1:9/evil',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'attacker-key',
        headers: { authorization: 'Bearer attacker-key' },
        upstream: { chatUrl: 'http://127.0.0.1:9/evil', headers: { authorization: 'Bearer attacker-key' } },
        paper: { id: 1, dossier: SAMPLE_PAPERS.reject },
      });
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].path, '/openai/v1/chat/completions');
      assert.equal(stub.calls[0].headers.authorization, `Bearer ${FOUNDRY_KEY}`);
      assert.ok(!JSON.stringify(stub.calls[0].body).includes('attacker'));
    });
  });
});

// ---- U3: a race permit is bound to the profiles requested at Start, not to the whole catalog ----------------

test('a race permit bound to its requested line-up rejects a decide for a different, otherwise-valid catalog model', async () => {
  await withStub(routes, async (stub) => {
    const { config, runtime } = setup(stub, {
      USAGE_CONTROL_ENABLED: 'true',
      USAGE_DAILY_GLOBAL_RACES: '1000',
      USAGE_SIGNING_SECRET: 'lineup-binding-secret',
      USAGE_TABLE_ENDPOINT: 'https://example.table.core.windows.net',
    });
    const usage = createUsageService(config.usage, { store: createFakeStore() });

    await withApp(config, runtime, usage, async (base) => {
      // Start binds the permit to ALPHA and BETA only -- SPARE is a real catalog model, but not part of this race.
      const start = await post(`${base}/api/races/start`, { runId: 'lineup-run-1', queueSize: 10, profiles: ['ALPHA', 'BETA'] });
      assert.equal(start.status, 200);
      const { permit } = await start.json();
      const auth = { 'x-race-permit': permit, cookie: (start.headers.get('set-cookie') ?? '').split(';')[0] };

      const outOfScope = await post(
        `${base}/api/decide`,
        { deskId: 1, profile: 'SPARE', paper: { id: 1, dossier: SAMPLE_PAPERS.reject }, operationId: 'd-spare' },
        auth,
      );
      assert.equal(outOfScope.status, 403);
      assert.equal((await outOfScope.json()).code, 'race_permit_invalid');
      assert.equal(stub.calls.length, 0, 'the out-of-scope model is refused before any upstream call');

      const inScope = await post(
        `${base}/api/decide`,
        { deskId: 1, profile: 'ALPHA', paper: { id: 1, dossier: SAMPLE_PAPERS.reject }, operationId: 'd-alpha' },
        auth,
      );
      assert.equal(inScope.status, 200);
      assert.equal((await inScope.json()).ok, true);
      assert.equal(stub.calls.length, 1, 'a model the race was actually bound to is still allowed');
    });
  });
});
