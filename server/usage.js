import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_VISITOR_DAILY_LIMIT } from '../shared/usage.js';

const INDIA_TZ = 'Asia/Kolkata';
const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000; // India Standard Time has no daylight saving; the offset is fixed.
const MAX_RETRIES = 5; // KTD2: bounded retries, matching the retry policy used elsewhere in this app.
const BASE_BACKOFF_MS = 15;
const BURST_WINDOW_MS = 60_000;
const BURST_BUCKET_TTL_MS = BURST_WINDOW_MS * 5; // how long an idle bucket is kept before eviction
const INDIA_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: INDIA_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const USAGE_COOKIE_NAME = 'av';
const ALLOWED_LOG_FIELDS = ['event', 'code', 'day', 'racePrefix', 'status'];

/** The stable Error Contract: HTTP status + a code the UI and operators can act on (R11, R14). */
export class UsageError extends Error {
  constructor(code, status, message, { resetAt = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.status = status;
    this.resetAt = resetAt;
    this.retryAfterMs = retryAfterMs;
  }
}

const fail = (code, status, message, extra) => {
  throw new UsageError(code, status, message, extra);
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hmacHex(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Only these fields ever reach the log sink (R14): no secrets, identifiers, permits, cookies, or addresses. */
function logEvent(log, fields) {
  const safe = {};
  for (const key of ALLOWED_LOG_FIELDS) if (fields[key] !== undefined) safe[key] = fields[key];
  log(safe);
}

/**
 * The India-calendar day (`Asia/Kolkata`) this instant falls in, as a table-safe partition key (`YYYYMMDD`),
 * plus the UTC instant of the next India midnight (when permits and daily counters reset). Never uses the
 * server's local timezone (Risks: "Clock boundaries").
 */
export function indiaDay(date = new Date()) {
  const parts = Object.fromEntries(
    INDIA_DATE_FORMATTER.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const key = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const resetAt = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - INDIA_OFFSET_MS);
  return { key, resetAt };
}

function deriveRaceId(secret, dayKey, visitorHash, runId) {
  return hmacHex(secret, `race:${dayKey}:${visitorHash}:${runId}`).slice(0, 32);
}

function signPermit(secret, dayKey, raceId, visitorHash) {
  return hmacHex(secret, `permit:${dayKey}:${raceId}:${visitorHash}`).slice(0, 32);
}

function buildPermit(secret, dayKey, raceId, visitorHash) {
  return `${dayKey}.${raceId}.${signPermit(secret, dayKey, raceId, visitorHash)}`;
}

const PERMIT_RE = /^(\d{8})\.([0-9a-f]{32})\.([0-9a-f]{32})$/;

function parsePermit(permit) {
  const match = PERMIT_RE.exec(String(permit ?? ''));
  return match ? { dayKey: match[1], raceId: match[2], sig: match[3] } : null;
}

/** Verifies a permit against the caller's own visitor hash: a permit from, or altered for, another visitor never matches. */
function verifyPermit(secret, permit, visitorHash) {
  const parsed = parsePermit(permit);
  if (!parsed) return null;
  const expected = signPermit(secret, parsed.dayKey, parsed.raceId, visitorHash);
  return timingSafeEqualHex(expected, parsed.sig) ? parsed : null;
}

function dayScopedVisitorHash(secret, dayKey, visitorId) {
  return hmacHex(secret, `visitor:${dayKey}:${visitorId}`);
}

/** Random, unguessable visitor id; the signed cookie value binds it against tampering without a server-side session. */
function newVisitorId(randomBytesImpl) {
  return randomBytesImpl(16).toString('hex');
}

function signCookieValue(secret, visitorId) {
  return `${visitorId}.${hmacHex(secret, `cookie:${visitorId}`).slice(0, 32)}`;
}

function verifyCookieValue(secret, cookieValue) {
  const [visitorId, sig] = String(cookieValue ?? '').split('.');
  if (!visitorId || !sig || !/^[0-9a-f]{32,64}$/.test(visitorId)) return null;
  return timingSafeEqualHex(hmacHex(secret, `cookie:${visitorId}`).slice(0, 32), sig) ? visitorId : null;
}

/**
 * A bounded per-process IP start bucket (KTD8): a best-effort prefilter only, never the authority. It stores
 * only an HMAC of the normalized address under a day-scoped key, never the raw address, and evicts stale
 * entries so memory cannot grow unbounded.
 */
function createIpBurstLimiter({ secret, limitPerMinute, clock }) {
  const buckets = new Map();
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < BURST_WINDOW_MS) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) if (now - bucket.windowStart >= BURST_BUCKET_TTL_MS) buckets.delete(key);
  }

  /** Picks the address to key on: the App Service forwarding chain's first hop only inside App Service, else the socket peer. */
  function resolveAddress(socketIp, { appService, forwardedFor } = {}) {
    const raw = appService && forwardedFor ? String(forwardedFor).split(',')[0] : socketIp;
    return String(raw ?? '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  }

  return function checkIpBurst(socketIp, options) {
    const now = clock();
    sweep(now);
    const address = resolveAddress(socketIp, options);
    const day = indiaDay(new Date(now)).key;
    const key = hmacHex(secret, `ip:${day}:${address}`);
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= BURST_WINDOW_MS) {
      buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    if (bucket.count >= limitPerMinute) return false;
    bucket.count += 1;
    return true;
  };
}

/** Rebuilds the stored entity shape (JSON-encoded fields) from the in-memory race view, for a conditional write. */
function entityFromRace(race) {
  return {
    partitionKey: race.partitionKey,
    rowKey: race.rowKey,
    visitorHash: race.visitorHash,
    profilesJson: JSON.stringify(race.profiles),
    queueSize: race.queueSize,
    deskCount: race.deskCount,
    maxDecisions: race.maxDecisions,
    createdAtMs: race.createdAtMs,
    expiresAtMs: race.expiresAtMs,
    prepareOperationId: race.prepareOperationId ?? '',
    decisionsConsumed: race.decisionsConsumed,
    decisionOperationIdsJson: JSON.stringify(race.decisionOperationIds),
  };
}

function raceEntityShape(entity) {
  return {
    visitorHash: entity.visitorHash,
    profiles: JSON.parse(entity.profilesJson),
    queueSize: entity.queueSize,
    deskCount: entity.deskCount,
    maxDecisions: entity.maxDecisions,
    createdAtMs: entity.createdAtMs,
    expiresAtMs: entity.expiresAtMs,
    prepareOperationId: entity.prepareOperationId || null,
    decisionsConsumed: entity.decisionsConsumed,
    decisionOperationIds: entity.decisionOperationIdsJson ? JSON.parse(entity.decisionOperationIdsJson) : [],
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
    etag: entity.etag,
  };
}

/**
 * Builds the usage-control domain service: the atomic daily ledger (R1-R7, R10; KTD1-KTD3) and the permit
 * authority for preparation/decision operations (KTD4-KTD6, KTD11). Pure policy over an injected `store`
 * (server/usage-store.js or a fake with the same shape) -- no HTTP, no Azure SDK types.
 */
export function createUsageService(usageConfig, { store, clock = () => Date.now(), randomBytesImpl = randomBytes, log = () => {} } = {}) {
  const { signingSecret: secret, dailyGlobalRaces: configuredCap, permitMinutes, startsPerMinute } = usageConfig;
  const VISITOR_DAILY_LIMIT = usageConfig.visitorDailyLimit ?? DEFAULT_VISITOR_DAILY_LIMIT;
  const checkIpBurst = createIpBurstLimiter({ secret, limitPerMinute: startsPerMinute, clock });

  async function withConflictRetry(label, fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn(attempt);
      } catch (error) {
        if (error?.code === 'conflict' && attempt < MAX_RETRIES) {
          await sleep(BASE_BACKOFF_MS * attempt);
          continue;
        }
        if (error instanceof UsageError) throw error;
        const day = indiaDay(new Date(clock())).key;
        logEvent(log, { event: 'usage_storage_error', code: 'usage_control_unavailable', day, status: 503 });
        fail('usage_control_unavailable', 503, `Usage control could not complete "${label}" safely.`);
      }
    }
  }

  /** Looks up the race a permit names and verifies its binding; throws race_permit_invalid for anything wrong (R3, AE5). */
  async function loadVerifiedRace(permit, visitorId) {
    const parsed = parsePermit(permit);
    if (!parsed) fail('race_permit_invalid', 403, 'The permit is malformed.');
    const visitorHash = dayScopedVisitorHash(secret, parsed.dayKey, visitorId);
    const verified = verifyPermit(secret, permit, visitorHash);
    if (!verified) fail('race_permit_invalid', 403, 'The permit does not belong to this visitor, or was altered.');
    const entity = await store.getEntity(verified.dayKey, `race:${verified.raceId}`);
    if (!entity) fail('race_permit_invalid', 403, 'The permit does not name a known race.');
    const race = raceEntityShape(entity);
    if (race.visitorHash !== visitorHash) fail('race_permit_invalid', 403, 'The permit belongs to another visitor.');
    if (clock() > race.expiresAtMs) fail('race_permit_invalid', 403, 'The permit has expired.');
    return race;
  }

  return {
    /** Resolves (or issues) the signed anonymous visitor identity from a raw cookie header value (KTD3/KTD4 cookie notes). */
    resolveVisitor(cookieValue) {
      const existing = cookieValue ? verifyCookieValue(secret, cookieValue) : null;
      if (existing) return { visitorId: existing, cookieValue, isNew: false };
      const visitorId = newVisitorId(randomBytesImpl);
      return { visitorId, cookieValue: signCookieValue(secret, visitorId), isNew: true };
    },

    /** The `Set-Cookie` header value for the visitor cookie: HttpOnly, SameSite=Strict, path-scoped, Secure only over HTTPS. */
    cookieHeader(cookieValue, { secure = true } = {}) {
      const attrs = [`${USAGE_COOKIE_NAME}=${cookieValue}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
      if (secure) attrs.push('Secure');
      return attrs.join('; ');
    },

    /** Best-effort per-IP start burst prefilter (KTD8); never the sole authority. */
    checkIpBurst,

    /**
     * Allocates a race: validates the visitor and global daily allowances and atomically consumes both,
     * creating an idempotent race row keyed off the client's run id (R1-R7, R10; AE1-AE4, AE6; KTD1-KTD6).
     */
    async startRace({ visitorId, runId, profiles, queueSize, deskCount }) {
      if (typeof runId !== 'string' || !runId) throw new TypeError('runId must be a non-empty string');
      if (!Number.isInteger(queueSize) || queueSize < 1 || !Number.isInteger(deskCount) || deskCount < 1) {
        throw new TypeError('queueSize and deskCount must be positive integers');
      }
      const maxDecisions = queueSize * deskCount;

      return withConflictRetry('start a race', async () => {
        const { key: dayKey, resetAt } = indiaDay(new Date(clock()));
        const visitorHash = dayScopedVisitorHash(secret, dayKey, visitorId);
        const raceId = deriveRaceId(secret, dayKey, visitorHash, runId);
        const raceRowKey = `race:${raceId}`;

        // Idempotent fast path (KTD11): a retried Start with the same run id recovers the existing permit for free.
        const existingRace = await store.getEntity(dayKey, raceRowKey);
        if (existingRace) {
          if (existingRace.visitorHash !== visitorHash) fail('race_permit_invalid', 403, 'This run id is already in use by another visitor today.');
          return {
            permit: buildPermit(secret, dayKey, raceId, visitorHash),
            raceId,
            resetAt,
            expiresAt: new Date(existingRace.expiresAtMs),
          };
        }

        const [globalEntity, visitorEntity] = await Promise.all([
          store.getEntity(dayKey, 'global'),
          store.getEntity(dayKey, `visitor:${visitorHash}`),
        ]);

        const effectiveCap = globalEntity ? Math.min(globalEntity.cap, configuredCap) : configuredCap; // KTD12
        const globalConsumed = globalEntity?.consumed ?? 0;
        if (globalConsumed >= effectiveCap) {
          // KTD12: a configured decrease is recorded against today's row immediately, even on a refusal,
          // so a later instance (or restart) configured with the old, higher cap cannot widen it back.
          if (globalEntity && effectiveCap < globalEntity.cap) {
            await store.replaceEntity({ partitionKey: dayKey, rowKey: 'global', consumed: globalConsumed, cap: effectiveCap }, globalEntity.etag);
          }
          logEvent(log, { event: 'usage_refusal', code: 'global_daily_limit', day: dayKey, status: 429 });
          fail('global_daily_limit', 429, "The deployment's global daily race limit has been reached.", { resetAt });
        }
        const visitorConsumed = visitorEntity?.consumed ?? 0;
        if (visitorConsumed >= VISITOR_DAILY_LIMIT) {
          logEvent(log, { event: 'usage_refusal', code: 'visitor_daily_limit', day: dayKey, status: 429 });
          fail('visitor_daily_limit', 429, 'This browser has started the maximum number of races today.', { resetAt });
        }

        const now = clock();
        const expiresAtMs = Math.min(now + permitMinutes * 60_000, resetAt.getTime());
        const raceEntity = {
          partitionKey: dayKey,
          rowKey: raceRowKey,
          visitorHash,
          profilesJson: JSON.stringify(profiles ?? []),
          queueSize,
          deskCount,
          maxDecisions,
          createdAtMs: now,
          expiresAtMs,
          prepareOperationId: '',
          decisionsConsumed: 0,
          decisionOperationIdsJson: '[]',
        };

        const actions = [
          globalEntity
            ? ['update', { partitionKey: dayKey, rowKey: 'global', consumed: globalConsumed + 1, cap: effectiveCap }, 'Replace', { etag: globalEntity.etag }]
            : ['create', { partitionKey: dayKey, rowKey: 'global', consumed: 1, cap: effectiveCap }],
          visitorEntity
            ? ['update', { partitionKey: dayKey, rowKey: `visitor:${visitorHash}`, consumed: visitorConsumed + 1 }, 'Replace', { etag: visitorEntity.etag }]
            : ['create', { partitionKey: dayKey, rowKey: `visitor:${visitorHash}`, consumed: 1 }],
          ['create', raceEntity],
        ];

        await store.submitTransaction(actions);
        logEvent(log, { event: 'usage_start', code: 'ok', day: dayKey, racePrefix: raceId.slice(0, 8), status: 200 });
        return { permit: buildPermit(secret, dayKey, raceId, visitorHash), raceId, resetAt, expiresAt: new Date(expiresAtMs) };
      });
    },

    /** Reserves the one preparation operation a permit authorizes (R2, R3; KTD5, KTD11). */
    async reservePreparation({ permit, visitorId, operationId }) {
      return withConflictRetry('reserve preparation', async () => {
        const race = await loadVerifiedRace(permit, visitorId);
        if (race.prepareOperationId === operationId) return { ok: true, recognized: true };
        if (race.prepareOperationId) fail('race_operation_replayed', 409, 'Preparation has already been consumed for this race.');
        await store.replaceEntity({ ...entityFromRace(race), prepareOperationId: operationId }, race.etag);
        return { ok: true, recognized: false };
      });
    },

    /** Reserves one decision operation, bounded by the permit's maximum decision count (KTD6, KTD11). */
    async reserveDecision({ permit, visitorId, operationId, profile }) {
      return withConflictRetry('reserve a decision', async () => {
        const race = await loadVerifiedRace(permit, visitorId);
        if (profile !== undefined && !race.profiles.includes(profile)) fail('race_permit_invalid', 403, 'This permit does not allow that model.');
        if (race.decisionOperationIds.includes(operationId)) return { ok: true, recognized: true, remaining: race.maxDecisions - race.decisionsConsumed };
        if (race.decisionsConsumed >= race.maxDecisions) fail('race_permit_invalid', 403, 'This permit has used its maximum number of decisions.');
        const decisionOperationIds = [...race.decisionOperationIds, operationId];
        await store.replaceEntity(
          { ...entityFromRace(race), decisionsConsumed: race.decisionsConsumed + 1, decisionOperationIdsJson: JSON.stringify(decisionOperationIds) },
          race.etag,
        );
        return { ok: true, recognized: false, remaining: race.maxDecisions - decisionOperationIds.length };
      });
    },
  };
}
