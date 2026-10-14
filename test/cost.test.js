import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../server/config.js';
import { createRuntime } from '../server/runtime.js';
import { LIST_PRICES, costOfUsage, listPriceFor } from '../shared/pricing.js';
import { SAMPLE_PAPERS } from '../shared/rulebook.js';
import { chatReply, questionsReply, responsesReply, startStub, systemOneReply } from './helpers.js';

const approvePaper = (id = 1) => ({ id, dossier: SAMPLE_PAPERS.approve });
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ''} ${actual} vs ${expected}`);

// ---- Usage blocks and headers captured from the real services on 14 October 2026 --------------------

/** KodeKey (LiteLLM) on a JEV call: the gateway prices the call itself, in the body and in a header. */
const KODEKEY_USAGE = { completion_tokens: 108, prompt_tokens: 459, total_tokens: 567, cost: 0.000019278 };
const KODEKEY_HEADERS = { 'x-litellm-response-cost': '1.9278000000000004e-05', 'x-litellm-key-spend': '0.0102' };
const DECISION1_USAGE = { input_tokens: 219, output_tokens: 6 };
const GPT41_MINI_USAGE = { input_tokens: 215, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 219 };
/** Grok 4.7 on its fourth identical call: most of the prompt is served from the cache, reasoning is reported apart from completion. */
const GROK_USAGE = {
  prompt_tokens: 210,
  completion_tokens: 2,
  total_tokens: 489,
  prompt_tokens_details: { cached_tokens: 182, audio_tokens: 0, text_tokens: 210, image_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 277, audio_tokens: 0 },
};

function setup(stub, env = {}) {
  const config = loadConfig({
    KODEKEY_BASE_URL: `${stub.url}/v1`,
    KODEKEY_API_KEY: 'kk-test',
    FOUNDRY_ENDPOINT: stub.url,
    FOUNDRY_API_KEY: 'fk-test',
    MAX_RETRIES: '0',
    REQUEST_TIMEOUT_MS: '5000',
    ...env,
  });
  return createRuntime(config);
}

async function withStub(handler, fn) {
  const stub = await startStub(handler);
  try {
    await fn(stub);
  } finally {
    await stub.close();
  }
}

const responsesDesk = (stub, model, extra = {}) => ({ DESK2_URL: `${stub.url}/openai/v1/responses`, DESK2_MODEL: model, ...extra });

// ---- The price list and the cost formula ------------------------------------------------------------

test('the list prices are the published Azure / TypeSafe ones', () => {
  const rates = Object.fromEntries(Object.entries(LIST_PRICES).map(([id, price]) => [id, [price.in, price.cachedIn, price.out]]));
  assert.deepEqual(rates, {
    jev: [0.042, null, 0],
    'decision-1': [0.042, null, 0],
    'gpt-4.1-mini': [0.4, 0.1, 1.6],
    'gpt-4.1': [2, 0.5, 8],
    'grok-4.7': [2, 0.5, 6],
  });
});

test('listPriceFor recognises deployment names and served model ids, and refuses look-alikes', () => {
  const idOf = (name) => Object.entries(LIST_PRICES).find(([, price]) => price === listPriceFor(name))?.[0] ?? null;
  const cases = {
    'typesafe/jev-1.13.0': 'jev',
    'jev-latest': 'jev',
    'Decision-1': 'decision-1',
    'microsoft-decision-1': 'decision-1',
    'Microsoft-Decision-1': 'decision-1',
    'gpt-4.1-mini': 'gpt-4.1-mini',
    'gpt-4.1-mini-2025-04-14': 'gpt-4.1-mini',
    'gpt-4.1': 'gpt-4.1',
    'GPT-4.1-2025-04-14': 'gpt-4.1',
    'grok-4.7': 'grok-4.7',
    // not the base models, so not priced like them
    'gpt-4.1-mini-ft': null,
    'gpt-4.1-nano': null,
    'gpt-4.1-turbo': null,
    'grok-4.7-fast': null,
    'grok-4.6': null,
    'decision-10': null,
    'my-deployment': null,
    '': null,
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(idOf(name), expected, name);
  assert.equal(listPriceFor(undefined, '', 'my-deployment', 'gpt-4.1'), LIST_PRICES['gpt-4.1'], 'the first known name wins');
  assert.equal(listPriceFor(), null);
});

test('costOfUsage: input, output and the cached part of the input at the cached rate', () => {
  const grok = LIST_PRICES['grok-4.7'];
  near(costOfUsage({ inputTokens: 1_000_000, outputTokens: 0 }, grok), 2);
  near(costOfUsage({ inputTokens: 0, outputTokens: 1_000_000 }, grok), 6);
  // 28 fresh input + 182 cached input + 279 output tokens, the real Grok call above
  near(costOfUsage({ inputTokens: 210, outputTokens: 279, cachedTokens: 182 }, grok), (28 * 2 + 182 * 0.5 + 279 * 6) / 1e6);
  // no cached rate known: cached tokens cost the normal input rate
  near(costOfUsage({ inputTokens: 100, outputTokens: 0, cachedTokens: 60 }, { in: 3, cachedIn: null, out: 0 }), 300 / 1e6);
  // cached tokens can never exceed the input
  near(costOfUsage({ inputTokens: 10, outputTokens: 0, cachedTokens: 99 }, { in: 4, cachedIn: 1, out: 0 }), 10 / 1e6);
});

test('the list reproduces the cost KodeKey itself reports for a JEV call', () => {
  near(costOfUsage({ inputTokens: 459, outputTokens: 108 }, LIST_PRICES.jev), 0.000019278);
});

// ---- Cost per call, by where the number comes from --------------------------------------------------

test('JEV via KodeKey: the gateway\'s own cost is used and labelled as reported', async () => {
  await withStub(() => ({ ...questionsReply({}, KODEKEY_USAGE), headers: KODEKEY_HEADERS }), async (stub) => {
    const result = await setup(stub).decide({ deskId: 1, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { inputTokens: 459, outputTokens: 108, cachedTokens: 0 });
    assert.deepEqual(result.cost, { usd: 0.000019278, basis: 'reported' });
  });
});

test('a cost that only arrives in the LiteLLM header is found too, and beats the price table', async () => {
  const usage = { prompt_tokens: 459, completion_tokens: 108 };
  await withStub(() => ({ ...questionsReply({}, usage), headers: { 'x-litellm-response-cost': '0.5' } }), async (stub) => {
    const result = await setup(stub).decide({ deskId: 1, paper: approvePaper() });
    assert.deepEqual(result.cost, { usd: 0.5, basis: 'reported' });
  });
});

test('a provider-reported cost is kept even when the response has no usage block', async () => {
  const reply = chatReply('APPROVE');
  delete reply.json.usage;
  await withStub(() => ({ ...reply, headers: { 'x-litellm-response-cost': '0.001' } }), async (stub) => {
    const result = await setup(stub, { DESK2_MODEL: 'whatever' }).decide({ deskId: 2, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.equal(result.usage, null);
    assert.deepEqual(result.cost, { usd: 0.001, basis: 'reported' });
  });
});

test('GPT-4.1 mini on Foundry: tokens from the response times the built-in Azure price', async () => {
  await withStub(() => responsesReply('APPROVE', { usage: GPT41_MINI_USAGE, model: 'gpt-4.1-mini' }), async (stub) => {
    const result = await setup(stub, responsesDesk(stub, 'gpt-4.1-mini')).decide({ deskId: 2, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { inputTokens: 215, outputTokens: 4, cachedTokens: 0 });
    assert.equal(result.cost.basis, 'list');
    near(result.cost.usd, (215 * 0.4 + 4 * 1.6) / 1e6);
  });
});

test('Decision 1 on Foundry: input tokens at $0.042 per 1M, output free like JEV', async () => {
  const reply = { json: { ...systemOneReply({}, DECISION1_USAGE).json, model: 'microsoft-decision-1' } };
  await withStub(() => reply, async (stub) => {
    const env = { DESK3_URL: `${stub.url}/providers/microsoft/v1/systemone`, DESK3_MODEL: 'Decision-1' };
    const result = await setup(stub, env).decide({ deskId: 3, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { inputTokens: 219, outputTokens: 6, cachedTokens: 0 });
    assert.equal(result.cost.basis, 'list');
    near(result.cost.usd, 219 * 0.042 / 1e6);

    // If an invoice shows output billed after all, one variable puts it back.
    const billed = await setup(stub, { ...env, DESK3_PRICE_OUT: '0.042' }).decide({ deskId: 3, paper: approvePaper() });
    assert.equal(billed.cost.basis, 'env');
    near(billed.cost.usd, (219 + 6) * 0.042 / 1e6);
  });
});

test('Grok 4.7: reasoning counts as output and cached input is charged at the cached rate', async () => {
  await withStub(() => chatReply('APPROVE', { usage: GROK_USAGE, model: 'grok-4.7' }), async (stub) => {
    const result = await setup(stub, { DESK3_MODEL: 'grok-4.7' }).decide({ deskId: 3, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { inputTokens: 210, outputTokens: 279, cachedTokens: 182 });
    assert.equal(result.cost.basis, 'list');
    near(result.cost.usd, (28 * 2 + 182 * 0.5 + 279 * 6) / 1e6);
  });
});

test('prices in .env win over the list; a cached rate is only borrowed from the list together with its input rate', async () => {
  const handler = () => chatReply('APPROVE', { usage: GROK_USAGE, model: 'grok-4.7' });
  await withStub(handler, async (stub) => {
    const own = await setup(stub, { DESK3_MODEL: 'grok-4.7', DESK3_PRICE_IN: '1', DESK3_PRICE_OUT: '3' }).decide({ deskId: 3, paper: approvePaper() });
    assert.equal(own.cost.basis, 'env');
    near(own.cost.usd, (210 * 1 + 279 * 3) / 1e6, 'cached tokens cost the input rate when only the input rate was given');

    const withCached = await setup(stub, { DESK3_MODEL: 'grok-4.7', DESK3_PRICE_IN: '1', DESK3_PRICE_OUT: '3', DESK3_PRICE_CACHED_IN: '0.25' }).decide({ deskId: 3, paper: approvePaper() });
    near(withCached.cost.usd, (28 * 1 + 182 * 0.25 + 279 * 3) / 1e6);

    const onlyOut = await setup(stub, { DESK3_MODEL: 'grok-4.7', DESK3_PRICE_OUT: '10' }).decide({ deskId: 3, paper: approvePaper() });
    assert.equal(onlyOut.cost.basis, 'env');
    near(onlyOut.cost.usd, (28 * 2 + 182 * 0.5 + 279 * 10) / 1e6, 'the list supplies the input side');
  });
});

test('a model with no known price has tokens but no cost, never a made-up zero', async () => {
  await withStub(() => chatReply('APPROVE', { usage: { prompt_tokens: 50, completion_tokens: 2 }, model: 'mystery-model' }), async (stub) => {
    const result = await setup(stub, { DESK2_MODEL: 'mystery-deployment' }).decide({ deskId: 2, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 2, cachedTokens: 0 });
    assert.equal(result.cost, null);
  });
});

test('a renamed deployment is still priced, through the model its response names', async () => {
  await withStub(() => responsesReply('APPROVE', { usage: GPT41_MINI_USAGE, model: 'gpt-4.1-mini-2025-04-14' }), async (stub) => {
    const runtime = setup(stub, responsesDesk(stub, 'prod-classifier'));
    const result = await runtime.decide({ deskId: 2, paper: approvePaper() });
    assert.equal(result.cost.basis, 'list');
    near(result.cost.usd, (215 * 0.4 + 4 * 1.6) / 1e6);
  });
});

test('a response without a usage block reports unknown tokens and no cost', async () => {
  const reply = responsesReply('APPROVE', { model: 'gpt-4.1-mini' });
  delete reply.json.usage;
  await withStub(() => reply, async (stub) => {
    const result = await setup(stub, responsesDesk(stub, 'gpt-4.1-mini')).decide({ deskId: 2, paper: approvePaper() });
    assert.equal(result.ok, true);
    assert.equal(result.usage, null);
    assert.equal(result.cost, null);
  });
});

// ---- Tokens that were spent on an unusable reply ----------------------------------------------------

test('an empty reply from a reasoning model still reports the tokens it burned and what they cost', async () => {
  // Out of budget while reasoning: HTTP 200, no text, finish_reason "length". These tokens were billed.
  const usage = { prompt_tokens: 210, completion_tokens: 0, total_tokens: 4306, completion_tokens_details: { reasoning_tokens: 4096 } };
  await withStub(() => chatReply('', { finish: 'length', usage, model: 'grok-4.7' }), async (stub) => {
    const result = await setup(stub, { DESK3_MODEL: 'grok-4.7' }).decide({ deskId: 3, paper: approvePaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_output');
    assert.deepEqual(result.usage, { inputTokens: 210, outputTokens: 4096, cachedTokens: 0 });
    near(result.cost.usd, (210 * 2 + 4096 * 6) / 1e6);
  });
});

test('a JEV reply without answers still reports its usage and reported cost', async () => {
  await withStub(() => ({ ...chatReply('Sure, I would approve.', { usage: KODEKEY_USAGE, model: 'typesafe/jev-1.13.0' }), headers: KODEKEY_HEADERS }), async (stub) => {
    const result = await setup(stub).decide({ deskId: 1, paper: approvePaper() });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_output');
    assert.deepEqual(result.usage, { inputTokens: 459, outputTokens: 108, cachedTokens: 0 });
    assert.deepEqual(result.cost, { usd: 0.000019278, basis: 'reported' });
  });
});

test('calls that never got an answer (HTTP errors) carry no usage and no cost', async () => {
  await withStub(() => ({ status: 401, json: { error: { message: 'bad key' } } }), async (stub) => {
    const result = await setup(stub).decide({ deskId: 1, paper: approvePaper() });
    assert.equal(result.ok, false);
    assert.ok(!('usage' in result) && !('cost' in result));
  });
});

// ---- Prices in the configuration --------------------------------------------------------------------

test('every model of the shipped profiles gets its list price, and only those', () => {
  const config = loadConfig({
    LINEUP: 'JEV,DECISION1,GPT41MINI',
    MODEL_JEV_PROVIDER: 'kodekey',
    MODEL_JEV_MODEL: 'typesafe/jev-1.13.0',
    MODEL_DECISION1_URL: 'https://r.services.ai.azure.com/providers/microsoft/v1/systemone',
    MODEL_DECISION1_MODEL: 'Decision-1',
    MODEL_GPT41MINI_URL: 'https://r.services.ai.azure.com/openai/v1/responses',
    MODEL_GPT41MINI_MODEL: 'gpt-4.1-mini',
    MODEL_GPT41_URL: 'https://r.services.ai.azure.com/openai/v1/responses',
    MODEL_GPT41_MODEL: 'gpt-4.1',
    MODEL_GROK47_URL: 'https://r.services.ai.azure.com/openai/v1/chat/completions',
    MODEL_GROK47_MODEL: 'grok-4.7',
    MODEL_CUSTOM_URL: 'https://r.services.ai.azure.com/openai/v1/chat/completions',
    MODEL_CUSTOM_MODEL: 'my-own-deployment',
  });
  const prices = Object.fromEntries(config.catalog.map((entry) => [entry.profile, [entry.priceIn, entry.priceCachedIn, entry.priceOut, entry.priceSource]]));
  assert.deepEqual(prices, {
    JEV: [0.042, null, 0, 'list'],
    DECISION1: [0.042, null, 0, 'list'],
    GPT41MINI: [0.4, 0.1, 1.6, 'list'],
    GPT41: [2, 0.5, 8, 'list'],
    GROK47: [2, 0.5, 6, 'list'],
    CUSTOM: [null, null, null, null],
  });
});

test('MODEL_<NAME>_PRICE_* in .env overrides the list, and prices any other model', () => {
  const config = loadConfig({
    LINEUP: 'GPT41MINI,CUSTOM',
    MODEL_GPT41MINI_MODEL: 'gpt-4.1-mini',
    MODEL_GPT41MINI_PRICE_IN: '0.3',
    MODEL_GPT41MINI_PRICE_OUT: '1.2',
    MODEL_CUSTOM_MODEL: 'my-own-deployment',
    MODEL_CUSTOM_PRICE_IN: '5',
    MODEL_CUSTOM_PRICE_CACHED_IN: '1',
    MODEL_CUSTOM_PRICE_OUT: '15',
  });
  const [mini, custom] = config.catalog;
  assert.deepEqual([mini.priceIn, mini.priceCachedIn, mini.priceOut, mini.priceSource], [0.3, null, 1.2, 'env']);
  assert.deepEqual([custom.priceIn, custom.priceCachedIn, custom.priceOut, custom.priceSource], [5, 1, 15, 'env']);
});

test('simulated models are priced like the real models they imitate', () => {
  const config = loadConfig({}, { mock: true });
  const prices = Object.fromEntries(config.catalog.map((entry) => [entry.profile, [entry.priceIn, entry.priceOut, entry.priceSource]]));
  assert.deepEqual(prices, {
    JEV: [0.042, 0, 'list'],
    DECISION1: [0.042, 0, 'list'],
    FAST_LLM: [0.4, 1.6, 'list'],
    LARGE_LLM: [2, 8, 'list'],
    REASONING_LLM: [2, 6, 'list'],
  });
});

test('publicConfig shows the price each model is charged at and where it comes from, but no secret', () => {
  const config = loadConfig({ KODEKEY_API_KEY: 'kk-TOPSECRET', DESK2_MODEL: 'gpt-4.1', FOUNDRY_ENDPOINT: 'https://r.services.ai.azure.com', FOUNDRY_API_KEY: 'fk-TOPSECRET' });
  const shown = publicConfig(config);
  assert.deepEqual(shown.desks.map((desk) => [desk.priceIn, desk.priceCachedIn, desk.priceOut, desk.priceSource, desk.envPrefix]), [
    [0.042, null, 0, 'list', 'DESK1_'],
    [2, 0.5, 8, 'list', 'DESK2_'],
    [null, null, null, null, 'DESK3_'],
  ]);
  assert.ok(!JSON.stringify(shown).includes('TOPSECRET'));
});

// ---- Simulated models take the same path as real ones ------------------------------------------------

test('simulated calls report tokens and a list-price cost, never a provider-reported one', async () => {
  const runtime = createRuntime(loadConfig({}, { mock: true }));
  // The default simulated line-up: JEV, Decision 1 and a fast LLM, priced like the models they imitate.
  const imitates = ['jev', 'decision-1', 'gpt-4.1-mini'];
  const results = await Promise.all(imitates.map((_, index) => runtime.decide({ deskId: index + 1, paper: { ...approvePaper(index + 1), hint: { truth: 'approve', violations: [] } } })));
  for (const [index, result] of results.entries()) {
    assert.equal(result.ok, true);
    assert.equal(result.usage.cachedTokens, 0);
    assert.ok(result.usage.inputTokens > 0);
    assert.equal(result.cost.basis, 'list');
    near(result.cost.usd, costOfUsage(result.usage, LIST_PRICES[imitates[index]]), `desk ${index + 1}`);
  }
});
