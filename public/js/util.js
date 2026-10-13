export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** One accent colour per desk, shared by the canvas and the report. */
export const DESK_ACCENTS = ['#2dd4bf', '#f4a261', '#a78bfa'];
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOut = (t) => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
};

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[clamp(index, 0, sorted.length - 1)];
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1).padStart(4, '0');
  return `${minutes}m ${seconds}s`;
}

export function fmtClock(ms) {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function fmtTokens(count) {
  if (!count) return '0';
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(Math.round(count));
}

export function fmtMoney(usd) {
  if (usd === null || usd === undefined) return 'n/a';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

export const fmtPercent = (ratio) => (ratio === null || Number.isNaN(ratio) ? '-' : `${Math.round(ratio * 100)}%`);

/** Tiny DOM builder. Strings become text nodes, so model output can never inject markup. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...cleanChildren(children));
  return node;
}

function cleanChildren(children) {
  return children
    .flat()
    .filter((child) => child !== null && child !== undefined && child !== false)
    .map((child) => (child instanceof Node ? child : document.createTextNode(String(child))));
}

/** replaceChildren that skips null/false entries instead of rendering them as the text "null". */
export function fill(container, ...children) {
  container.replaceChildren(...cleanChildren(children));
}
