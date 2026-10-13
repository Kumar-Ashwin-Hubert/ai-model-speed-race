import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatedDelayMs, simulatedMistake } from '../server/providers/mock.js';
import { generatePapers } from '../shared/rulebook.js';

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

test('simulated mistakes spread evenly across models and land on different applicants from queue to queue', () => {
  const sims = ['jev', 'decision1', 'fast', 'large', 'reasoning'];
  const mistakes = Object.fromEntries(sims.map((sim) => [sim, 0]));
  const jevMistakeNumbers = new Set();
  let papersSeen = 0;
  for (let seed = 1; seed <= 300; seed++) {
    for (const paper of generatePapers(seed, 20)) {
      papersSeen++;
      for (const sim of sims) {
        if (!simulatedMistake(sim, paper)) continue;
        mistakes[sim]++;
        if (sim === 'jev') jevMistakeNumbers.add(paper.id);
      }
    }
  }
  // 99% accuracy over 6,000 papers is about 60 mistakes per model; the band is wide, the draw is deterministic.
  for (const sim of sims) assert.ok(mistakes[sim] > 30 && mistakes[sim] < 100, `${sim}: ${mistakes[sim]} mistakes in ${papersSeen} papers`);
  assert.ok(jevMistakeNumbers.size > 8, `JEV's mistakes hit only ${jevMistakeNumbers.size} different applicant numbers`);
});
