import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFromProbabilities, extractAnswers, parseDecision, probabilitiesFromAnswers, readReportedCost, readUsage, withBilling } from '../server/decision.js';
import { UpstreamError } from '../server/http.js';
import { RULE_IDS } from '../shared/rulebook.js';

test('parseDecision reads one-word and decorated replies', () => {
  const cases = {
    APPROVE: 'approve',
    'Approve.': 'approve',
    approved: 'approve',
    REJECT: 'reject',
    '**REJECTED**': 'reject',
    'Denied': 'reject',
    '"reject"': 'reject',
    'Decision: REJECT': 'reject',
    'The application should be approved.': 'approve',
    'REJECT, forged permit': 'reject',
    'Not approved.': 'reject',
    'I cannot approve this application.': 'reject',
    "This shouldn't be rejected.": 'approve',
    'The application is not rejected': 'approve',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parseDecision(input), expected, input);
});

test('parseDecision refuses empty, off-topic and ambiguous replies', () => {
  for (const input of ['', '   ', 'I am not sure.', 'maybe approve or reject', null, undefined, 42]) assert.equal(parseDecision(input), null, String(input));
});

const allQuiet = () => Object.fromEntries(RULE_IDS.map((id) => [id, 0.02]));

test('decideFromProbabilities rejects when any rule is violated and reports confidence', () => {
  const approve = decideFromProbabilities(allQuiet());
  assert.equal(approve.decision, 'approve');
  assert.deepEqual(approve.violated, []);
  assert.ok(Math.abs(approve.confidence - 0.96) < 1e-9);

  const reject = decideFromProbabilities({ ...allQuiet(), contraband: 0.97, watchlist: 0.6 });
  assert.equal(reject.decision, 'reject');
  assert.deepEqual(reject.violated, ['contraband', 'watchlist']);
  assert.ok(Math.abs(reject.confidence - 0.94) < 1e-9);

  assert.equal(decideFromProbabilities({ ...allQuiet(), forged: 0.5 }).decision, 'reject');
});

test('approving is only as confident as the least certain rule', () => {
  const result = decideFromProbabilities({ ...allQuiet(), expired: 0.4 });
  assert.equal(result.decision, 'approve');
  assert.ok(Math.abs(result.confidence - 0.2) < 1e-9);
});

test('probabilitiesFromAnswers validates every rule is present and in range', () => {
  const answers = Object.fromEntries(RULE_IDS.map((id) => [id, { type: 'noul', noul: 0.1 }]));
  assert.equal(Object.keys(probabilitiesFromAnswers(answers)).length, RULE_IDS.length);
  const { forged, ...partial } = answers;
  assert.throws(() => probabilitiesFromAnswers(partial), /forged/);
  assert.throws(() => probabilitiesFromAnswers({ ...answers, expired: { noul: 1.5 } }), /expired/);
  assert.throws(() => probabilitiesFromAnswers({ ...answers, expired: { noul: '0.2' } }), /expired/);
});

test('extractAnswers finds System One answers natively, in message content, in code fences and in tool calls', () => {
  const answers = { forged: { type: 'noul', noul: 0.1 } };
  assert.deepEqual(extractAnswers({ answers }), answers);
  assert.deepEqual(extractAnswers({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }), answers);
  assert.deepEqual(extractAnswers({ choices: [{ message: { content: '```json\n' + JSON.stringify({ answers }) + '\n```' } }] }), answers);
  assert.deepEqual(
    extractAnswers({ choices: [{ message: { content: null, tool_calls: [{ function: { arguments: JSON.stringify({ answers }) } }] } }] }),
    answers,
  );
  assert.equal(extractAnswers({ choices: [{ message: { content: 'REJECT' } }] }), null);
  assert.equal(extractAnswers(null), null);
});

test('readUsage understands both OpenAI and System One usage shapes', () => {
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 3 } }), { inputTokens: 10, outputTokens: 3, cachedTokens: 0 });
  assert.deepEqual(readUsage({ usage: { input_tokens: 392, output_tokens: 65 } }), { inputTokens: 392, outputTokens: 65, cachedTokens: 0 });
  assert.deepEqual(readUsage({ usage: { input_tokens: '12', output_tokens: '3' } }), { inputTokens: 12, outputTokens: 3, cachedTokens: 0 }, 'numeric strings are accepted');
});

test('readUsage says "unknown" (null) when a response carries no token counts, instead of recording a zero', () => {
  for (const json of [{}, null, undefined, { usage: null }, { usage: {} }, { usage: { total_tokens: 12 } }, { usage: { prompt_tokens: null, completion_tokens: '' } }, { usage: 'many' }]) {
    assert.equal(readUsage(json), null, JSON.stringify(json));
  }
  // A reported zero is a real count, not an unknown.
  assert.deepEqual(readUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 7 } }), { inputTokens: 7, outputTokens: 0, cachedTokens: 0 });
});

test('readUsage counts reasoning tokens that a provider reports outside completion_tokens, without double counting', () => {
  // xAI Grok shape (taken from a real reply): total = prompt + completion + reasoning
  const grok = { usage: { prompt_tokens: 213, completion_tokens: 1, total_tokens: 495, completion_tokens_details: { reasoning_tokens: 281 } } };
  assert.deepEqual(readUsage(grok), { inputTokens: 213, outputTokens: 282, cachedTokens: 0 });
  // OpenAI shape: reasoning tokens are already part of completion_tokens, so nothing is added
  const openai = { usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600, completion_tokens_details: { reasoning_tokens: 300 } } };
  assert.deepEqual(readUsage(openai), { inputTokens: 100, outputTokens: 500, cachedTokens: 0 });
  // Responses API shape
  const responses = { usage: { input_tokens: 100, output_tokens: 500, total_tokens: 600, output_tokens_details: { reasoning_tokens: 300 } } };
  assert.deepEqual(readUsage(responses), { inputTokens: 100, outputTokens: 500, cachedTokens: 0 });
  // no total reported: trust completion_tokens
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 50 } } }), { inputTokens: 10, outputTokens: 2, cachedTokens: 0 });
});

test('readUsage reports the cached part of the input from either usage shape, never more than the input itself', () => {
  // Real Grok 4.7 reply on a repeated prompt: 182 of 210 prompt tokens came from the cache, reasoning is reported separately.
  const grok = {
    usage: {
      prompt_tokens: 210,
      completion_tokens: 2,
      total_tokens: 489,
      prompt_tokens_details: { cached_tokens: 182, text_tokens: 210 },
      completion_tokens_details: { reasoning_tokens: 277 },
    },
  };
  assert.deepEqual(readUsage(grok), { inputTokens: 210, outputTokens: 279, cachedTokens: 182 });
  const responses = { usage: { input_tokens: 2048, output_tokens: 4, input_tokens_details: { cached_tokens: 1920, cache_write_tokens: 0 } } };
  assert.deepEqual(readUsage(responses), { inputTokens: 2048, outputTokens: 4, cachedTokens: 1920 });
  assert.equal(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 99 } } }).cachedTokens, 10);
});

test('readReportedCost takes the provider\'s own figure from the usage block or the LiteLLM header, and nothing else', () => {
  const header = (value) => new Headers(value === undefined ? {} : { 'x-litellm-response-cost': value });
  // What KodeKey returns for a JEV call: the same figure in the body and in the header.
  assert.equal(readReportedCost({ usage: { cost: 0.000019278 } }, header('1.9278000000000004e-05')), 0.000019278);
  assert.equal(readReportedCost({ usage: { prompt_tokens: 1 } }, header('1.9278000000000004e-05')), 1.9278000000000004e-5);
  assert.equal(readReportedCost({ usage: { cost: 0 } }, header()), 0, 'a reported zero is a real cost');
  assert.equal(readReportedCost({ usage: { cost: 0.25 } }, undefined), 0.25, 'no headers at all');
  for (const [json, headers] of [
    [{ usage: {} }, header()],
    [null, undefined],
    [{ usage: { cost: null } }, header('')],
    [{ usage: { cost: 'free' } }, header('n/a')],
    [{ usage: { cost: -1 } }, header('-3')],
    [{ usage: { cost: Number.NaN } }, header('Infinity')],
  ]) {
    assert.equal(readReportedCost(json, headers), null);
  }
});

test('withBilling attaches tokens, reported cost and the serving model to a result, and to the error of an unusable reply', () => {
  const json = { model: 'served-model', usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.5 } };
  const ok = withBilling(json, undefined, 'deployment', () => ({ decision: 'approve' }));
  assert.deepEqual(ok, { decision: 'approve', billing: { usage: { inputTokens: 20, outputTokens: 5, cachedTokens: 0 }, reportedCostUsd: 0.5, model: 'served-model' } });

  const bare = withBilling({}, undefined, 'deployment', () => ({ decision: 'reject' }));
  assert.deepEqual(bare.billing, { usage: null, reportedCostUsd: null, model: 'deployment' });

  const unusable = new UpstreamError('empty reply', { code: 'invalid_output', status: 200 });
  assert.throws(() => withBilling(json, undefined, 'deployment', () => { throw unusable; }), (error) => error === unusable && error.billing.usage.outputTokens === 5);
  const unrelated = new Error('boom');
  assert.throws(() => withBilling(json, undefined, 'deployment', () => { throw unrelated; }), (error) => error === unrelated && !('billing' in error));
});
