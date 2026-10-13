import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatedDelayMs } from '../server/providers/mock.js';

// Median per-decision delays seen in the live runs on 13 October 2026 (see docs/about-the-models.md).
const MEASURED_MS = { decision1: 450, jev: 560, fast: 900, large: 1350, reasoning: 5600 };

function median(sim) {
  const delays = Array.from({ length: 400 }, (_, index) => simulatedDelayMs(sim, index + 1)).sort((a, b) => a - b);
  return (delays[199] + delays[200]) / 2;
}

test('simulated delays follow the live measurements', () => {
  for (const [sim, measured] of Object.entries(MEASURED_MS)) {
    const simulated = median(sim);
    assert.ok(simulated / measured > 0.9 && simulated / measured < 1.1, `${sim}: simulated median ${Math.round(simulated)} ms vs measured ${measured} ms`);
  }
});

test('the simulated ladder keeps the order and the headline gaps seen live', () => {
  const m = Object.fromEntries(Object.keys(MEASURED_MS).map((sim) => [sim, median(sim)]));
  assert.ok(m.decision1 < m.jev && m.jev < m.fast && m.fast < m.large && m.large < m.reasoning, JSON.stringify(m));
  assert.ok(m.fast / m.jev < 2.5, 'against a small LLM the gap is modest, not several-fold');
  assert.ok(m.reasoning / m.jev > 8, 'against a reasoning model the gap is large');
});

test('simulated delays are deterministic per model and paper, and stay inside the measured range', () => {
  assert.equal(simulatedDelayMs('jev', 7), simulatedDelayMs('jev', 7));
  assert.notEqual(simulatedDelayMs('jev', 7), simulatedDelayMs('jev', 8));
  for (let id = 1; id <= 200; id++) {
    const delay = simulatedDelayMs('reasoning', id);
    assert.ok(delay >= 3800 && delay <= 11500, `paper ${id}: ${delay}`);
  }
});
