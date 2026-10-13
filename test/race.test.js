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
  return async ({ deskId, paper, signal }) => {
    calls.push({ deskId, paperId: paper.id, signal });
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
  assert.equal(stats.errors, 0);
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
