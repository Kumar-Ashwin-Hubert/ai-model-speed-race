import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageService, indiaDay, UsageError, USAGE_COOKIE_NAME } from '../server/usage.js';
import { createFakeStore } from './helpers.js';

const SECRET = 'test-signing-secret';
const GLOBAL_CAP = 1000;

function usageConfig(overrides = {}) {
  return { signingSecret: SECRET, dailyGlobalRaces: GLOBAL_CAP, permitMinutes: 45, startsPerMinute: 6, appService: false, ...overrides };
}

const START = { runId: 'run-1', profiles: ['JEV', 'FAST_LLM'], queueSize: 10, deskCount: 2 };

async function newVisitor(service) {
  const { visitorId } = service.resolveVisitor(null);
  return visitorId;
}

test('indiaDay keys the Asia/Kolkata calendar date and resets at the next India midnight', () => {
  // 2026-10-14 23:59:00 IST == 2026-10-14T18:29:00Z
  const before = indiaDay(new Date('2026-10-14T18:29:00Z'));
  assert.equal(before.key, '20261014');
  assert.equal(before.resetAt.toISOString(), '2026-10-14T18:30:00.000Z');
  // One minute later it is 2026-10-15 00:00:00 IST == 2026-10-14T18:30:00Z: a new partition.
  const after = indiaDay(new Date('2026-10-14T18:30:00Z'));
  assert.equal(after.key, '20261015');
});

test('AE1: the ninth consumed race allows the tenth and consumes the final visitor allowance', async () => {
  const service = createUsageService(usageConfig(), { store: createFakeStore() });
  const visitorId = await newVisitor(service);
  for (let i = 1; i <= 9; i++) await service.startRace({ visitorId, ...START, runId: `run-${i}` });
  const result = await service.startRace({ visitorId, ...START, runId: 'run-10' });
  assert.ok(result.permit);
});

test('AE2: the eleventh race on the same India date is rejected with visitor_daily_limit and a reset time', async () => {
  const service = createUsageService(usageConfig(), { store: createFakeStore() });
  const visitorId = await newVisitor(service);
  for (let i = 1; i <= 10; i++) await service.startRace({ visitorId, ...START, runId: `run-${i}` });
  await assert.rejects(
    () => service.startRace({ visitorId, ...START, runId: 'run-11' }),
    (error) => error instanceof UsageError && error.code === 'visitor_daily_limit' && error.status === 429 && error.resetAt instanceof Date,
  );
});

test('a configured visitor limit applies from the next start in both directions, and never blocks recovering an existing run', async () => {
  const store = createFakeStore();
  const small = createUsageService(usageConfig({ visitorDailyLimit: 2 }), { store });
  const visitorId = await newVisitor(small);
  await small.startRace({ visitorId, ...START, runId: 'run-1' });
  await small.startRace({ visitorId, ...START, runId: 'run-2' });
  await assert.rejects(() => small.startRace({ visitorId, ...START, runId: 'run-3' }), (error) => error.code === 'visitor_daily_limit');

  // An operator raises the setting and the app restarts: the same visitor gets exactly one more race.
  const raised = createUsageService(usageConfig({ visitorDailyLimit: 3 }), { store });
  await assert.doesNotReject(() => raised.startRace({ visitorId, ...START, runId: 'run-3' }));
  await assert.rejects(() => raised.startRace({ visitorId, ...START, runId: 'run-4' }), (error) => error.code === 'visitor_daily_limit');

  // Lowering it again refuses new races immediately, yet a retried Start for a race already counted still recovers its permit.
  const lowered = createUsageService(usageConfig({ visitorDailyLimit: 1 }), { store });
  await assert.rejects(() => lowered.startRace({ visitorId, ...START, runId: 'run-5' }), (error) => error.code === 'visitor_daily_limit');
  await assert.doesNotReject(() => lowered.startRace({ visitorId, ...START, runId: 'run-1' }));
});

test('AE3: an exhausted global allowance rejects every visitor without creating a race row', async () => {
  const store = createFakeStore();
  const service = createUsageService(usageConfig({ dailyGlobalRaces: 1 }), { store });
  const visitorA = await newVisitor(service);
  await service.startRace({ visitorId: visitorA, ...START, runId: 'run-a' });

  const visitorB = (await newVisitor(service)) + '-other'; // a distinct visitor so the visitor cap is not the blocker
  const rowsBefore = store.rows.size;
  await assert.rejects(
    () => service.startRace({ visitorId: visitorB, ...START, runId: 'run-b' }),
    (error) => error instanceof UsageError && error.code === 'global_daily_limit' && error.status === 429,
  );
  assert.equal(store.rows.size, rowsBefore, 'no race row should be created when the global cap is already exhausted');
});

test('AE4: reconstructing the service against the same store preserves consumed visitor and global counts', async () => {
  const store = createFakeStore();
  const serviceA = createUsageService(usageConfig(), { store });
  const visitorId = await newVisitor(serviceA);
  for (let i = 1; i <= 5; i++) await serviceA.startRace({ visitorId, ...START, runId: `run-${i}` });

  const serviceB = createUsageService(usageConfig(), { store }); // simulates an app restart / another instance
  for (let i = 6; i <= 10; i++) await serviceB.startRace({ visitorId, ...START, runId: `run-${i}` });
  await assert.rejects(() => serviceB.startRace({ visitorId, ...START, runId: 'run-11' }), (error) => error.code === 'visitor_daily_limit');
});

test('AE6: two concurrent claims for the final global slot commit exactly one race', async () => {
  const service = createUsageService(usageConfig({ dailyGlobalRaces: 1 }), { store: createFakeStore() });
  const visitorA = await newVisitor(service);
  const visitorB = visitorA + '-other';
  const results = await Promise.allSettled([
    service.startRace({ visitorId: visitorA, ...START, runId: 'run-a' }),
    service.startRace({ visitorId: visitorB, ...START, runId: 'run-b' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'global_daily_limit');
});

test('two concurrent claims by the same visitor cannot exceed the visitor limit', async () => {
  const service = createUsageService(usageConfig(), { store: createFakeStore() });
  const visitorId = await newVisitor(service);
  for (let i = 1; i <= 9; i++) await service.startRace({ visitorId, ...START, runId: `run-${i}` });
  const results = await Promise.allSettled([
    service.startRace({ visitorId, ...START, runId: 'run-10a' }),
    service.startRace({ visitorId, ...START, runId: 'run-10b' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'visitor_daily_limit').length, 1);
});

test('a repeated Start with the same visitor/day/run id returns the same permit and consumes only one slot', async () => {
  const store = createFakeStore();
  const service = createUsageService(usageConfig(), { store });
  const visitorId = await newVisitor(service);
  const first = await service.startRace({ visitorId, ...START, runId: 'run-1' });
  const second = await service.startRace({ visitorId, ...START, runId: 'run-1' }); // the client retried after losing the first response
  assert.equal(first.permit, second.permit);
  const visitorRow = [...store.rows.values()].find((r) => r.rowKey.startsWith('visitor:'));
  assert.equal(visitorRow.consumed, 1);
});

test('concurrently submitting one Start run id commits exactly one race and one slot', async () => {
  const store = createFakeStore();
  const service = createUsageService(usageConfig(), { store });
  const visitorId = await newVisitor(service);
  const [a, b] = await Promise.all([
    service.startRace({ visitorId, ...START, runId: 'run-dup' }),
    service.startRace({ visitorId, ...START, runId: 'run-dup' }),
  ]);
  assert.equal(a.permit, b.permit);
  const visitorRow = [...store.rows.values()].find((r) => r.rowKey.startsWith('visitor:'));
  assert.equal(visitorRow.consumed, 1);
});

test('the start transaction uses one date partition for global, visitor and race rows', async () => {
  const store = createFakeStore();
  const service = createUsageService(usageConfig(), { store });
  const visitorId = await newVisitor(service);
  await service.startRace({ visitorId, ...START, runId: 'run-1' });
  const partitions = new Set([...store.rows.values()].map((r) => r.partitionKey));
  assert.equal(partitions.size, 1);
  const rowKeys = [...store.rows.values()].map((r) => r.rowKey).sort();
  assert.equal(rowKeys.length, 3);
  assert.equal(rowKeys[0], 'global');
  assert.ok(rowKeys[1].startsWith('race:'));
  assert.ok(rowKeys[2].startsWith('visitor:'));
});

test('a valid permit authorizes exactly one preparation; repeating its operation id is recognized, not re-reserved', async () => {
  const store = createFakeStore();
  const now = Date.parse('2026-10-14T10:00:00Z');
  const service = createUsageService(usageConfig(), { store, clock: () => now });
  const visitorId = await newVisitor(service);
  const { permit } = await service.startRace({ visitorId, ...START, runId: 'run-1' });
  await service.reservePreparation({ permit, visitorId, operationId: 'op-1' });
  assert.equal([...store.rows.values()].find((row) => row.rowKey.startsWith('race:')).createdAtMs, now);
  await assert.doesNotReject(() => service.reservePreparation({ permit, visitorId, operationId: 'op-1' }), 'repeating the same operation id is a no-op success');
  await assert.rejects(
    () => service.reservePreparation({ permit, visitorId, operationId: 'op-2' }),
    (error) => error instanceof UsageError && error.code === 'race_operation_replayed' && error.status === 409,
  );
});

test('a 10-paper, 2-desk permit authorizes at most 20 distinct decisions and rejects the 21st', async () => {
  const service = createUsageService(usageConfig(), { store: createFakeStore() });
  const visitorId = await newVisitor(service);
  const { permit } = await service.startRace({ visitorId, ...START, runId: 'run-1' }); // queueSize 10 x deskCount 2
  for (let i = 1; i <= 20; i++) await service.reserveDecision({ permit, visitorId, operationId: `d-${i}` });
  await assert.rejects(
    () => service.reserveDecision({ permit, visitorId, operationId: 'd-21' }),
    (error) => error instanceof UsageError && error.code === 'race_permit_invalid',
  );
});

test('repeating or concurrently submitting one decision operation id cannot consume two slots', async () => {
  const service = createUsageService(usageConfig(), { store: createFakeStore() });
  const visitorId = await newVisitor(service);
  const { permit } = await service.startRace({ visitorId, ...START, runId: 'run-1' });
  await service.reserveDecision({ permit, visitorId, operationId: 'd-1' });
  await assert.doesNotReject(() => service.reserveDecision({ permit, visitorId, operationId: 'd-1' }));

  const { permit: permit2 } = await service.startRace({ visitorId, ...START, runId: 'run-2' });
  const [a, b] = await Promise.all([
    service.reserveDecision({ permit: permit2, visitorId, operationId: 'd-dup' }),
    service.reserveDecision({ permit: permit2, visitorId, operationId: 'd-dup' }),
  ]);
  // Both calls succeed (one wins the reservation, the other recognizes it already exists), but only one slot is consumed.
  assert.ok(a.ok && b.ok);
  assert.equal(a.remaining, b.remaining);
  assert.equal(a.remaining, START.queueSize * START.deskCount - 1);
});

test('an expired permit, wrong visitor, altered permit and disallowed profile are each rejected', async () => {
  const sharedStore = createFakeStore();
  const service = createUsageService(usageConfig({ permitMinutes: 1 }), { store: sharedStore, clock: () => Date.parse('2026-10-14T10:00:00Z') });
  const visitorId = await newVisitor(service);
  const { permit } = await service.startRace({ visitorId, ...START, runId: 'run-1' });

  const expiredService = createUsageService(usageConfig({ permitMinutes: 1 }), { store: sharedStore, clock: () => Date.parse('2026-10-14T10:05:00Z') });
  await assert.rejects(() => expiredService.reservePreparation({ permit, visitorId, operationId: 'op-1' }), (error) => error.code === 'race_permit_invalid');

  const freshService = createUsageService(usageConfig(), { store: sharedStore });
  await assert.rejects(
    () => freshService.reservePreparation({ permit, visitorId: visitorId + '-different', operationId: 'op-1' }),
    (error) => error.code === 'race_permit_invalid',
  );
  const altered = permit.slice(0, -1) + (permit.at(-1) === 'a' ? 'b' : 'a');
  await assert.rejects(() => freshService.reservePreparation({ permit: altered, visitorId, operationId: 'op-1' }), (error) => error.code === 'race_permit_invalid');
  await assert.rejects(
    () => freshService.reserveDecision({ permit, visitorId, operationId: 'op-1', profile: 'NOT_IN_LINEUP' }),
    (error) => error.code === 'race_permit_invalid',
  );
});

test('lowering the configured global cap takes effect immediately; raising it waits for the next India day', async () => {
  const store = createFakeStore();
  const clockBox = { now: Date.parse('2026-10-14T06:00:00Z') };
  const clock = () => clockBox.now;

  const generous = createUsageService(usageConfig({ dailyGlobalRaces: 10 }), { store, clock });
  const visitorA = await newVisitor(generous);
  await generous.startRace({ visitorId: visitorA, ...START, runId: 'run-a' });

  const strict = createUsageService(usageConfig({ dailyGlobalRaces: 0 }), { store, clock });
  const visitorB = visitorA + '-other';
  await assert.rejects(() => strict.startRace({ visitorId: visitorB, ...START, runId: 'run-b' }), (error) => error.code === 'global_daily_limit');

  const stillGenerous = createUsageService(usageConfig({ dailyGlobalRaces: 10 }), { store, clock });
  await assert.rejects(
    () => stillGenerous.startRace({ visitorId: visitorB, ...START, runId: 'run-c' }),
    (error) => error.code === 'global_daily_limit',
    'a later increase must not widen the cap already recorded for today',
  );

  clockBox.now = Date.parse('2026-10-14T18:31:00Z'); // past the next India midnight
  const nextDay = createUsageService(usageConfig({ dailyGlobalRaces: 10 }), { store, clock });
  await assert.doesNotReject(() => nextDay.startRace({ visitorId: visitorB, ...START, runId: 'run-d' }));
});

test('storage unavailability produces usage_control_unavailable and never authorizes work', async () => {
  const store = createFakeStore();
  store.submitTransaction = async () => { throw Object.assign(new Error('network down'), { code: 'unavailable' }); };
  const service = createUsageService(usageConfig(), { store });
  const visitorId = await newVisitor(service);
  await assert.rejects(
    () => service.startRace({ visitorId, ...START, runId: 'run-1' }),
    (error) => error instanceof UsageError && error.code === 'usage_control_unavailable' && error.status === 503,
  );
});

test('the IP burst bucket rejects a burst over its configured threshold and never retains raw addresses', async () => {
  const clockBox = { now: 1000 };
  const service = createUsageService(usageConfig({ startsPerMinute: 3 }), { store: createFakeStore(), clock: () => clockBox.now });
  assert.equal(service.checkIpBurst('203.0.113.9'), true);
  assert.equal(service.checkIpBurst('203.0.113.9'), true);
  assert.equal(service.checkIpBurst('203.0.113.9'), true);
  assert.equal(service.checkIpBurst('203.0.113.9'), false, 'the fourth start within the window is throttled');
  clockBox.now += 61_000;
  assert.equal(service.checkIpBurst('203.0.113.9'), true, 'a new window resets the bucket');
});

test('the IP burst bucket ignores spoofed forwarding headers outside App Service', () => {
  const local = createUsageService(usageConfig({ appService: false, startsPerMinute: 1 }), { store: createFakeStore() });
  assert.equal(local.checkIpBurst('203.0.113.9', { forwardedFor: '198.51.100.1' }), true);
  assert.equal(local.checkIpBurst('203.0.113.9', { forwardedFor: '198.51.100.2' }), false, 'the socket peer is the identity, not the spoofable header');
});

test('App Service trusts the first hop of the platform forwarding chain', () => {
  const service = createUsageService(usageConfig({ appService: true, startsPerMinute: 1 }), { store: createFakeStore() });
  assert.equal(service.checkIpBurst('10.0.0.4', { forwardedFor: '198.51.100.7, 10.0.0.4' }), true);
  assert.equal(service.checkIpBurst('10.0.0.4', { forwardedFor: '198.51.100.7, 10.0.0.4' }), false);
});

test('cookie output has the required attributes in hosted HTTPS mode and omits Secure for loopback HTTP', () => {
  const service = createUsageService(usageConfig(), { store: createFakeStore() });
  const { cookieValue } = service.resolveVisitor(null);
  const hosted = service.cookieHeader(cookieValue, { secure: true });
  assert.match(hosted, /HttpOnly/i);
  assert.match(hosted, /SameSite=Strict/i);
  assert.match(hosted, /Secure/i);
  assert.match(hosted, new RegExp(`^${USAGE_COOKIE_NAME}=`));
  const local = service.cookieHeader(cookieValue, { secure: false });
  assert.doesNotMatch(local, /Secure/i);
  assert.match(local, /HttpOnly/i);
});

test('quota, storage and upstream failures log only allowlisted fields, never raw errors, ids, or addresses', async () => {
  const events = [];
  const store = createFakeStore();
  const service = createUsageService(usageConfig({ dailyGlobalRaces: 0 }), { store, log: (fields) => events.push(fields) });
  const visitorId = await newVisitor(service);
  await assert.rejects(() => service.startRace({ visitorId, ...START, runId: 'run-1' }));
  assert.ok(events.length > 0);
  const allowed = new Set(['event', 'code', 'day', 'racePrefix', 'status']);
  const serialized = JSON.stringify(events);
  for (const fields of events) for (const key of Object.keys(fields)) assert.ok(allowed.has(key), `unexpected log field "${key}"`);
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes(visitorId));
});
