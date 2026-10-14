/**
 * What a model call costs. Prices are USD per 1M tokens.
 *
 * LIST_PRICES holds the published pay-as-you-go prices of the models this game ships profiles for. They are only
 * defaults: MODEL_<NAME>_PRICE_IN / _PRICE_OUT / _PRICE_CACHED_IN in .env win, and a cost that the provider reports
 * for a call (KodeKey does) is believed over any table. Checked on 14 October 2026:
 *  - GPT-4.1, GPT-4.1 mini, Grok 4.7 and Decision 1: Azure Retail Prices API (https://prices.azure.com/api/retail/prices),
 *    Foundry Models, Global Standard. Data Zone and Regional deployments cost more.
 *  - Decision 1: Azure lists a single "Microsoft Decision 1 1M Tokens" meter at $0.042, the same rate as JEV's input price, and no
 *    separate output meter (every text-generation model has one). TypeSafe, whose System One API Decision 1 shares, charges
 *    for input tokens only: "Output tokens: FREE (too cheap to meter)". So Decision 1's output is treated as free too.
 *    Microsoft does not spell this out; if your invoice shows output tokens billed, set MODEL_<NAME>_PRICE_OUT=0.042.
 *  - JEV: TypeSafe's list price, $0.042 per 1M input tokens and free output. KodeKey's own per-call figure agrees with it.
 */
export const PRICES_AS_OF = '14 October 2026';

const DATED = '(?:-\\d{4}-\\d{2}-\\d{2})?';
const exact = (name) => new RegExp(`^${name}${DATED}$`, 'i');

// `match` is tested against a deployment name or the model id a response reports. It is anchored on purpose:
// "gpt-4.1-mini-ft" (a fine-tune) must not be priced like the base model.
export const LIST_PRICES = {
  jev: { label: 'JEV', in: 0.042, cachedIn: null, out: 0, match: /\bjev\b/i },
  'decision-1': { label: 'Decision 1', in: 0.042, cachedIn: null, out: 0, match: /\bdecision[-_ ]?1\b/i },
  'gpt-4.1-mini': { label: 'GPT-4.1 mini', in: 0.4, cachedIn: 0.1, out: 1.6, match: exact('gpt-?4\\.1-?mini') },
  'gpt-4.1': { label: 'GPT-4.1', in: 2, cachedIn: 0.5, out: 8, match: exact('gpt-?4\\.1') },
  'grok-4.7': { label: 'Grok 4.7', in: 2, cachedIn: 0.5, out: 6, match: exact('grok-?4\\.7') },
};

/** The list price of the first of `names` (deployment names or model ids) that is a known model. */
export function listPriceFor(...names) {
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    const found = Object.values(LIST_PRICES).find((entry) => entry.match.test(name));
    if (found) return found;
  }
  return null;
}

/**
 * USD for one call. Cached input tokens are part of `inputTokens` and are charged at the cached rate when the price
 * has one; otherwise they cost the normal input rate.
 * @param {{inputTokens:number, outputTokens:number, cachedTokens?:number}} usage
 * @param {{in:number, cachedIn?:number|null, out:number}} price
 */
export function costOfUsage({ inputTokens, outputTokens, cachedTokens = 0 }, price) {
  const cached = Math.min(cachedTokens, inputTokens);
  return ((inputTokens - cached) * price.in + cached * (price.cachedIn ?? price.in) + outputTokens * price.out) / 1e6;
}
