import { SAMPLE_PAPERS } from '../shared/rulebook.js';
import { publicConfig } from './config.js';
import { UpstreamError, requestJson, withAuthFallback, withRetries } from './http.js';
import { callJevMode, probeJevMode } from './providers/jev.js';
import { callLlm, probeLlmApi } from './providers/llm.js';
import { callMock } from './providers/mock.js';

const round1 = (value) => Math.round(value * 10) / 10;

/** Removes any configured API key from text that is about to leave the server. */
function makeRedactor(config) {
  const secrets = new Set();
  for (const desk of config.catalog) {
    for (const headers of [desk.upstream.headers, desk.upstream.altHeaders ?? {}]) {
      for (const value of Object.values(headers)) {
        const secret = String(value).replace(/^Bearer\s+/i, '');
        if (secret.length >= 6) secrets.add(secret);
      }
    }
  }
  return (text) => [...secrets].reduce((out, secret) => out.split(secret).join('***'), String(text));
}

/**
 * Runs desk decisions against their providers. Latency is measured around the model call only:
 * one-off detection (how JEV is called, which API an LLM deployment speaks) happens before the clock
 * starts, and retries are included because they are part of what the approver actually waited for.
 */
export function createRuntime(config, { fetchImpl = globalThis.fetch, clock = () => performance.now() } = {}) {
  const jevModes = new Map();
  const jevProbes = new Map();
  const llmApis = new Map();
  const llmProbes = new Map();
  const redact = makeRedactor(config);
  const catalog = new Map(config.catalog.map((entry) => [entry.profile, entry]));
  const seat = (entry, id) => ({ ...entry, id });
  /** The model at a desk: the profile the browser names, or the default line-up's model for that desk. */
  const deskFor = (deskId, profile) => {
    if (profile === undefined || profile === null) return config.desks.find((desk) => desk.id === deskId);
    return catalog.has(profile) ? seat(catalog.get(profile), deskId) : undefined;
  };
  /** Desks for a requested line-up (profile names by desk position), or the default line-up. Unknown names become null. */
  const desksFor = (profiles) => (profiles ? profiles.map((name, index) => (catalog.has(name) ? seat(catalog.get(name), index + 1) : null)) : config.desks);
  const httpOptions = (signal) => ({ signal, timeoutMs: config.timeoutMs, fetchImpl });

  /** Resolves a cached answer, or runs one shared probe (concurrent callers wait for the same one). Keyed by profile, not desk. */
  function resolveOnce(cache, probes, desk, probe) {
    if (cache.has(desk.profile)) return Promise.resolve(cache.get(desk.profile));
    if (!probes.has(desk.profile)) {
      const pending = probe()
        .then((value) => {
          cache.set(desk.profile, value);
          return value;
        })
        .finally(() => probes.delete(desk.profile));
      probes.set(desk.profile, pending);
    }
    return probes.get(desk.profile);
  }

  function ensureJevMode(desk, signal) {
    if (desk.mode !== 'auto') {
      jevModes.set(desk.profile, desk.mode);
      return Promise.resolve(desk.mode);
    }
    return resolveOnce(jevModes, jevProbes, desk, async () => (await probeJevMode(desk, httpOptions(signal))).mode);
  }

  function ensureLlmApi(desk, signal) {
    if (desk.api !== 'auto') {
      llmApis.set(desk.profile, desk.api);
      return Promise.resolve(desk.api);
    }
    return resolveOnce(llmApis, llmProbes, desk, async () => (await probeLlmApi(desk, httpOptions(signal))).api);
  }

  /** Runs the one-off detection a desk needs, if any. Never part of a timed call. */
  function resolveAdapter(desk, signal) {
    if (desk.kind === 'systemone') return ensureJevMode(desk, signal);
    return ensureLlmApi(desk, signal);
  }

  async function callDesk(desk, paper, signal) {
    if (config.mock) return callMock(desk, paper, { signal });
    if (desk.kind === 'systemone') return callJevMode(jevModes.get(desk.profile) ?? desk.mode, desk, paper.dossier, httpOptions(signal));
    return callLlm(desk, paper.dossier, httpOptions(signal), llmApis.get(desk.profile) ?? 'chat');
  }

  const failure = (desk, paper, error, started, attempts) => {
    const known = error instanceof UpstreamError;
    if (!known) console.error(`[desk ${desk.id}] unexpected error:`, error);
    return {
      ok: false,
      deskId: desk.id,
      paperId: paper.id,
      error: known ? redact(error.message) : 'Unexpected server error',
      code: known ? error.code : 'internal',
      status: known ? error.status : 0,
      latencyMs: started === null ? 0 : round1(clock() - started),
      attempts: known ? (error.attempts ?? attempts) : attempts,
    };
  };

  /** @param {{deskId:number, profile?:string, paper:{id:number, dossier:object, hint?:object}}} request */
  async function decide({ deskId, profile, paper }, { signal } = {}) {
    const desk = deskFor(deskId, profile);
    if (!desk) {
      const error = profile === undefined || profile === null ? `Unknown desk ${deskId}` : `Unknown model "${String(profile).slice(0, 40)}"`;
      return { ok: false, deskId, paperId: paper.id, error, code: 'unknown_desk', status: 404, latencyMs: 0, attempts: 0 };
    }
    if (!desk.configured) {
      const error = new UpstreamError(`Desk ${desk.id} is not configured (missing ${desk.missing.join(', ')})`, { code: 'not_configured', status: 400 });
      return failure(desk, paper, error, null, 0);
    }

    let started = null;
    try {
      if (!config.mock) await resolveAdapter(desk, signal);
      started = clock();
      const { value, attempts } = await withRetries(() => callDesk(desk, paper, signal), { retries: config.maxRetries, signal });
      return {
        ok: true,
        deskId: desk.id,
        paperId: paper.id,
        decision: value.decision,
        latencyMs: round1(clock() - started),
        attempts,
        usage: value.usage,
        model: value.model,
        detail: value.detail,
      };
    } catch (error) {
      return failure(desk, paper, error, started, error.attempts ?? 1);
    }
  }

  /**
   * Opens the connection before the race. For Azure hosts it also validates the key and settles api-key vs bearer
   * with a free GET (no tokens), so a wrong key shows up before the shift and the first timed call never pays for a
   * header retry. Only a 401 matters here; any other answer just means the connection is warm.
   */
  async function primeConnection(desk, signal) {
    const origin = new URL(desk.upstream.chatUrl).origin;
    try {
      if (!desk.upstream.altHeaders) await requestJson(origin, { method: 'GET', timeoutMs: 4000, signal, fetchImpl });
      else {
        await withAuthFallback(desk, (headers) => requestJson(`${origin}/openai/v1/models`, { method: 'GET', headers, timeoutMs: 8000, signal, fetchImpl }));
      }
    } catch (error) {
      if (error.status === 401 && desk.upstream.altHeaders) throw error;
    }
  }

  /** Warms every configured desk and resolves how each model must be called. Costs tokens only if detection runs. */
  async function prepare({ signal, profiles } = {}) {
    return Promise.all(
      desksFor(profiles).map(async (desk, index) => {
        if (!desk) return { deskId: index + 1, ok: false, error: 'Unknown model', status: 404 };
        if (!desk.configured) return { deskId: desk.id, ok: false, error: `Missing ${desk.missing.join(', ')}`, status: 400 };
        if (config.mock) return { deskId: desk.id, ok: true };
        try {
          const [resolved] = await Promise.all([resolveAdapter(desk, signal), primeConnection(desk, signal)]);
          return { deskId: desk.id, ok: true, ...(desk.kind === 'systemone' ? { mode: resolved } : { api: resolved }) };
        } catch (error) {
          return { deskId: desk.id, ok: false, error: redact(error.message), status: error.status ?? 0 };
        }
      }),
    );
  }

  /** Sends one clean and one clearly bad sample application through every desk (or just `deskIds`) of a line-up. */
  async function test({ signal, deskIds, profiles } = {}) {
    const samples = [
      { name: 'clean application', expected: 'approve', paper: { id: 1, dossier: SAMPLE_PAPERS.approve, hint: { truth: 'approve', violations: [] } } },
      { name: 'application with prohibited goods', expected: 'reject', paper: { id: 2, dossier: SAMPLE_PAPERS.reject, hint: { truth: 'reject', violations: ['contraband'] } } },
    ];

    async function testDesk(desk, index) {
      if (!desk) return { deskId: index + 1, ok: false, skipped: true, error: 'Unknown model', checks: [] };
      if (!desk.configured) return { deskId: desk.id, ok: false, skipped: true, error: `Missing ${desk.missing.join(', ')}`, checks: [] };
      const checks = await Promise.all(
        samples.map(async ({ name, expected, paper }) => {
          const result = await decide({ deskId: desk.id, profile: desk.profile, paper }, { signal });
          return {
            name,
            expected,
            ok: result.ok,
            got: result.ok ? result.decision : null,
            correct: result.ok && result.decision === expected,
            latencyMs: result.latencyMs,
            error: result.ok ? undefined : result.error,
            status: result.ok ? undefined : result.status,
          };
        }),
      );
      return { deskId: desk.id, ok: checks.every((c) => c.ok), mode: jevModes.get(desk.profile), api: llmApis.get(desk.profile), checks };
    }

    return Promise.all(desksFor(profiles).map((desk, index) => (!deskIds || deskIds.includes(desk?.id ?? index + 1) ? testDesk(desk, index) : null)).filter(Boolean));
  }

  return { decide, prepare, test, publicConfig: () => publicConfig(config, jevModes, llmApis), jevModes, llmApis, redact };
}
