import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFromProbabilities, extractAnswers, parseDecision, probabilitiesFromAnswers, readUsage } from '../server/decision.js';
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
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 3 } }), { inputTokens: 10, outputTokens: 3 });
  assert.deepEqual(readUsage({ usage: { input_tokens: 392, output_tokens: 65 } }), { inputTokens: 392, outputTokens: 65 });
  assert.deepEqual(readUsage({}), { inputTokens: 0, outputTokens: 0 });
});

test('readUsage counts reasoning tokens that a provider reports outside completion_tokens, without double counting', () => {
  // xAI Grok shape (taken from a real reply): total = prompt + completion + reasoning
  const grok = { usage: { prompt_tokens: 213, completion_tokens: 1, total_tokens: 495, completion_tokens_details: { reasoning_tokens: 281 } } };
  assert.deepEqual(readUsage(grok), { inputTokens: 213, outputTokens: 282 });
  // OpenAI shape: reasoning tokens are already part of completion_tokens, so nothing is added
  const openai = { usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600, completion_tokens_details: { reasoning_tokens: 300 } } };
  assert.deepEqual(readUsage(openai), { inputTokens: 100, outputTokens: 500 });
  // Responses API shape
  const responses = { usage: { input_tokens: 100, output_tokens: 500, total_tokens: 600, output_tokens_details: { reasoning_tokens: 300 } } };
  assert.deepEqual(readUsage(responses), { inputTokens: 100, outputTokens: 500 });
  // no total reported: trust completion_tokens
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 50 } } }), { inputTokens: 10, outputTokens: 2 });
});
