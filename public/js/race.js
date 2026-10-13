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

const isFatal = (result) => FATAL_STATUS.has(result?.status) || FATAL_CODES.has(result?.code);
const sum = (values) => values.reduce((total, value) => total + value, 0);

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
    const tokensIn = sum(ok.map((r) => r.usage?.inputTokens ?? 0));
    const tokensOut = sum(ok.map((r) => r.usage?.outputTokens ?? 0));
    const { priceIn, priceOut } = this.meta;
    const priced = priceIn !== null && priceIn !== undefined && priceOut !== null && priceOut !== undefined;
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
      cost: priced ? (tokensIn / 1e6) * priceIn + (tokensOut / 1e6) * priceOut : null,
      elapsedMs,
      perMinute: elapsedMs > 0 ? this.records.length / (elapsedMs / 60000) : null,
    };
  }
}

export class Race {
  /**
   * @param {object} options
   * @param {object[]} options.desks   public desk config from the server
   * @param {object[]} options.papers  the queue every desk works through (same order for fairness)
   * @param {Function} options.decide  ({deskId, paper, signal}) => Promise<server result>
   * @param {Function} options.prepare ({signal}) => Promise<[{deskId, ok, error?}]>
   */
  constructor({ desks, papers, decide, prepare, pace = 'standard', now = () => performance.now(), onEvent = () => {} }) {
    this.desks = desks;
    this.papers = papers;
    this.decideFn = decide;
    this.prepareFn = prepare;
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

  /** Warms the connections, then starts every ready desk at the same instant. */
  async start() {
    if (this.status !== 'ready') return { started: false, reason: 'The race is already running. Reset it first.' };
    const token = { cancelled: false, controller: new AbortController() };
    this.token = token;
    this.status = 'warming';
    this.emit('status');

    let report;
    try {
      report = await this.prepareFn({ signal: token.controller.signal });
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
    return { started: true };
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
      usage: ok ? result.usage : null,
      model: result?.model ?? null,
      detail: ok ? result.detail : null,
      error: ok ? null : (result?.error ?? 'Unknown error'),
      code: ok ? null : (result?.code ?? null),
      finishedAt: this.now(),
    };
  }

  async runDesk(run, token) {
    run.startedAt = this.startedAt;
    while (!token.cancelled && run.queue.length > 0) {
      const paper = run.queue[0];
      this.setPhase(run, 'stepping');
      await this.wait(this.pace.stepMs);
      if (token.cancelled) return;

      this.setPhase(run, 'reviewing');
      const result = await this.decideFn({ deskId: run.meta.id, paper, signal: token.controller.signal });
      if (token.cancelled) return;
      if (!result?.ok && isFatal(result)) return this.abortRun(run, result?.error ?? 'Desk cannot work');

      const record = this.record(paper, result);
      run.records.push(record);
      this.setPhase(run, 'stamping');
      this.emit('decision', { run, paper, record });
      await this.wait(this.pace.stampMs);
      if (token.cancelled) return;

      run.queue.shift();
      run.leaving.push({ paper, record, at: this.now() });
      this.emit('exit', { run, paper, record });

      run.failures = record.ok ? 0 : run.failures + 1;
      if (run.failures >= MAX_CONSECUTIVE_FAILURES) return this.abortRun(run, `${MAX_CONSECUTIVE_FAILURES} failures in a row: ${record.error}`);
    }
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
