import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { UpstreamError, withAuthFallback } from '../server/http.js';
import { createRuntime } from '../server/runtime.js';
import { RULE_IDS, SAMPLE_PAPERS, dossierToText } from '../shared/rulebook.js';
import { chatReply, responsesReply, startStub, systemOneReply } from './helpers.js';

const rejectPaper = (id = 1) => ({ id, dossier: SAMPLE_PAPERS.reject });
const approvePaper = (id = 2) => ({ id, dossier: SAMPLE_PAPERS.approve });

function setup(stub, env = {}) {
  const config = loadConfig({
    KODEKEY_BASE_URL: `${stub.url}/v1`,
    KODEKEY_API_KEY: 'kk-test',
    FOUNDRY_ENDPOINT: stub.url,
    FOUNDRY_API_KEY: 'fk-test',
    MAX_RETRIES: '1',
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

// ---- Responses API -------------------------------------------------------------------------------

test('Responses desk: speaks the Responses API with instructions, input, token cap and no storage', async () => {
  await withStub(() => responsesReply('REJECT', { reasoning: true }), async (stub) => {
    const { runtime } = setup(stub, { DESK2_PROVIDER: 'foundry', DESK2_URL: `${stub.url}/openai/v1/responses`, DESK2_MODEL: 'gpt-4.1-mini', DESK2_REASONING_EFFORT: 'low' });
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'reject');
    assert.deepEqual(result.usage, { inputTokens: 150, outputTokens: 3 });
    assert.equal(result.detail.api, 'responses');
    assert.equal(result.model, 'gpt-4.1-mini-2025-04-14');

    const [call] = stub.calls;
    assert.equal(call.path, '/openai/v1/responses');
    assert.equal(call.headers.authorization, 'Bearer fk-test');
    assert.equal(call.body.model, 'gpt-4.1-mini');
    assert.match(call.body.instructions, /APPROVE or REJECT/);
    assert.equal(call.body.input, dossierToText(SAMPLE_PAPERS.reject));
    assert.equal(call.body.max_output_tokens, 4096);
    assert.equal(call.body.store, false);
    assert.deepEqual(call.body.reasoning, { effort: 'low' });
    assert.ok(!('messages' in call.body) && !('temperature' in call.body) && !('reasoning_effort' in call.body));
  });
});

test('Responses desk: output_text and message content parts are both understood', async () => {
  const handlers = [
    () => ({ json: { status: 'completed', output_text: 'APPROVE', usage: { input_tokens: 10, output_tokens: 1 } } }),
    () => responsesReply('Reject.'),
  ];
  for (const [index, handler] of handlers.entries()) {
    await withStub(handler, async (stub) => {
      const { runtime } = setup(stub, { DESK2_PROVIDER: 'foundry', DESK2_URL: `${stub.url}/openai/v1/responses`, DESK2_MODEL: 'm' });
      const result = await runtime.decide({ deskId: 2, paper: approvePaper() });
      assert.equal(result.ok, true);
      assert.equal(result.decision, index === 0 ? 'approve' : 'reject');
    });
  }
});

test('Responses desk: an incomplete reply explains how to fix it', async () => {
  const reply = responsesReply(null, { status: 'incomplete', reasoning: true, extra: { incomplete_details: { reason: 'max_output_tokens' } } });
  await withStub(() => reply, async (stub) => {
    const { runtime } = setup(stub, { DESK2_PROVIDER: 'foundry', DESK2_URL: `${stub.url}/openai/v1/responses`, DESK2_MODEL: 'grok-4.7' });
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_output');
    assert.match(result.error, /status=incomplete, max_output_tokens/);
    assert.match(result.error, /DESK2_MAX_TOKENS/);
    assert.match(result.error, /DESK2_REASONING_EFFORT/);
  });
});

test('Responses desk: a failed response is reported with its reason and not retried', async () => {
  await withStub(() => ({ json: { status: 'failed', error: { message: 'blocked by content filter' } } }), async (stub) => {
    const { runtime } = setup(stub, { DESK2_PROVIDER: 'foundry', DESK2_URL: `${stub.url}/openai/v1/responses`, DESK2_MODEL: 'm' });
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.match(result.error, /response failed: blocked by content filter/);
    assert.equal(stub.calls.length, 1);
  });
});

test('Responses desk: drops temperature and reasoning when the model rejects them', async () => {
  const handler = (call, n) => {
    if (n === 1) return { status: 400, json: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } } };
    if (n === 2) return { status: 400, json: { error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." } } };
    return responsesReply('REJECT');
  };
  await withStub(handler, async (stub) => {
    const { runtime } = setup(stub, {
      DESK2_PROVIDER: 'foundry',
      DESK2_URL: `${stub.url}/openai/v1/responses`,
      DESK2_MODEL: 'gpt-4.1',
      DESK2_TEMPERATURE: '0',
      DESK2_REASONING_EFFORT: 'low',
    });
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(stub.calls.length, 3);
    assert.ok('temperature' in stub.calls[0].body && 'reasoning' in stub.calls[0].body);
    assert.ok(!('temperature' in stub.calls[1].body) && 'reasoning' in stub.calls[1].body);
    assert.ok(!('temperature' in stub.calls[2].body) && !('reasoning' in stub.calls[2].body));
  });
});

test('Chat desk: a Responses-only deployment gets a pointer to the fix', async () => {
  const message = 'The chatCompletion operation does not work with the specified model, gpt-5-codex. Please choose different model and try again.';
  await withStub(() => ({ status: 400, json: { error: { message } } }), async (stub) => {
    const { runtime } = setup(stub, { DESK2_MODEL: 'gpt-5-codex' });
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not work with the specified model/);
    assert.match(result.error, /DESK2_API=responses/);
    assert.match(result.error, /DESK2_URL/);
  });
});

// ---- API auto-detection ---------------------------------------------------------------------------

test('api auto: falls back from chat to Responses before the clock starts and remembers it', async () => {
  const handler = (call, n) => {
    if (call.path.endsWith('/chat/completions')) {
      return { status: 400, json: { error: { message: 'The chatCompletion operation does not work with the specified model.' } }, delayMs: n === 1 ? 300 : 0 };
    }
    return responsesReply('REJECT');
  };
  await withStub(handler, async (stub) => {
    const { runtime } = setup(stub, { DESK2_MODEL: 'gpt-5-codex', DESK2_API: 'auto' });
    assert.equal(runtime.publicConfig().desks[1].api, 'auto');
    const first = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(first.ok, true);
    assert.ok(first.latencyMs < 200, `detection leaked into the measured latency: ${first.latencyMs}`);
    assert.equal(runtime.llmApis.get('DESK2'), 'responses');
    assert.equal(runtime.publicConfig().desks[1].api, 'responses');
    assert.deepEqual(stub.calls.map((c) => c.path), ['/openai/v1/chat/completions', '/openai/v1/responses', '/openai/v1/responses']);

    await runtime.decide({ deskId: 2, paper: approvePaper() });
    assert.equal(stub.calls.length, 4, 'no second detection');
  });
});

test('api auto: keeps chat when it works, and concurrent first calls share one detection', async () => {
  await withStub(() => chatReply('APPROVE'), async (stub) => {
    const { runtime } = setup(stub, { DESK2_MODEL: 'm', DESK2_API: 'auto' });
    const results = await Promise.all([1, 2, 3].map((id) => runtime.decide({ deskId: 2, paper: approvePaper(id) })));
    assert.ok(results.every((r) => r.ok));
    assert.equal(runtime.llmApis.get('DESK2'), 'chat');
    assert.equal(stub.calls.length, 1 + 3);
  });
});

test('api auto: a bad key stops detection immediately instead of trying the other API', async () => {
  await withStub(() => ({ status: 401, json: { error: { message: 'Access denied due to invalid subscription key.' } } }), async (stub) => {
    const { runtime } = setup(stub, { DESK2_MODEL: 'm', DESK2_API: 'auto' });
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(stub.calls.length, 1);
  });
});

test('api auto: when neither API works the error lists both attempts', async () => {
  await withStub(() => ({ status: 404, json: { error: { code: 'DeploymentNotFound', message: 'The API deployment for this resource does not exist.' } } }), async (stub) => {
    const { runtime } = setup(stub, { DESK2_MODEL: 'typo-name', DESK2_API: 'auto' });
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported');
    assert.equal(result.status, 404);
    assert.match(result.error, /chat ->/);
    assert.match(result.error, /responses ->/);
    assert.match(result.error, /typo-name/);
  });
});

// ---- Foundry-hosted System One (Microsoft-Decision-1) ---------------------------------------------

test('Foundry System One: native provider route, deployment name as model, typed answers, no detection calls', async () => {
  await withStub((call) => (call.path === '/providers/microsoft/v1/systemone' ? systemOneReply({ contraband: 0.95 }, { input_tokens: 280, output_tokens: 0 }) : undefined), async (stub) => {
    const { runtime } = setup(stub, { DESK1_PROVIDER: 'foundry', DESK1_URL: `${stub.url}/providers/microsoft/v1/systemone`, DESK1_MODEL: 'decision-prod' });
    const result = await runtime.decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'reject');
    assert.deepEqual(result.detail.violated, ['contraband']);
    assert.equal(result.detail.mode, 'systemone');
    assert.deepEqual(result.usage, { inputTokens: 280, outputTokens: 0 });
    assert.equal(stub.calls.length, 1);

    const [call] = stub.calls;
    assert.equal(call.headers.authorization, 'Bearer fk-test');
    assert.equal(call.body.model, 'decision-prod');
    assert.deepEqual(call.body.state, SAMPLE_PAPERS.reject);
    assert.deepEqual(Object.keys(call.body.questions), RULE_IDS);
    assert.equal(runtime.publicConfig().desks[0].mode, 'systemone');
  });
});

test('Foundry System One: a model named Microsoft-Decision-1 finds its route from the resource endpoint', async () => {
  await withStub((call) => (call.path === '/providers/microsoft/v1/systemone' ? systemOneReply({}) : undefined), async (stub) => {
    const { runtime } = setup(stub, { DESK2_MODEL: 'Microsoft-Decision-1' });
    const result = await runtime.decide({ deskId: 2, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'approve');
    assert.equal(stub.calls[0].path, '/providers/microsoft/v1/systemone');
    assert.equal(result.detail.kind, 'systemone');
  });
});

// ---- Auth style fallback ----------------------------------------------------------------------------

const fakeDesk = () => ({ upstream: { headers: { 'api-key': 'K' }, altHeaders: { authorization: 'Bearer K' } } });
const unauthorized = () => new UpstreamError('HTTP 401: nope', { status: 401, code: 'http' });

test('withAuthFallback: the primary style is used when it works', async () => {
  const desk = fakeDesk();
  const seen = [];
  const result = await withAuthFallback(desk, async (headers) => {
    seen.push(headers);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(seen, [{ 'api-key': 'K' }]);
});

test('withAuthFallback: a 401 retries once with the other style and remembers what worked', async () => {
  const desk = fakeDesk();
  const seen = [];
  const send = async (headers) => {
    seen.push(Object.keys(headers)[0]);
    if (!headers.authorization) throw unauthorized();
    return 'ok';
  };
  assert.equal(await withAuthFallback(desk, send), 'ok');
  assert.equal(await withAuthFallback(desk, send), 'ok');
  assert.deepEqual(seen, ['api-key', 'authorization', 'authorization']);
});

test('withAuthFallback: two 401s report the original error and keep the order', async () => {
  const desk = fakeDesk();
  await assert.rejects(() => withAuthFallback(desk, async () => { throw unauthorized(); }), /HTTP 401: nope/);
  assert.deepEqual(desk.upstream.headers, { 'api-key': 'K' });
});

test('withAuthFallback: if the second style authenticates but the call fails otherwise, that error is reported', async () => {
  const desk = fakeDesk();
  const send = async (headers) => {
    if (headers['api-key']) throw unauthorized();
    throw new UpstreamError('HTTP 400: bad body', { status: 400, code: 'http' });
  };
  await assert.rejects(() => withAuthFallback(desk, send), /HTTP 400: bad body/);
  assert.deepEqual(desk.upstream.headers, { authorization: 'Bearer K' }, 'the style that authenticated is promoted');
});

test('withAuthFallback: other failures and desks without an alternative are never retried', async () => {
  const desk = fakeDesk();
  let calls = 0;
  await assert.rejects(() => withAuthFallback(desk, async () => { calls++; throw new UpstreamError('HTTP 500', { status: 500, code: 'http' }); }), /HTTP 500/);
  assert.equal(calls, 1);
  const bearerOnly = { upstream: { headers: { authorization: 'Bearer K' }, altHeaders: null } };
  await assert.rejects(() => withAuthFallback(bearerOnly, async () => { calls++; throw unauthorized(); }), /HTTP 401/);
  assert.equal(calls, 2);
});

test('withAuthFallback: concurrent callers that both fail on the old style promote the new one exactly once', async () => {
  const desk = fakeDesk();
  const send = async (headers) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (!headers.authorization) throw unauthorized();
    return 'ok';
  };
  const results = await Promise.all([withAuthFallback(desk, send), withAuthFallback(desk, send), withAuthFallback(desk, send)]);
  assert.deepEqual(results, ['ok', 'ok', 'ok']);
  assert.deepEqual(desk.upstream.headers, { authorization: 'Bearer K' }, 'style must not flip back');
  assert.deepEqual(desk.upstream.altHeaders, { 'api-key': 'K' });
});

test('an Azure-style desk heals a header mismatch over real HTTP and keeps the working style', async () => {
  const handler = (call) => (call.headers.authorization === 'Bearer fk-test' ? chatReply('REJECT') : { status: 401, json: { error: { message: 'Access denied' } } });
  await withStub(handler, async (stub) => {
    const { config, runtime } = setup(stub, { DESK2_MODEL: 'grok-4.7' });
    const desk = config.desks[1];
    desk.upstream.headers = { 'api-key': 'fk-test' };
    desk.upstream.altHeaders = { authorization: 'Bearer fk-test' };

    const first = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(first.ok, true);
    assert.deepEqual(stub.calls.map((c) => Boolean(c.headers['api-key'])), [true, false]);
    const second = await runtime.decide({ deskId: 2, paper: approvePaper() });
    assert.equal(second.ok, true);
    assert.equal(stub.calls.length, 3, 'the second decision goes straight to the style that worked');
  });
});

// ---- Pre-race key validation (Azure-style hosts) ----------------------------------------------------

const asAzureStyle = (desk, key = 'fk-test') => {
  desk.upstream.headers = { 'api-key': key };
  desk.upstream.altHeaders = { authorization: `Bearer ${key}` };
};

test('prepare settles the auth style with a free GET so the first timed call never retries headers', async () => {
  const handler = (call) => {
    if (call.method === 'GET' && call.path === '/openai/v1/models') return call.headers.authorization === 'Bearer fk-test' ? { json: { data: [] } } : { status: 401, json: { error: { message: 'Access denied' } } };
    return call.headers.authorization === 'Bearer fk-test' ? chatReply('REJECT') : { status: 401, json: { error: { message: 'Access denied' } } };
  };
  await withStub(handler, async (stub) => {
    const { config, runtime } = setup(stub, { DESK2_MODEL: 'grok-4.7' });
    asAzureStyle(config.desks[1]);

    const [, report] = await runtime.prepare();
    assert.equal(report.ok, true);
    assert.deepEqual(config.desks[1].upstream.headers, { authorization: 'Bearer fk-test' });

    const before = stub.calls.length;
    const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(stub.calls.length, before + 1, 'exactly one request for the decision: no header retry');
    assert.equal(result.attempts, 1);
  });
});

test('prepare reports a wrong key before the race instead of mid-shift', async () => {
  await withStub(() => ({ status: 401, json: { error: { message: 'Access denied due to invalid subscription key fk-test-LEAK' } } }), async (stub) => {
    const { config, runtime } = setup(stub, { DESK2_MODEL: 'grok-4.7', FOUNDRY_API_KEY: 'fk-test-LEAK' });
    asAzureStyle(config.desks[1], 'fk-test-LEAK');
    const [, report] = await runtime.prepare();
    assert.equal(report.ok, false);
    assert.equal(report.status, 401);
    assert.match(report.error, /invalid subscription key/);
    assert.ok(!report.error.includes('LEAK'), 'the key must be redacted');
  });
});

test('prepare tolerates hosts that do not serve the models route', async () => {
  await withStub((call) => (call.method === 'GET' ? { status: 404, json: { error: { message: 'Resource not found' } } } : chatReply('APPROVE')), async (stub) => {
    const { config, runtime } = setup(stub, { DESK2_MODEL: 'grok-4.7' });
    asAzureStyle(config.desks[1]);
    const [, report] = await runtime.prepare();
    assert.equal(report.ok, true);
  });
});
