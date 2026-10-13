export class UpstreamError extends Error {
  constructor(message, { status = 0, retryable = false, code = 'upstream', retryAfterMs = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.attempts = 1;
  }
}

const cancelled = () => new UpstreamError('Cancelled', { code: 'cancelled' });

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function describeError(json, text, status) {
  const raw = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : null) ?? json?.message ?? json?.detail;
  const message = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)) : text.slice(0, 200);
  return `HTTP ${status}: ${message || 'empty response body'}`;
}

/**
 * JSON request with a hard timeout and cancellation. Failures are normalised to UpstreamError so
 * callers can decide whether to retry. The API key only ever travels in `headers`.
 */
export async function requestJson(url, { method = 'POST', headers = {}, body, signal, timeoutMs = 60000, fetchImpl = globalThis.fetch } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combined,
    });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (timeout.aborted) throw new UpstreamError(`Timed out after ${timeoutMs} ms`, { code: 'timeout', retryable: true });
    const reason = error.cause?.code ?? error.cause?.message ?? error.message;
    throw new UpstreamError(`Network error: ${reason}`, { code: 'network', retryable: true });
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies are handled below.
  }

  if (!response.ok) {
    throw new UpstreamError(describeError(json, text, response.status), {
      status: response.status,
      code: 'http',
      retryable: RETRYABLE_STATUS.has(response.status),
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }
  if (json === null) {
    throw new UpstreamError(`HTTP ${response.status}: response was not JSON ("${text.slice(0, 80)}")`, { status: response.status, code: 'invalid_output' });
  }
  return { status: response.status, json };
}

/** Retries transient failures with exponential backoff. Resolves `{ value, attempts }`. */
export async function withRetries(fn, { retries = 2, baseDelayMs = 250, maxDelayMs = 5000, signal } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (error) {
      if (error instanceof UpstreamError) error.attempts = attempt;
      if (!(error instanceof UpstreamError) || !error.retryable || attempt > retries) throw error;
      await sleep(Math.min(error.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1), maxDelayMs), signal);
    }
  }
}

const TUNABLE_PARAMS = ['temperature', 'reasoning_effort', 'reasoning', 'max_output_tokens', 'top_p', 'store'];

/** Adjusts the body for a 400 that names an unsupported parameter. Returns true when it changed something. */
function adjustForUnsupportedParam(body, message) {
  const text = message.toLowerCase();
  if (text.includes('max_completion_tokens') && 'max_completion_tokens' in body) {
    body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
    return true;
  }
  if (text.includes('max_tokens') && 'max_tokens' in body) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    return true;
  }
  for (const key of TUNABLE_PARAMS) {
    if (text.includes(key) && key in body) {
      delete body[key];
      return true;
    }
  }
  return false;
}

/** Chat-completions / Responses POST that adapts to models rejecting optional parameters. */
export async function postChat(url, { headers, body, ...options }) {
  const payload = { ...body };
  for (let adjustments = 0; ; adjustments++) {
    try {
      return await requestJson(url, { ...options, headers, body: payload });
    } catch (error) {
      if (error.status !== 400 || adjustments >= 3 || !adjustForUnsupportedParam(payload, error.message)) throw error;
    }
  }
}

/**
 * Runs `send(headers)` with the desk's primary auth style. A 401 triggers one retry with the alternative style
 * (api-key <-> bearer). The style that works is remembered; promotion is idempotent so concurrent callers that
 * both fail on the old style cannot swap it back. Any non-401 outcome is reported as is.
 */
export async function withAuthFallback(desk, send) {
  const { upstream } = desk;
  const primary = upstream.headers;
  const alternative = upstream.altHeaders;
  const promote = () => {
    if (upstream.headers === primary) {
      upstream.headers = alternative;
      upstream.altHeaders = primary;
    }
  };
  try {
    return await send(primary);
  } catch (error) {
    if (error.status !== 401 || !alternative) throw error;
    let result;
    try {
      result = await send(alternative);
    } catch (second) {
      if (second.status === 401) throw error;
      promote();
      throw second;
    }
    promote();
    return result;
  }
}
