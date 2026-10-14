import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtMoney, fmtPrice, fmtTokenTotal, fmtTokens } from '../public/js/util.js';

test('fmtMoney keeps two significant digits for micro-costs, so a race that costs $0.000098 is not shown as $0.0001', () => {
  const cases = [
    [null, 'n/a'],
    [undefined, 'n/a'],
    [0, '$0'],
    [4.2e-8, '$0.00000004'],
    [9.46e-6, '$0.0000095'],
    [1.9278e-5, '$0.000019'],
    [9.786e-5, '$0.000098'],
    [1.9656e-4, '$0.0002'],
    [9.512e-4, '$0.00095'],
    [0.001605, '$0.00161'],
    [0.0364, '$0.036'],
    [0.5, '$0.500'],
    [1.5, '$1.50'],
    [12, '$12.00'],
  ];
  for (const [usd, expected] of cases) assert.equal(fmtMoney(usd), expected, String(usd));
});

test('a real, non-zero cost never shows as $0', () => {
  for (const usd of [4.2e-8, 1e-7, 3.3e-6, 0.00000945, 0.0000099]) assert.notEqual(fmtMoney(usd), '$0', String(usd));
});

test('fmtPrice shows a price per million tokens', () => {
  const cases = [[0, 'free'], [0.042, '$0.042'], [0.1, '$0.10'], [0.4, '$0.40'], [1.6, '$1.60'], [2, '$2.00'], [0.05, '$0.05'], [0.0125, '$0.0125']];
  for (const [usd, expected] of cases) assert.equal(fmtPrice(usd), expected, String(usd));
});

test('fmtTokens abbreviates thousands', () => {
  assert.deepEqual([0, undefined, 60, 999, 1000, 2270, 5760].map(fmtTokens), ['0', '0', '60', '999', '1.0k', '2.3k', '5.8k']);
});

test('fmtTokenTotal shows unknown tokens as n/a instead of 0', () => {
  assert.equal(fmtTokenTotal({ tokensIn: 0, tokensOut: 0, tokensMissing: 0 }), '0');
  assert.equal(fmtTokenTotal({ tokensIn: 0, tokensOut: 0, tokensMissing: 4 }), 'n/a');
  assert.equal(fmtTokenTotal({ tokensIn: 2200, tokensOut: 60, tokensMissing: 4 }), '2.3k', 'a partial total is still shown, the report flags the gap');
  assert.equal(fmtTokenTotal({ tokensIn: 210, tokensOut: 4096, tokensMissing: 0 }), '4.3k');
});
