import { RULE_IDS } from '../shared/rulebook.js';
import { UpstreamError } from './http.js';

const DECISION_WORDS = /\b(approve[ds]?|reject(?:ed)?|den(?:y|ied))\b/gi;
const NEGATED_DECISION = /\b(?:not|never|cannot|can't|won't|don't|shouldn't)\s+(?:be\s+)?(approve[ds]?|reject(?:ed)?)\b/i;

/** Reads APPROVE / REJECT out of a short model reply. Returns null when it is missing or ambiguous. */
export function parseDecision(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[*_`#>"']/g, ' ').trim();
  const toDecision = (word) => (/^approv/i.test(word) ? 'approve' : 'reject');
  const lead = /^(approve[ds]?|reject(?:ed)?|den(?:y|ied))\b/i.exec(cleaned);
  if (lead) return toDecision(lead[1]);
  const negated = NEGATED_DECISION.exec(text.replace(/[*_`#>"]/g, ' '));
  if (negated) return toDecision(negated[1]) === 'approve' ? 'reject' : 'approve';
  const found = new Set([...cleaned.matchAll(DECISION_WORDS)].map((m) => toDecision(m[1])));
  return found.size === 1 ? [...found][0] : null;
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

const tokenCount = (value) => ((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null);

/**
 * The token counts a response reports, or null when it carries no usage block at all (so the caller can say "unknown"
 * instead of recording a made-up zero). `cachedTokens` is the part of `inputTokens` served from the prompt cache.
 */
export function readUsage(json) {
  const usage = json?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const reportedIn = tokenCount(usage.input_tokens) ?? tokenCount(usage.prompt_tokens);
  const reportedOut = tokenCount(usage.output_tokens) ?? tokenCount(usage.completion_tokens);
  if (reportedIn === null && reportedOut === null) return null;
  const inputTokens = reportedIn ?? 0;
  let outputTokens = reportedOut ?? 0;
  // xAI's Grok reports reasoning tokens next to completion_tokens instead of inside it (total = prompt + completion + reasoning),
  // yet bills them as output. OpenAI-style models already include them, so only add them when the totals show they are separate.
  const reasoning = tokenCount(usage.completion_tokens_details?.reasoning_tokens) ?? tokenCount(usage.output_tokens_details?.reasoning_tokens) ?? 0;
  if (reasoning > 0 && Number(usage.total_tokens) >= inputTokens + outputTokens + reasoning) outputTokens += reasoning;
  const cached = tokenCount(usage.input_tokens_details?.cached_tokens) ?? tokenCount(usage.prompt_tokens_details?.cached_tokens) ?? 0;
  return { inputTokens, outputTokens, cachedTokens: Math.min(cached, inputTokens) };
}

const REPORTED_COST_HEADER = 'x-litellm-response-cost';

/**
 * The cost in USD that the provider itself reports for one call, or null. LiteLLM gateways such as KodeKey put it in
 * `usage.cost` and in the x-litellm-response-cost header; Azure reports none.
 */
export function readReportedCost(json, headers) {
  for (const candidate of [json?.usage?.cost, headers?.get?.(REPORTED_COST_HEADER)]) {
    const value = typeof candidate === 'string' && candidate.trim() !== '' ? Number(candidate) : candidate;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/** Everything a response says about what it cost: tokens, the provider's own cost figure, and the model that served it. */
export function readBilling(json, headers, fallbackModel) {
  return { usage: readUsage(json), reportedCostUsd: readReportedCost(json, headers), model: json?.model ?? fallbackModel };
}

/**
 * Runs `interpret()` and attaches the billing of the response to its result. When the reply turns out to be unusable the
 * billing goes onto the error instead: the model still answered, so its tokens were still spent.
 */
export function withBilling(json, headers, fallbackModel, interpret) {
  const billing = readBilling(json, headers, fallbackModel);
  try {
    return { ...interpret(), billing };
  } catch (error) {
    if (error instanceof UpstreamError && !error.billing) error.billing = billing;
    throw error;
  }
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

const ANSWER_TYPES = new Set(['noul', 'choice', 'score']);

/** True for a bare answers map: { questionName: { type: 'noul' | 'choice' | 'score', ... } }. */
function looksLikeAnswers(value) {
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : [];
  return entries.length > 0 && entries.every((entry) => entry && typeof entry === 'object' && ANSWER_TYPES.has(entry.type));
}

/** Finds System One answers in a native response, or in a chat message (wrapped in `answers` or as a bare map). */
export function extractAnswers(json) {
  if (json?.answers && typeof json.answers === 'object') return json.answers;
  const message = json?.choices?.[0]?.message;
  const fromContent = parseJsonLoose(extractText(message?.content));
  if (fromContent?.answers && typeof fromContent.answers === 'object') return fromContent.answers;
  if (looksLikeAnswers(fromContent)) return fromContent;
  for (const call of message?.tool_calls ?? []) {
    const args = parseJsonLoose(call?.function?.arguments);
    if (args?.answers && typeof args.answers === 'object') return args.answers;
  }
  return null;
}

/** Collects P(violated) per rule from System One Noul answers. Throws when a rule is missing. */
export function probabilitiesFromAnswers(answers) {
  const probabilities = {};
  const missing = [];
  for (const id of RULE_IDS) {
    const value = answers?.[id]?.noul;
    if (typeof value === 'number' && value >= 0 && value <= 1) probabilities[id] = value;
    else missing.push(id);
  }
  if (missing.length) throw new UpstreamError(`System One answers are missing: ${missing.join(', ')}`, { code: 'invalid_output', status: 200 });
  return probabilities;
}

/** Composes the final decision in code, the way System One is meant to be used. */
export function decideFromProbabilities(probabilities) {
  const entries = Object.entries(probabilities);
  const confidenceOf = (p) => Math.abs(2 * p - 1);
  const violated = entries.filter(([, p]) => p >= 0.5).map(([id]) => id);
  const decision = violated.length > 0 ? 'reject' : 'approve';
  const confidence =
    decision === 'reject'
      ? Math.max(...violated.map((id) => confidenceOf(probabilities[id])))
      : Math.min(...entries.map(([, p]) => confidenceOf(p)));
  return { decision, violated, confidence, probabilities };
}
