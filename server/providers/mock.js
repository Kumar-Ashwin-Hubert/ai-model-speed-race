import { RULE_IDS, dossierToText, makeRng } from '../../shared/rulebook.js';
import { decideFromProbabilities } from '../decision.js';
import { sleep } from '../http.js';

/**
 * Simulated models for developing and demoing without keys. The delays and token counts are modelled on live
 * runs on 13 October 2026 (see docs/about-the-models.md): JEV via KodeKey, Decision 1, GPT-4.1 mini, GPT-4.1 and
 * Grok 4.7 at its default reasoning effort. Accuracy is deliberately NOT modelled on those runs (every real model
 * scored 100%): all simulated models get the same 99%, so the report can show mistakes without implying a ranking.
 * Nothing here is a measurement, and the game shows a SIMULATED badge whenever this provider is active.
 */
const PROFILES = {
  jev: { median: 560, min: 380, max: 1200, sigma: 0.22, accuracy: 0.99, tokensIn: 466, tokensOut: 108 },
  decision1: { median: 450, min: 290, max: 1500, sigma: 0.3, accuracy: 0.99, tokensIn: 225, tokensOut: 6 },
  fast: { median: 900, min: 750, max: 1800, sigma: 0.18, accuracy: 0.99, tokensIn: 222, tokensOut: 3 },
  large: { median: 1350, min: 850, max: 2300, sigma: 0.2, accuracy: 0.99, tokensIn: 222, tokensOut: 4 },
  reasoning: { median: 5600, min: 3800, max: 11500, sigma: 0.3, accuracy: 0.99, tokensIn: 216, tokensOut: 333 },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const SIM_SEEDS = { jev: 1, fast: 2, reasoning: 3, decision1: 4, large: 5 };

/** A stable number for a paper. Content-based, so mistakes land on different applicants from queue to queue (a bare applicant number would repeat them). */
function keyOf(paper) {
  if (typeof paper === 'number') return paper;
  if (!paper?.dossier) return paper?.id ?? 0;
  let hash = 2166136261; // FNV-1a over the dossier text
  for (const char of dossierToText(paper.dossier)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return hash >>> 0;
}

/** One random stream per simulated model and paper, so replaying a queue replays the same delays and mistakes. */
const streamFor = (sim, paper) => makeRng((SIM_SEEDS[sim] ?? SIM_SEEDS.fast) * 7919 + keyOf(paper) * 104729);

/** Log-normal around the model's median, kept inside the range seen in the live runs. Always draws two numbers. */
function drawDelayMs(rng, profile) {
  const gaussian = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  return clamp(profile.median * Math.exp(profile.sigma * gaussian), profile.min, profile.max);
}

/** Everything random about one simulated call, drawn from one stream in a fixed order. */
function plan(sim, paper) {
  const profile = PROFILES[sim] ?? PROFILES.fast;
  const rng = streamFor(sim, paper);
  const delayMs = drawDelayMs(rng, profile);
  const mistake = rng() >= profile.accuracy;
  return { profile, rng, delayMs, mistake };
}

/** How long a simulated model takes on a paper. Exported so tests can check the calibration without waiting. */
export const simulatedDelayMs = (sim, paper) => plan(sim, paper).delayMs;

/** Whether a simulated model gets a paper wrong. Exported so tests can check that mistakes spread evenly. */
export const simulatedMistake = (sim, paper) => plan(sim, paper).mistake;

export async function callMock(desk, paper, { signal } = {}) {
  const sim = desk.sim ?? (desk.kind === 'systemone' ? 'jev' : desk.id === 2 ? 'fast' : 'reasoning');
  const { profile, rng, delayMs, mistake } = plan(sim, paper);
  await sleep(delayMs, signal);

  const truth = paper.hint?.truth === 'reject' ? 'reject' : 'approve';
  const decision = mistake ? (truth === 'approve' ? 'reject' : 'approve') : truth;
  const usage = { inputTokens: Math.round(profile.tokensIn * (0.9 + rng() * 0.2)), outputTokens: profile.tokensOut };

  if (desk.kind !== 'systemone') {
    return { decision, detail: { kind: 'llm', reply: decision.toUpperCase(), finishReason: 'stop' }, usage, model: desk.model };
  }
  const hinted = paper.hint?.violations ?? [];
  const violated = decision === 'reject' ? (hinted.length ? hinted : [RULE_IDS[Math.floor(rng() * RULE_IDS.length)]]) : [];
  const probabilities = Object.fromEntries(RULE_IDS.map((id) => [id, violated.includes(id) ? 0.88 + rng() * 0.11 : rng() * 0.06]));
  const result = decideFromProbabilities(probabilities);
  return {
    decision: result.decision,
    detail: { kind: 'systemone', mode: 'simulated', probabilities, violated: result.violated, confidence: result.confidence },
    usage,
    model: desk.model,
  };
}
