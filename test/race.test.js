import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACE, Race } from '../public/js/race.js';
import { generatePapers } from '../shared/rulebook.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeDesks = (overrides = {}) =>
  [1, 2, 3].map((id) => ({
    id,
    label: `Desk ${id}`,
    configured: true,
    missing: [],
    priceIn: id === 1 ? 0.042 : 1,
    priceOut: id === 1 ? 0 : 4,
    ...(overrides[id] ?? {}),
  }));

const readyPrepare = async () => [1, 2, 3].map((deskId) => ({ deskId, ok: true }));

/** A fake model: fixed latency per desk, correct unless told otherwise. */
function fakeDecide({ latency, wrong = [], fail = () => null, calls = [] }) {
  return async ({ deskId, paper, signal, permit, operationId }) => {
    calls.push({ deskId, paperId: paper.id, signal, permit, operationId });
    await sleep(latency[deskId]);
    const failure = fail(deskId, paper);
    if (failure) return { ok: false, deskId, paperId: paper.id, latencyMs: latency[deskId], attempts: 1, ...failure };
    const flipped = wrong.includes(`${deskId}:${paper.id}`);
    const decision = flipped ? (paper.truth === 'approve' ? 'reject' : 'approve') : paper.truth;
    return { ok: true, deskId, paperId: paper.id, decision, latencyMs: latency[deskId], attempts: 1, usage: { inputTokens: 100, outputTokens: 5 }, model: 'm', detail: {} };
  };
}

const makeRace = (options = {}) =>
  new Race({
    desks: options.desks ?? makeDesks(),
    papers: options.papers ?? generatePapers(1, 8),
    decide: options.decide ?? fakeDecide({ latency: { 1: 5, 2: 25, 3: 60 } }),
    prepare: options.prepare ?? readyPrepare,
    authorize: options.authorize,
    pace: options.pace ?? 'benchmark',
    onEvent: options.onEvent,
  });

test('the faster model clears its queue first and ranks are assigned in finishing order', async () => {
  const race = makeRace();
  const result = await race.start();
  assert.equal(result.started, true);
  assert.equal(race.status, 'finished');
  assert.deepEqual(race.runs.map((run) => run.rank), [1, 2, 3]);
  assert.ok(race.runs.every((run) => run.phase === 'finished' && run.queue.length === 0 && run.records.length === 8));
  const times = race.runs.map((run) => run.finishedAt - run.startedAt);
  assert.ok(times[0] < times[1] && times[1] < times[2], times.join(' < '));

  const summary = race.summary();
  assert.equal(summary.ranked[0].desk.id, 1);
  // Wall-clock ratio: sleeps of a few ms are rounded up to the timer tick (about 15 ms on Windows), which compresses it.
  assert.ok(summary.ranked[0].speedup > 2, `speedup ${summary.ranked[0].speedup}`);
  assert.ok(Math.abs(summary.ranked[2].speedup - 1) < 1e-9);
  assert.ok(summary.ranked[0].modelSpeedup > 8);
});

test('every desk works through the same papers in the same order', async () => {
  const calls = [];
  const race = makeRace({ decide: fakeDecide({ latency: { 1: 1, 2: 2, 3: 3 }, calls }) });
  await race.start();
  const order = (id) => calls.filter((call) => call.deskId === id).map((call) => call.paperId);
  assert.deepEqual(order(1), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(order(2), order(1));
  assert.deepEqual(order(3), order(1));
});

test('stats: accuracy, error direction, latency percentiles, tokens and cost', async () => {
  const papers = generatePapers(3, 8);
  const wrongIds = [papers.find((p) => p.truth === 'approve').id, papers.find((p) => p.truth === 'reject').id];
  const race = makeRace({
    papers,
    decide: fakeDecide({ latency: { 1: 3, 2: 3, 3: 3 }, wrong: wrongIds.map((id) => `1:${id}`) }),
  });
  await race.start();
  const stats = race.runs[0].stats(race.now());
  assert.equal(stats.done, 8);
  assert.equal(stats.correct, 6);
  assert.equal(stats.accuracy, 0.75);
  assert.equal(stats.falseApprovals, 1);
  assert.equal(stats.falseRejections, 1);
  assert.equal(stats.wrong, 2, 'wrong counts the answers that did not match the truth, in both directions');
  assert.equal(stats.errors, 0, 'wrong answers are not failed calls');
  assert.equal(stats.tokensIn, 800);
  assert.equal(stats.tokensOut, 40);
  assert.ok(Math.abs(stats.cost - (800 / 1e6) * 0.042) < 1e-12);
  assert.ok(stats.avgMs === 3 && stats.p95Ms === 3 && stats.lastMs === 3);
  assert.equal(stats.approved + stats.denied, 8);
  assert.ok(Math.abs(race.runs[1].stats(race.now()).cost - ((800 / 1e6) * 1 + (40 / 1e6) * 4)) < 1e-12);
});

test('cost is unavailable when prices are not configured', async () => {
  const race = makeRace({ desks: makeDesks({ 2: { priceIn: null, priceOut: null } }) });
  await race.start();
  assert.equal(race.runs[1].stats(race.now()).cost, null);
  assert.notEqual(race.runs[0].stats(race.now()).cost, null);
});

// ---- Tokens and cost, from what the server reports per call -----------------------------------------

/** Stats of a desk that has already decided `records` (only the fields the statistics read). */
function statsOf(records, desk = {}) {
  const race = makeRace({ desks: makeDesks({ 1: desk }) });
  race.runs[0].records.push(...records.map((record) => ({ ok: true, latencyMs: 1, decision: 'approve', truth: 'approve', correct: true, usage: null, cost: null, ...record })));
  return race.runs[0].stats(race.now());
}

const call = (inputTokens, outputTokens, usd, basis = 'list', cachedTokens = 0) => ({ usage: { inputTokens, outputTokens, cachedTokens }, cost: usd === null ? null : { usd, basis } });

test('cost is the sum of the per-call costs the server worked out, and says where they come from', () => {
  const stats = statsOf([call(210, 279, 0.001), call(210, 250, 0.002), call(210, 300, 0.003)], { priceIn: null, priceOut: null });
  assert.ok(Math.abs(stats.cost - 0.006) < 1e-12, 'a desk with no configured price is still costed from the server\'s figures');
  assert.equal(stats.costBasis, 'list');
  assert.equal(statsOf([call(1, 1, 0.5, 'reported'), call(1, 1, 0.25, 'reported')]).costBasis, 'reported');
  assert.equal(statsOf([call(1, 1, 0.5, 'reported'), call(1, 1, 0.25, 'list')]).costBasis, 'mixed');
});

test('tokens count every reply that reported usage, also the unusable ones that still spent them', () => {
  const stats = statsOf([
    call(100, 5, 0.001, 'list', 40),
    { ok: false, decision: null, correct: false, error: 'empty reply (finish_reason=length)', ...call(210, 4096, 0.025, 'list', 182) },
    { ok: false, decision: null, correct: false, error: 'HTTP 500', usage: null, cost: null },
  ]);
  assert.deepEqual([stats.tokensIn, stats.tokensOut, stats.tokensCached], [310, 4101, 222]);
  assert.equal(stats.errors, 2);
  assert.ok(Math.abs(stats.cost - 0.026) < 1e-12, 'the wasted reply is part of the bill; the call that never got an answer is not');
  assert.equal(stats.tokensMissing, 0);
});

test('an answer that came without a usage block leaves tokens and cost unknown instead of zero', () => {
  const stats = statsOf([call(100, 5, 0.001), { usage: null, cost: null }]);
  assert.equal(stats.tokensMissing, 1);
  assert.equal(stats.cost, null);
  assert.equal(stats.costBasis, 'list');
  assert.deepEqual([stats.tokensIn, stats.tokensOut], [100, 5]);
});

test('an older server sends no cost: tokens are priced at the desk\'s configured price, cached input included', () => {
  const desk = { priceIn: 2, priceCachedIn: 0.5, priceOut: 6, priceSource: 'list' };
  const stats = statsOf([{ usage: { inputTokens: 210, outputTokens: 279, cachedTokens: 182 } }, { usage: { inputTokens: 100, outputTokens: 5 } }], desk);
  assert.ok(Math.abs(stats.cost - ((28 * 2 + 182 * 0.5 + 279 * 6) + (100 * 2 + 5 * 6)) / 1e6) < 1e-12);
  assert.equal(stats.costBasis, 'list');
  assert.equal(statsOf([{ usage: { inputTokens: 1, outputTokens: 1 } }], { priceIn: 1, priceOut: 1 }).costBasis, 'price', 'a server that does not say where the price comes from');
});

test('before the first reply a priced desk shows $0 and an unpriced one shows n/a', () => {
  assert.equal(statsOf([]).cost, 0);
  assert.equal(statsOf([], { priceIn: null, priceOut: null }).cost, null);
  assert.equal(statsOf([]).costBasis, null);
});

test('a desk that fails its connection check sits out while the others race', async () => {
  const race = makeRace({
    prepare: async () => [
      { deskId: 1, ok: true },
      { deskId: 2, ok: true },
      { deskId: 3, ok: false, error: 'HTTP 401: invalid key' },
    ],
  });
  await race.start();
  assert.equal(race.runs[2].phase, 'offline');
  assert.match(race.runs[2].note, /invalid key/);
  assert.equal(race.runs[2].records.length, 0);
  assert.deepEqual(race.runs.map((run) => run.rank), [1, 2, null]);
});

test('an unconfigured desk is offline from the start and names what is missing', async () => {
  const race = makeRace({ desks: makeDesks({ 2: { configured: false, missing: ['FOUNDRY_API_KEY', 'DESK2_MODEL'] } }) });
  assert.equal(race.runs[1].phase, 'offline');
  assert.match(race.runs[1].note, /FOUNDRY_API_KEY, DESK2_MODEL/);
  await race.start();
  assert.deepEqual(race.runs.map((run) => run.rank), [1, null, 2]);
});

test('a fatal error (bad key) aborts only that desk and never produces a ranking for it', async () => {
  const race = makeRace({
    decide: fakeDecide({ latency: { 1: 2, 2: 2, 3: 8 }, fail: (deskId) => (deskId === 2 ? { status: 401, code: 'http', error: 'HTTP 401: bad key' } : null) }),
  });
  await race.start();
  const broken = race.runs[1];
  assert.equal(broken.phase, 'aborted');
  assert.match(broken.note, /bad key/);
  assert.equal(broken.rank, null);
  assert.equal(broken.records.length, 0);
  assert.deepEqual([race.runs[0].rank, race.runs[2].rank], [1, 2]);
});

test('three failures in a row abort a desk, a success in between resets the count', async () => {
  const failing = new Set([1, 2, 4, 5, 6]);
  const race = makeRace({
    papers: generatePapers(5, 10),
    decide: fakeDecide({ latency: { 1: 1, 2: 1, 3: 1 }, fail: (deskId, paper) => (deskId === 3 && failing.has(paper.id) ? { status: 500, code: 'http', error: 'HTTP 500: boom' } : null) }),
  });
  await race.start();
  const flaky = race.runs[2];
  assert.equal(flaky.phase, 'aborted');
  assert.equal(flaky.records.length, 6);
  assert.equal(flaky.rank, null);
  assert.match(flaky.note, /3 failures in a row/);
  assert.equal(flaky.stats(race.now()).errors, 5);
  assert.equal(flaky.stats(race.now()).wrong, 0, 'failed calls are not wrong answers');
  assert.ok(flaky.stats(race.now()).accuracy < 1, 'but they still count against accuracy');
  assert.equal(race.runs[0].rank, 1);
});

test('a desk whose every request failed is never ranked, even if its queue emptied', async () => {
  const race = makeRace({
    papers: generatePapers(5, 2),
    decide: fakeDecide({ latency: { 1: 1, 2: 1, 3: 1 }, fail: (deskId) => (deskId === 2 ? { status: 500, code: 'http', error: 'HTTP 500' } : null) }),
  });
  await race.start();
  assert.equal(race.runs[1].phase, 'aborted');
  assert.equal(race.runs[1].rank, null);
  assert.deepEqual([race.runs[0].rank, race.runs[2].rank], [1, 2]);
});

test('when no desk is ready the race refuses to start and can be retried', async () => {
  const race = makeRace({ prepare: async () => [1, 2, 3].map((deskId) => ({ deskId, ok: false, error: 'nope' })) });
  const result = await race.start();
  assert.equal(result.started, false);
  assert.match(result.reason, /No desk is ready/);
  assert.equal(race.status, 'ready');
  assert.ok(race.runs.every((run) => run.phase === 'ready' && run.queue.length === 8));
});

test('an unreachable game server marks every desk offline instead of hanging', async () => {
  const race = makeRace({ prepare: async () => { throw new Error('ECONNREFUSED'); } });
  const result = await race.start();
  assert.equal(result.started, false);
  assert.match(result.reason, /Cannot reach the game server/);
});

test('reset mid-race cancels in-flight work and returns to a clean state', async () => {
  const calls = [];
  const race = makeRace({ decide: fakeDecide({ latency: { 1: 200, 2: 200, 3: 200 }, calls }) });
  const running = race.start();
  await sleep(40);
  assert.equal(race.status, 'running');
  race.reset();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(race.status, 'ready');
  assert.ok(calls.every((call) => call.signal.aborted), 'in-flight requests must be aborted');
  const seen = calls.length;
  await sleep(300);
  assert.equal(calls.length, seen, 'no new requests after reset');
  assert.ok(race.runs.every((run) => run.records.length === 0 && run.queue.length === 8));
});

test('events arrive in order: phases, decision with record, exit, finish', async () => {
  const events = [];
  const race = makeRace({
    desks: makeDesks().slice(0, 1),
    papers: generatePapers(2, 2),
    prepare: async () => [{ deskId: 1, ok: true }],
    onEvent: (type, data) => events.push(type === 'phase' ? `phase:${data.phase}` : type),
  });
  await race.start();
  const filtered = events.filter((event) => event !== 'status');
  assert.deepEqual(filtered, [
    'phase:stepping', 'phase:reviewing', 'phase:stamping', 'decision', 'exit',
    'phase:stepping', 'phase:reviewing', 'phase:stamping', 'decision', 'exit',
    'phase:finished', 'desk-finished', 'done',
  ]);
});

test('pace presets: identical overhead for every desk, none in benchmark mode', () => {
  assert.equal(PACE.benchmark.stepMs + PACE.benchmark.stampMs, 0);
  assert.equal(PACE.standard.stepMs + PACE.standard.stampMs, 230);
  assert.ok(PACE.cinematic.stepMs > PACE.standard.stepMs);
});

test('resetting during the connection warm-up cancels quietly without an error reason', async () => {
  let aborted = false;
  const race = makeRace({
    prepare: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
  });
  const pending = race.start();
  await sleep(20);
  assert.equal(race.status, 'warming');
  race.reset();
  const result = await pending;
  assert.equal(aborted, true);
  assert.deepEqual(result, { started: false, cancelled: true });
  assert.equal(race.status, 'ready');
});

test('a second start while running is refused', async () => {
  const race = makeRace({ decide: fakeDecide({ latency: { 1: 30, 2: 30, 3: 30 } }) });
  const first = race.start();
  const second = await race.start();
  assert.equal(second.started, false);
  await first;
});

// ---- U4: Race authorization (one permit per Start, carried through prepare/decide) --------------

function fakeAuthorize({ calls = [], result } = {}) {
  return (args) => {
    calls.push(args);
    return typeof result === 'function' ? result(args) : result;
  };
}

test('authorization runs before preparation, and every prepare/decide call carries the same active permit', async () => {
  const authorizeCalls = [];
  const prepareCalls = [];
  const decideCalls = [];
  const race = makeRace({
    authorize: fakeAuthorize({ calls: authorizeCalls, result: ({ runId }) => ({ ok: true, permit: `permit-${runId}`, resetAt: 'r', expiresAt: 'e' }) }),
    prepare: async (args) => {
      prepareCalls.push(args);
      return readyPrepare();
    },
    decide: fakeDecide({ latency: { 1: 1, 2: 1, 3: 1 }, calls: decideCalls }),
  });
  const result = await race.start();
  assert.equal(result.started, true);
  assert.equal(race.status, 'finished', 'covers AE1: a successful authorization lets the race reach warming/running/finished');

  assert.equal(authorizeCalls.length, 1, 'exactly one authorization per Start');
  const { runId } = authorizeCalls[0];
  assert.equal(typeof runId, 'string');
  assert.equal(authorizeCalls[0].queueSize, race.papers.length);
  assert.deepEqual(authorizeCalls[0].profiles, race.desks.map((desk) => desk.profile));

  const permit = `permit-${runId}`;
  assert.equal(race.permit, permit);
  assert.equal(prepareCalls.length, 1);
  assert.equal(prepareCalls[0].permit, permit);
  assert.ok(prepareCalls[0].operationId.startsWith(`${runId}:`), 'preparation gets a stable operation id derived from the run id');

  assert.ok(decideCalls.length > 0);
  assert.ok(decideCalls.every((call) => call.permit === permit), 'every decision carries the same active permit');
  assert.ok(decideCalls.every((call) => call.operationId.startsWith(`${runId}:`)));
  const ids = decideCalls.map((call) => call.operationId);
  assert.equal(new Set(ids).size, ids.length, 'every desk/paper decision gets its own stable operation id');
});

test('covers AE2: a visitor-limit refusal leaves the race ready, calls no preparation or decision, and exposes the reset message', async () => {
  let prepareCalled = false;
  let decideCalled = false;
  const race = makeRace({
    authorize: async () => ({ ok: false, code: 'visitor_daily_limit', error: 'This browser has started the maximum number of races today.', resetAt: '2026-10-15T00:00:00.000Z' }),
    prepare: async () => {
      prepareCalled = true;
      return readyPrepare();
    },
    decide: async () => {
      decideCalled = true;
      return { ok: true };
    },
  });
  const result = await race.start();
  assert.equal(result.started, false);
  assert.equal(result.authFailure, true);
  assert.equal(result.code, 'visitor_daily_limit');
  assert.equal(result.resetAt, '2026-10-15T00:00:00.000Z');
  assert.equal(race.status, 'ready');
  assert.equal(race.permit, null);
  assert.equal(prepareCalled, false);
  assert.equal(decideCalled, false);
});

test('a global-limit refusal is a distinct code from a visitor-limit refusal, and leaves the race ready', async () => {
  const race = makeRace({ authorize: async () => ({ ok: false, code: 'global_daily_limit', error: "The deployment's global daily race limit has been reached." }) });
  const result = await race.start();
  assert.equal(result.code, 'global_daily_limit');
  assert.notEqual(result.code, 'visitor_daily_limit');
  assert.equal(race.status, 'ready');
});

test('a 503 authorization failure leaves the race ready with a retryable service message', async () => {
  const race = makeRace({ authorize: async () => ({ ok: false, code: 'usage_control_unavailable', error: 'Usage control is enabled but not available.' }) });
  const result = await race.start();
  assert.equal(result.code, 'usage_control_unavailable');
  assert.equal(race.status, 'ready');
  assert.match(result.reason, /not available/);
});

test('an authorize call that throws is reported as a retryable service failure, not a quota refusal', async () => {
  const race = makeRace({ authorize: async () => { throw new Error('ECONNRESET'); } });
  const result = await race.start();
  assert.equal(result.code, 'usage_control_unavailable');
  assert.equal(race.status, 'ready');
});

test('a burst-limit refusal remains ready and exposes the Retry-After wait so the UI can render it accessibly', async () => {
  const race = makeRace({
    authorize: async () => ({ ok: false, code: 'start_rate_limit', error: 'Too many race starts from this address; try again shortly.', retryAfterMs: 60_000 }),
  });
  const result = await race.start();
  assert.equal(result.code, 'start_rate_limit');
  assert.equal(result.retryAfterMs, 60_000);
  assert.equal(race.status, 'ready');
});

test('reset mid-race clears the in-memory permit; the next Start requests a brand new one', async () => {
  const authorizeCalls = [];
  let issued = 0;
  const race = makeRace({
    authorize: fakeAuthorize({ calls: authorizeCalls, result: () => ({ ok: true, permit: `permit-${++issued}`, resetAt: 'r', expiresAt: 'e' }) }),
    decide: fakeDecide({ latency: { 1: 200, 2: 200, 3: 200 } }),
  });

  const first = race.start();
  await sleep(40);
  assert.equal(race.status, 'running');
  assert.equal(race.permit, 'permit-1');
  race.reset();
  await first;
  assert.equal(race.permit, null, 'reset clears the permit immediately, so a late in-flight response cannot spend it');

  const second = race.start();
  await sleep(40);
  assert.equal(race.permit, 'permit-2');
  race.reset();
  await second;
  assert.equal(authorizeCalls.length, 2);
});

test('each Start/Run again action requests a fresh run id, even for an unchanged race object (KTD11)', async () => {
  const authorizeCalls = [];
  let issued = 0;
  const race = makeRace({ authorize: fakeAuthorize({ calls: authorizeCalls, result: () => ({ ok: true, permit: `permit-${++issued}`, resetAt: 'r', expiresAt: 'e' }) }) });
  await race.start();
  race.reset();
  await race.start();
  assert.equal(authorizeCalls.length, 2);
  assert.notEqual(authorizeCalls[0].runId, authorizeCalls[1].runId);
});

test('double activation while authorizing sends exactly one start request, and reset ignores a late authorization success', async () => {
  const authorizeCalls = [];
  let resolveAuth;
  const race = makeRace({
    authorize: (args) => {
      authorizeCalls.push(args);
      return new Promise((resolve) => {
        resolveAuth = resolve;
      });
    },
  });
  const first = race.start();
  await sleep(5);
  assert.equal(race.status, 'authorizing');
  const second = await race.start();
  assert.equal(second.started, false);
  assert.match(second.reason, /already running/);
  assert.equal(authorizeCalls.length, 1, 'only the deliberate Start requested authorization');

  race.reset();
  resolveAuth({ ok: true, permit: 'late-permit', resetAt: 'r', expiresAt: 'e' });
  const result = await first;
  assert.deepEqual(result, { started: false, cancelled: true });
  assert.equal(race.status, 'ready');
  assert.equal(race.permit, null, 'a late authorization success must never be adopted after a reset');
});

test('a mid-race permit failure stops every desk, clears authority, and preserves completed records', async () => {
  const desks = makeDesks();
  let calls = 0;
  const decide = async ({ deskId, paper }) => {
    calls += 1;
    const callNumber = calls;
    await sleep(5);
    if (callNumber > desks.length) return { ok: false, code: 'race_permit_invalid', error: 'This permit has used its maximum number of decisions.' };
    return { ok: true, deskId, paperId: paper.id, decision: paper.truth, latencyMs: 5, attempts: 1, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', detail: {} };
  };
  const race = makeRace({
    desks,
    papers: generatePapers(1, 8),
    authorize: async () => ({ ok: true, permit: 'permit-1', resetAt: 'r', expiresAt: 'e' }),
    decide,
  });

  const result = await race.start();
  assert.equal(result.started, true);
  assert.deepEqual(result.permitRevoked, { code: 'race_permit_invalid', message: 'This permit has used its maximum number of decisions.' });
  assert.equal(race.permit, null, 'authority is cleared once the permit is found dead');
  assert.equal(race.status, 'finished');
  assert.ok(race.runs.every((run) => run.records.length === 1 && run.records[0].ok), 'the one decision answered before the failure is preserved, not discarded');
  assert.ok(race.runs.every((run) => run.queue.length === 7), 'unattempted papers remain queued instead of being wiped');
  assert.ok(race.runs.every((run) => run.phase === 'aborted'), 'every desk stops, not just the one that discovered the dead permit');
  assert.notEqual(race.status, 'ready', 'a fresh, newly-authorized Start is required to continue; the stale permit cannot be resumed');
});
