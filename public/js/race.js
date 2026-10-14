import { costOfUsage } from '../../shared/pricing.js';
import { percentile } from './util.js';

/**
 * Animation overhead per applicant. It is identical for every desk, shown in the results, and can be
 * dropped to zero ("benchmark") so the race is decided by model latency alone.
 */
export const PACE = Object.freeze({
  cinematic: { id: 'cinematic', label: 'Cinematic', stepMs: 450, stampMs: 260 },
  standard: { id: 'standard', label: 'Standard', stepMs: 140, stampMs: 90 },
  benchmark: { id: 'benchmark', label: 'Benchmark', stepMs: 0, stampMs: 0 },
});

const MAX_CONSECUTIVE_FAILURES = 3;
const FATAL_STATUS = new Set([401, 403, 404]);
const FATAL_CODES = new Set(['not_configured', 'unknown_desk', 'unsupported']);
// Error Contract codes meaning the whole race's authority is gone, not just this one desk's call (KTD4, KTD6).
const PERMIT_REVOKED_CODES = new Set(['race_permit_required', 'race_permit_invalid', 'usage_control_unavailable']);

const isFatal = (result) => FATAL_STATUS.has(result?.status) || FATAL_CODES.has(result?.code);
const isPermitRevoked = (result) => PERMIT_REVOKED_CODES.has(result?.code);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const known = (value) => value !== null && value !== undefined;

/** A short, opaque, transport-safe id: one per deliberate Start (a run id) or per prepare/decide call (an operation id). */
function genId(prefix) {
  const random = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

/** What one call cost: the server's figure, or (from a server that predates it) its tokens at the desk's configured price. */
function callCost(record, desk) {
  if (Number.isFinite(record.cost?.usd)) return record.cost;
  if (!record.usage || !known(desk.priceIn) || !known(desk.priceOut)) return null;
  return { usd: costOfUsage(record.usage, { in: desk.priceIn, cachedIn: desk.priceCachedIn, out: desk.priceOut }), basis: desk.priceSource ?? 'price' };
}

class DeskRun {
  constructor(meta, papers) {
    this.meta = meta;
    this.total = papers.length;
    this.queue = [...papers];
    this.phase = meta.configured ? 'ready' : 'offline';
    this.phaseStart = 0;
    this.leaving = [];
    this.records = [];
    this.startedAt = null;
    this.finishedAt = null;
    this.rank = null;
    this.failures = 0;
    this.note = meta.configured ? '' : `Missing ${meta.missing.join(', ')}`;
  }

  get terminal() {
    return this.phase === 'finished' || this.phase === 'aborted' || this.phase === 'offline';
  }

  stats(now) {
    const ok = this.records.filter((r) => r.ok);
    const latencies = ok.map((r) => r.latencyMs);
    // Every reply that reported tokens counts, answered or not: a model that rambles itself out of budget still ran up the bill.
    const metered = this.records.filter((r) => r.usage);
    const tokensIn = sum(metered.map((r) => r.usage.inputTokens));
    const tokensOut = sum(metered.map((r) => r.usage.outputTokens));
    const tokensCached = sum(metered.map((r) => r.usage.cachedTokens ?? 0));
    const costs = this.records.map((record) => ({ ok: record.ok, cost: callCost(record, this.meta) }));
    const costed = costs.filter(({ cost }) => cost).map(({ cost }) => cost);
    const bases = new Set(costed.map((cost) => cost.basis));
    // A total is only honest when every answered call could be priced. A desk with a known price starts the race at $0.
    const complete = costs.every(({ ok: answered, cost }) => !answered || cost);
    const priced = known(this.meta.priceIn) && known(this.meta.priceOut);
    const end = this.finishedAt ?? now;
    const elapsedMs = this.startedAt === null ? 0 : Math.max(0, end - this.startedAt);
    const correct = this.records.filter((r) => r.correct).length;
    const falseApprovals = ok.filter((r) => r.decision === 'approve' && r.truth === 'reject').length;
    const falseRejections = ok.filter((r) => r.decision === 'reject' && r.truth === 'approve').length;
    return {
      done: this.records.length,
      total: this.total,
      approved: ok.filter((r) => r.decision === 'approve').length,
      denied: ok.filter((r) => r.decision === 'reject').length,
      // Calls that gave no usable answer (timeouts, API errors, unreadable replies). Wrong answers are counted in `wrong`.
      errors: this.records.length - ok.length,
      correct,
      accuracy: this.records.length ? correct / this.records.length : null,
      falseApprovals,
      falseRejections,
      wrong: falseApprovals + falseRejections,
      lastMs: latencies.length ? latencies[latencies.length - 1] : null,
      avgMs: latencies.length ? sum(latencies) / latencies.length : null,
      p95Ms: percentile(latencies, 95),
      modelMs: sum(latencies),
      tokensIn,
      tokensOut,
      tokensCached,
      // Answers that came back without a usage block: their tokens (and so their cost) are unknown, not zero.
      tokensMissing: ok.filter((r) => !r.usage).length,
      cost: complete && (costed.length > 0 || priced) ? sum(costed.map((cost) => cost.usd)) : null,
      costBasis: bases.size > 1 ? 'mixed' : ([...bases][0] ?? null),
      elapsedMs,
      perMinute: elapsedMs > 0 ? this.records.length / (elapsedMs / 60000) : null,
    };
  }
}

export class Race {
  /**
   * @param {object} options
   * @param {object[]} options.desks      public desk config from the server
   * @param {object[]} options.papers     the queue every desk works through (same order for fairness)
   * @param {Function} options.decide     ({deskId, paper, signal, permit, operationId}) => Promise<server result>
   * @param {Function} options.prepare    ({signal, permit, operationId}) => Promise<[{deskId, ok, error?}]>
   * @param {Function} [options.authorize] ({runId, queueSize, profiles, signal}) => Promise<{ok, permit, resetAt, expiresAt} | {ok: false, code, error, resetAt, retryAfterMs}>
   *   Omit entirely to preserve current behaviour (mock mode, or usage control disabled): the race then
   *   skips straight to warming, exactly as before this authorization step existed.
   */
  constructor({ desks, papers, decide, prepare, authorize = null, pace = 'standard', now = () => performance.now(), onEvent = () => {} }) {
    this.desks = desks;
    this.papers = papers;
    this.decideFn = decide;
    this.prepareFn = prepare;
    this.authorizeFn = authorize;
    this.pace = PACE[pace] ?? PACE.standard;
    this.now = now;
    this.onEvent = onEvent;
    this.token = null;
    this.status = 'ready';
    this.runs = [];
    this.reset();
  }

  emit(type, data = {}) {
    this.onEvent(type, data);
  }

  elapsed(now = this.now()) {
    if (this.startedAt === null) return 0;
    return (this.finishedAt ?? now) - this.startedAt;
  }

  reset() {
    if (this.token) {
      this.token.cancelled = true;
      this.token.controller.abort();
    }
    this.token = null;
    this.status = 'ready';
    this.startedAt = null;
    this.finishedAt = null;
    this.finishedCount = 0;
    // A permit is only ever good for the race that earned it (R3): reset/rebuild always drops it, never reuses it.
    this.runId = null;
    this.permit = null;
    this.permitRevoked = null;
    this.runs = this.desks.map((desk) => new DeskRun(desk, this.papers));
    this.emit('status');
  }

  setPhase(run, phase) {
    run.phase = phase;
    run.phaseStart = this.now();
    this.emit('phase', { run, phase });
  }

  wait(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  /** Requests race authority (if required), warms the connections, then starts every ready desk at the same instant. */
  async start() {
    if (this.status !== 'ready') return { started: false, reason: 'The race is already running. Reset it first.' };
    const token = { cancelled: false, controller: new AbortController() };
    this.token = token;
    // One run id per deliberate Start/Run again action (KTD11): every prepare/decide operation id below is derived from it.
    this.runId = genId('run');
    this.permit = null;
    this.permitRevoked = null;

    if (this.authorizeFn) {
      this.status = 'authorizing';
      this.emit('status');
      let auth;
      try {
        auth = await this.authorizeFn({
          runId: this.runId,
          queueSize: this.papers.length,
          profiles: this.desks.map((desk) => desk.profile),
          signal: token.controller.signal,
        });
      } catch {
        auth = { ok: false, code: 'usage_control_unavailable', error: 'Could not reach the game server to authorize this race.' };
      }
      // Reset/rebuild during authorization cancels this token; a late success (or failure) must never resurrect it.
      if (token.cancelled) return { started: false, cancelled: true };
      if (!auth?.ok) {
        // Leave the race ready so a transient refusal (storage, burst) can simply be retried (R12).
        this.status = 'ready';
        this.emit('status');
        return {
          started: false,
          authFailure: true,
          code: auth?.code ?? 'usage_control_unavailable',
          reason: auth?.error ?? 'Could not authorize this race.',
          resetAt: auth?.resetAt ?? null,
          retryAfterMs: auth?.retryAfterMs ?? null,
        };
      }
      this.permit = auth.permit ?? null;
    }

    this.status = 'warming';
    this.emit('status');

    let report;
    try {
      report = await this.prepareFn({ signal: token.controller.signal, permit: this.permit, operationId: `${this.runId}:prepare` });
    } catch (error) {
      report = this.runs.map((run) => ({ deskId: run.meta.id, ok: false, error: 'Cannot reach the game server.' }));
    }
    if (token.cancelled) return { started: false, cancelled: true };

    for (const run of this.runs) {
      const entry = report.find((item) => item.deskId === run.meta.id);
      if (run.phase === 'ready' && entry && !entry.ok) {
        run.note = entry.error ?? 'Connection failed';
        this.setPhase(run, 'offline');
      }
    }
    const active = this.runs.filter((run) => run.phase === 'ready');
    if (active.length === 0) {
      const reason = this.runs.map((run) => `${run.meta.label}: ${run.note || 'not ready'}`).join(' | ');
      this.reset();
      return { started: false, reason: `No desk is ready. ${reason}` };
    }

    this.startedAt = this.now();
    this.status = 'running';
    this.emit('status');
    await Promise.all(active.map((run) => this.runDesk(run, token)));
    if (token.cancelled) return { started: true, cancelled: true };
    this.finishedAt = this.now();
    this.status = 'finished';
    this.emit('status');
    this.emit('done');
    // Completed records stay on the runs (preserved) even when a mid-race permit failure cut the race short.
    return { started: true, ...(this.permitRevoked ? { permitRevoked: this.permitRevoked } : {}) };
  }

  record(paper, result) {
    const ok = Boolean(result?.ok);
    const decision = ok ? result.decision : null;
    return {
      paperId: paper.id,
      ok,
      decision,
      truth: paper.truth,
      correct: ok && decision === paper.truth,
      latencyMs: result?.latencyMs ?? 0,
      attempts: result?.attempts ?? 1,
      // Tokens and cost of the reply, also when it was unusable: those tokens were spent.
      usage: result?.usage ?? null,
      cost: result?.cost ?? null,
      model: result?.model ?? null,
      detail: ok ? result.detail : null,
      error: ok ? null : (result?.error ?? 'Unknown error'),
      code: ok ? null : (result?.code ?? null),
      finishedAt: this.now(),
    };
  }

  async runDesk(run, token) {
    run.startedAt = this.startedAt;
    while (!token.cancelled && !this.permitRevoked && run.queue.length > 0) {
      const paper = run.queue[0];
      this.setPhase(run, 'stepping');
      await this.wait(this.pace.stepMs);
      if (token.cancelled) return;
      if (this.permitRevoked) return this.abortRun(run, this.permitRevoked.message);

      this.setPhase(run, 'reviewing');
      const operationId = `${this.runId}:${run.meta.id}:${paper.id}`;
      const result = await this.decideFn({ deskId: run.meta.id, paper, signal: token.controller.signal, permit: this.permit, operationId });
      if (token.cancelled) return;
      // Another desk's call (or this one) just found the permit dead: stop every desk, not only this one (R3).
      if (this.permitRevoked) return this.abortRun(run, this.permitRevoked.message);
      if (!result?.ok && isPermitRevoked(result)) {
        this.permit = null;
        this.permitRevoked = { code: result.code, message: result.error ?? 'Race authorization was revoked; start a new race.' };
        token.controller.abort();
        this.emit('auth-revoked', this.permitRevoked);
        return this.abortRun(run, this.permitRevoked.message);
      }
      if (!result?.ok && isFatal(result)) return this.abortRun(run, result?.error ?? 'Desk cannot work');

      const record = this.record(paper, result);
      run.records.push(record);
      this.setPhase(run, 'stamping');
      this.emit('decision', { run, paper, record });
      await this.wait(this.pace.stampMs);
      if (token.cancelled) return;
      if (this.permitRevoked) return this.abortRun(run, this.permitRevoked.message);

      run.queue.shift();
      run.leaving.push({ paper, record, at: this.now() });
      this.emit('exit', { run, paper, record });

      run.failures = record.ok ? 0 : run.failures + 1;
      if (run.failures >= MAX_CONSECUTIVE_FAILURES) return this.abortRun(run, `${MAX_CONSECUTIVE_FAILURES} failures in a row: ${record.error}`);
    }
    if (this.permitRevoked) return this.abortRun(run, this.permitRevoked.message);
    this.finishRun(run);
  }


  finishRun(run) {
    if (!run.records.some((record) => record.ok)) return this.abortRun(run, 'Every request failed');
    run.finishedAt = this.now();
    run.rank = ++this.finishedCount;
    this.setPhase(run, 'finished');
    this.emit('desk-finished', { run, rank: run.rank, elapsedMs: run.finishedAt - run.startedAt });
  }

  abortRun(run, reason) {
    run.note = reason;
    run.finishedAt = this.now();
    this.setPhase(run, 'aborted');
    this.emit('desk-aborted', { run, reason });
  }

  summary() {
    const now = this.now();
    const rows = this.runs.map((run) => ({ run, desk: run.meta, rank: run.rank, outcome: run.phase, note: run.note, ...run.stats(now) }));
    const ranked = rows.filter((row) => row.rank).sort((a, b) => a.rank - b.rank);
    if (ranked.length > 0) {
      const slowestWall = Math.max(...ranked.map((row) => row.elapsedMs));
      const slowestModel = Math.max(...ranked.map((row) => row.modelMs));
      for (const row of ranked) {
        row.speedup = row.elapsedMs > 0 ? slowestWall / row.elapsedMs : null;
        row.modelSpeedup = row.modelMs > 0 ? slowestModel / row.modelMs : null;
      }
    }
    return { rows, ranked, queueSize: this.papers.length, elapsedMs: this.elapsed(now), pace: this.pace, overheadMs: this.pace.stepMs + this.pace.stampMs };
  }
}
