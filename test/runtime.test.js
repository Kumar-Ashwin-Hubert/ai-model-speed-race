import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
import { createRuntime } from '../server/runtime.js';
import { RULE_IDS, SAMPLE_PAPERS, dossierToText } from '../shared/rulebook.js';
import { chatReply, questionsReply, startStub, systemOneReply } from './helpers.js';

const rejectPaper = (id = 1) => ({ id, dossier: SAMPLE_PAPERS.reject });
const approvePaper = (id = 2) => ({ id, dossier: SAMPLE_PAPERS.approve });

function runtimeFor(stub, env = {}, options) {
  const config = loadConfig({
    KODEKEY_BASE_URL: `${stub.url}/v1`,
    KODEKEY_API_KEY: 'kk-test',
    FOUNDRY_ENDPOINT: stub.url,
    FOUNDRY_API_KEY: 'fk-test',
    DESK2_MODEL: 'fast-llm',
    DESK3_MODEL: 'big-llm',
    MAX_RETRIES: '2',
    REQUEST_TIMEOUT_MS: '5000',
    ...env,
  });
  return createRuntime(config, options);
}

async function withStub(handler, fn) {
  const stub = await startStub(handler);
  try {
    await fn(stub);
  } finally {
    await stub.close();
  }
}

test('LLM desk: calls the Foundry v1 chat route with the rulebook prompt and parses the reply', async () => {
  await withStub(() => chatReply('REJECT'), async (stub) => {
    const result = await runtimeFor(stub).decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'reject');
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 2, cachedTokens: 0 });
    assert.equal(result.attempts, 1);
    assert.equal(result.detail.kind, 'llm');

    const [call] = stub.calls;
    assert.equal(call.path, '/openai/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer fk-test');
    assert.equal(call.body.model, 'fast-llm');
    assert.equal(call.body.max_completion_tokens, 4096);
    assert.ok(!('temperature' in call.body) && !('reasoning_effort' in call.body));
    assert.equal(call.body.messages[0].role, 'system');
    assert.match(call.body.messages[0].content, /APPROVE or REJECT/);
    assert.match(call.body.messages[1].content, /Declared goods: A crate of rifles/);
    assert.ok(!JSON.stringify(call.body).includes('truth'));
  });
});

test('LLM desk: optional tuning knobs are forwarded only when configured', async () => {
  await withStub(() => chatReply('APPROVE'), async (stub) => {
    const runtime = runtimeFor(stub, { DESK3_TEMPERATURE: '0', DESK3_REASONING_EFFORT: 'minimal', DESK3_MAX_TOKENS: '512' });
    await runtime.decide({ deskId: 3, paper: approvePaper() });
    const { body } = stub.calls[0];
    assert.equal(body.temperature, 0);
    assert.equal(body.reasoning_effort, 'minimal');
    assert.equal(body.max_completion_tokens, 512);
  });
});

test('LLM desk: an empty reply from a reasoning model is reported with the fix', async () => {
  await withStub(() => chatReply('', { finish: 'length' }), async (stub) => {
    const result = await runtimeFor(stub).decide({ deskId: 3, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_output');
    assert.match(result.error, /DESK3_MAX_TOKENS/);
  });
});

test('LLM desk: adapts when a model rejects max_completion_tokens, then temperature', async () => {
  const handler = (call, n) => {
    if (n === 1) return { status: 400, json: { error: { message: "Unsupported parameter: 'max_completion_tokens' is not supported with this model." } } };
    if (n === 2) return { status: 400, json: { error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } } };
    return chatReply('REJECT');
  };
  await withStub(handler, async (stub) => {
    const result = await runtimeFor(stub, { DESK2_TEMPERATURE: '0' }).decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(stub.calls.length, 3);
    assert.ok('max_completion_tokens' in stub.calls[0].body);
    assert.ok('max_tokens' in stub.calls[1].body && !('max_completion_tokens' in stub.calls[1].body));
    assert.ok(!('temperature' in stub.calls[2].body));
  });
});

test('transient failure is retried with backoff and counted in latency and attempts', async () => {
  await withStub((call, n) => (n === 1 ? { status: 503, json: { error: { message: 'overloaded' } } } : chatReply('APPROVE')), async (stub) => {
    const result = await runtimeFor(stub).decide({ deskId: 2, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.ok(result.latencyMs >= 240, `latency ${result.latencyMs} should include the backoff`);
  });
});

test('429 honours retry-after', async () => {
  await withStub((call, n) => (n === 1 ? { status: 429, headers: { 'retry-after': '0' }, json: { error: { message: 'slow down' } } } : chatReply('REJECT')), async (stub) => {
    const result = await runtimeFor(stub).decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.ok(result.latencyMs < 200);
  });
});

test('auth errors are not retried and surface the status', async () => {
  await withStub(() => ({ status: 401, json: { error: { message: 'Access denied due to invalid subscription key' } } }), async (stub) => {
    const result = await runtimeFor(stub).decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.attempts, 1);
    assert.match(result.error, /invalid subscription key/);
    assert.equal(stub.calls.length, 1);
  });
});

test('retries are bounded by MAX_RETRIES', async () => {
  await withStub(() => ({ status: 503, json: { error: { message: 'down' } } }), async (stub) => {
    const result = await runtimeFor(stub, { MAX_RETRIES: '1' }).decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.equal(stub.calls.length, 2);
  });
});

test('a hung upstream times out', async () => {
  await withStub(() => ({ ...chatReply('REJECT'), delayMs: 1600 }), async (stub) => {
    const result = await runtimeFor(stub, { REQUEST_TIMEOUT_MS: '1000', MAX_RETRIES: '0' }).decide({ deskId: 2, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'timeout');
  });
});

test('cancelling the request stops it without retries', async () => {
  await withStub(() => ({ ...chatReply('REJECT'), delayMs: 1000 }), async (stub) => {
    const controller = new AbortController();
    const pending = runtimeFor(stub).decide({ deskId: 2, paper: rejectPaper() }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'cancelled');
    assert.equal(stub.calls.length, 1);
  });
});

test('network errors are reported as retryable network failures', async () => {
  const stub = await startStub(() => chatReply('APPROVE'));
  const runtime = runtimeFor(stub, { MAX_RETRIES: '0' });
  await stub.close();
  const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'network');
});

test('an unconfigured desk fails fast and names the missing variables', async () => {
  const runtime = createRuntime(loadConfig({}), {
    fetchImpl: () => {
      throw new Error('network must not be used for unconfigured desks');
    },
  });
  const result = await runtime.decide({ deskId: 2, paper: rejectPaper() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_configured');
  assert.match(result.error, /FOUNDRY_API_KEY/);
});

test('unknown desk is rejected', async () => {
  const result = await createRuntime(loadConfig({}, { mock: true })).decide({ deskId: 9, paper: rejectPaper() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown_desk');
});

// ---- JEV (KodeKey) --------------------------------------------------------------------------------

test('JEV via KodeKey: the questions go in response_format and the answers come back as JSON, no detection needed', async () => {
  await withStub((call) => (call.path === '/v1/chat/completions' ? questionsReply({ contraband: 0.95 }) : undefined), async (stub) => {
    const runtime = runtimeFor(stub);
    const result = await runtime.decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'reject');
    assert.deepEqual(result.detail.violated, ['contraband']);
    assert.equal(result.detail.mode, 'questions');
    assert.deepEqual(result.usage, { inputTokens: 459, outputTokens: 108, cachedTokens: 0 });
    assert.equal(result.model, 'typesafe/jev-1.13.0');
    assert.equal(stub.calls.length, 1, 'the mode is known up front, so there is no probe call');

    const [call] = stub.calls;
    assert.equal(call.path, '/v1/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer kk-test');
    assert.equal(call.body.model, 'typesafe/jev-1.13.0');
    assert.deepEqual(call.body.messages, [{ role: 'user', content: dossierToText(SAMPLE_PAPERS.reject) }]);
    assert.equal(call.body.response_format.type, 'questions');
    assert.deepEqual(Object.keys(call.body.response_format.questions), RULE_IDS);
    assert.ok(Object.values(call.body.response_format.questions).every((q) => q.type === 'noul' && q.instructions.length > 10));
    assert.ok(!('max_tokens' in call.body) && !('max_completion_tokens' in call.body) && !('temperature' in call.body));
    assert.equal(runtime.publicConfig().desks[0].mode, 'questions');
  });
});

test('JEV via KodeKey: quiet answers approve, with the weakest rule setting the confidence', async () => {
  await withStub(() => questionsReply({ expired: 0.4 }), async (stub) => {
    const result = await runtimeFor(stub).decide({ deskId: 1, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'approve');
    assert.ok(Math.abs(result.detail.confidence - 0.2) < 1e-9);
    assert.equal(Object.keys(result.detail.probabilities).length, RULE_IDS.length);
  });
});

test('JEV auto: finds the questions mode once, caches it and keeps the probe out of the measured latency', async () => {
  await withStub((call, n) => ({ ...questionsReply({}), delayMs: n === 1 ? 300 : 0 }), async (stub) => {
    const runtime = runtimeFor(stub, { DESK1_MODE: 'auto' });
    const first = await runtime.decide({ deskId: 1, paper: approvePaper() });
    assert.equal(first.ok, true);
    assert.ok(first.latencyMs < 200, `probe time leaked into latency: ${first.latencyMs}`);
    assert.equal(runtime.jevModes.get('DESK1'), 'questions');
    assert.equal(stub.calls.length, 2);

    await runtime.decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(stub.calls.length, 3, 'mode must be cached, no second probe');
  });
});

test('JEV auto: concurrent first calls share a single probe', async () => {
  await withStub((call, n) => ({ ...questionsReply({}), delayMs: n === 1 ? 150 : 0 }), async (stub) => {
    const runtime = runtimeFor(stub, { DESK1_MODE: 'auto' });
    const results = await Promise.all([1, 2, 3].map((id) => runtime.decide({ deskId: 1, paper: approvePaper(id) })));
    assert.ok(results.every((r) => r.ok));
    assert.equal(stub.calls.length, 1 + 3);
  });
});

test('JEV auto: falls back to the native System One route when the gateway has no questions support', async () => {
  const handler = (call) =>
    call.path === '/v1/systemone'
      ? systemOneReply({ contraband: 0.95 })
      : { status: 400, json: { error: { message: 'response_format of type "questions" is not supported' } } };
  await withStub(handler, async (stub) => {
    const runtime = runtimeFor(stub, { DESK1_MODE: 'auto' });
    const result = await runtime.decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.equal(runtime.jevModes.get('DESK1'), 'systemone');
    assert.equal(result.decision, 'reject');
    assert.deepEqual(result.usage, { inputTokens: 310, outputTokens: 0, cachedTokens: 0 });
    assert.equal(result.model, 'jev-1.13.0');
    const native = stub.calls.at(-1);
    assert.equal(native.headers.authorization, 'Bearer kk-test');
    assert.equal(native.body.model, 'typesafe/jev-1.13.0');
    assert.deepEqual(native.body.state, SAMPLE_PAPERS.reject);
    assert.deepEqual(Object.keys(native.body.questions), RULE_IDS);
  });
});

test('JEV explicit systemone mode skips detection entirely', async () => {
  await withStub((call) => (call.path === '/v1/systemone' ? systemOneReply({}) : undefined), async (stub) => {
    const runtime = runtimeFor(stub, { DESK1_MODE: 'systemone' });
    const result = await runtime.decide({ deskId: 1, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'approve');
    assert.equal(stub.calls.length, 1);
    assert.ok(result.detail.confidence > 0.9);
  });
});

test('JEV KODEKEY_JEV_PATH changes the native route', async () => {
  await withStub((call) => (call.path === '/v1/typesafe/systemone' ? systemOneReply({ watchlist: 0.9 }) : undefined), async (stub) => {
    const runtime = runtimeFor(stub, { DESK1_MODE: 'systemone', KODEKEY_JEV_PATH: 'typesafe/systemone' });
    const result = await runtime.decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.detail.violated, ['watchlist']);
  });
});

test('JEV auto: when nothing works the error lists every attempt', async () => {
  await withStub(() => undefined, async (stub) => {
    const result = await runtimeFor(stub, { DESK1_MODE: 'auto' }).decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported');
    assert.equal(result.status, 404);
    for (const mode of ['questions', 'systemone']) assert.match(result.error, new RegExp(mode));
  });
});

test('JEV auto: a bad key stops detection immediately', async () => {
  await withStub(() => ({ status: 401, json: { error: { message: 'Authentication Error, Invalid proxy server token passed' } } }), async (stub) => {
    const result = await runtimeFor(stub, { DESK1_MODE: 'auto' }).decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(stub.calls.length, 1);
  });
});

test('JEV: a key that is not allowed to use the model is reported as is', async () => {
  const message = "user not allowed to access model. This user can only access models=['kodekey-free']. Tried to access jev-latest";
  await withStub(() => ({ status: 403, json: { error: { message } } }), async (stub) => {
    const result = await runtimeFor(stub).decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error, /kodekey-free/);
    assert.equal(stub.calls.length, 1, 'permission errors are not retried');
  });
});

test('JEV: a chat reply without System One answers is an invalid output, not a guess', async () => {
  await withStub(() => chatReply('Sure! I would approve this application.'), async (stub) => {
    const result = await runtimeFor(stub, { MAX_RETRIES: '0' }).decide({ deskId: 1, paper: approvePaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_output');
    assert.match(result.error, /no System One answers/);
  });
});

test('keys echoed back by an upstream error message are redacted before they reach the browser', async () => {
  const handler = () => ({ status: 401, json: { error: { message: 'Invalid key kk-test-SECRET-123 and also fk-test-SECRET-456' } } });
  await withStub(handler, async (stub) => {
    const runtime = runtimeFor(stub, { KODEKEY_API_KEY: 'kk-test-SECRET-123', FOUNDRY_API_KEY: 'fk-test-SECRET-456' });
    for (const deskId of [1, 2]) {
      const result = await runtime.decide({ deskId, paper: rejectPaper() });
      assert.equal(result.ok, false);
      assert.ok(!/SECRET/.test(result.error), result.error);
      assert.match(result.error, /\*\*\*/);
    }
    const prepared = await runtime.prepare();
    assert.ok(prepared.every((d) => !/SECRET/.test(d.error ?? '')));
  });
});

test('JEV: incomplete System One answers are an invalid output, not a guess', async () => {
  await withStub(() => ({ json: { answers: { forged: { type: 'noul', noul: 0.1 } } } }), async (stub) => {
    const result = await runtimeFor(stub, { DESK1_MODE: 'systemone', MAX_RETRIES: '0' }).decide({ deskId: 1, paper: rejectPaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_output');
    assert.match(result.error, /missing/);
  });
});
// ---- prepare / test / mock ---------------------------------------------------------------------

test('prepare reports how each desk is called and opens connections to every provider without probing', async () => {
  await withStub((call) => (call.path === '/v1/chat/completions' ? chatReply('APPROVE') : undefined), async (stub) => {
    const runtime = runtimeFor(stub);
    const report = await runtime.prepare();
    assert.deepEqual(report.map((d) => [d.deskId, d.ok]), [[1, true], [2, true], [3, true]]);
    assert.equal(report[0].mode, 'questions');
    assert.equal(report[1].api, 'chat');
    assert.equal(stub.calls.filter((c) => c.method === 'POST').length, 0, 'known modes need no probe call');
    const primes = stub.calls.filter((c) => c.method === 'GET' && c.path === '/');
    assert.equal(primes.length, 3);
    assert.ok(primes.every((c) => !c.headers.authorization), 'priming must never send credentials');
  });
});

test('prepare reports unconfigured desks without throwing or touching the network', async () => {
  const runtime = createRuntime(loadConfig({}), {
    fetchImpl: () => {
      throw new Error('network must not be used for unconfigured desks');
    },
  });
  const report = await runtime.prepare();
  assert.deepEqual(report.map((d) => d.ok), [false, false, false]);
  assert.match(report[0].error, /KODEKEY_API_KEY/);
  assert.match(report[1].error, /FOUNDRY_API_KEY/);
});

test('test() runs a clean and a bad sample through every desk', async () => {
  const handler = (call) => {
    const user = call.body.messages.at(-1).content;
    const reject = user.includes('rifles');
    if (call.body.response_format) return questionsReply(reject ? { contraband: 0.95 } : {});
    return chatReply(reject ? 'REJECT' : 'APPROVE');
  };
  await withStub(handler, async (stub) => {
    const report = await runtimeFor(stub).test();
    assert.equal(report.length, 3);
    for (const desk of report) {
      assert.equal(desk.ok, true);
      assert.deepEqual(desk.checks.map((c) => [c.expected, c.got, c.correct]), [['approve', 'approve', true], ['reject', 'reject', true]]);
    }
  });
});

test('mock mode never touches the network, honours the hint and follows each model\'s calibrated delay', async () => {
  const runtime = createRuntime(loadConfig({}, { mock: true }), {
    fetchImpl: () => {
      throw new Error('network must not be used in mock mode');
    },
  });
  const hinted = (id, truth) => ({ id, dossier: SAMPLE_PAPERS.approve, hint: { truth, violations: truth === 'reject' ? ['watchlist'] : [] } });
  // default line-up: JEV, Decision 1, Fast LLM. Delays are clamped to each simulated model's measured range.
  const [jev, decision1, fast] = await Promise.all([
    runtime.decide({ deskId: 1, paper: hinted(1, 'reject') }),
    runtime.decide({ deskId: 2, paper: hinted(1, 'reject') }),
    runtime.decide({ deskId: 3, paper: hinted(1, 'approve') }),
  ]);
  assert.equal(jev.ok, true);
  assert.ok(jev.latencyMs >= 370 && jev.latencyMs < 1500, `JEV latency ${jev.latencyMs}`);
  assert.equal(jev.detail.kind, 'systemone');
  assert.ok(decision1.latencyMs >= 280 && decision1.latencyMs < 1800, `Decision 1 latency ${decision1.latencyMs}`);
  assert.equal(decision1.detail.kind, 'systemone');
  assert.ok(fast.latencyMs >= 740 && fast.latencyMs < 2100, `Fast LLM latency ${fast.latencyMs}`);
  assert.equal(fast.detail.kind, 'llm');
  assert.deepEqual((await runtime.prepare()).map((d) => d.ok), [true, true, true]);
});
