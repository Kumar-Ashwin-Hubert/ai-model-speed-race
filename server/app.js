import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { FIELDS, RULE_IDS, validateDossier } from '../shared/rulebook.js';
import { QUEUE_SIZES, RACE_PERMIT_HEADER } from '../shared/usage.js';
import { ROOT } from './env.js';
import { USAGE_COOKIE_NAME, UsageError } from './usage.js';

const STATIC_MOUNTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// A client-generated run id (Start) or operation id (one prepare/decide call): short, opaque, and transport-safe.
const IDENTIFIER_RE = /^[A-Za-z0-9_:-]{1,200}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const base = { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) };
  // A caller (e.g. a permit/protected-route response) may already have set a stricter cache-control; never widen it back.
  if (!res.getHeader('cache-control')) base['cache-control'] = 'no-store';
  res.writeHead(status, { ...base, ...headers });
  res.end(body);
}

function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    return Promise.reject(new HttpError(415, 'Content-Type must be application/json'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeHint(hint) {
  if (!hint || typeof hint !== 'object') return undefined;
  return {
    truth: hint.truth === 'reject' ? 'reject' : 'approve',
    violations: Array.isArray(hint.violations) ? hint.violations.filter((id) => RULE_IDS.includes(id)) : [],
  };
}

/** A model name from the browser must be a profile defined in .env. Nothing else from the browser can select an upstream. */
function parseProfile(value, config) {
  if (typeof value !== 'string' || !config.catalog.some((entry) => entry.profile === value)) throw new HttpError(400, `Unknown model "${String(value).slice(0, 40)}"`);
  return value;
}

/** An optional line-up: the model names for desks 1..3, in order. */
function parseProfiles(value, config) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new HttpError(400, 'profiles must list 1 to 3 models');
  return value.map((name) => parseProfile(name, config));
}

/** A client-supplied run id (Start) or operation id (prepare/decide): short, opaque, and safe to key storage rows with. */
function parseIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) throw new HttpError(400, `${label} must be a short identifier`);
  return value;
}

/** One of the queue sizes the UI actually offers (R8: unrelated shapes cannot be bound to a permit). */
function parseQueueSize(value) {
  if (!QUEUE_SIZES.includes(value)) throw new HttpError(400, `queueSize must be one of ${QUEUE_SIZES.join(', ')}`);
  return value;
}

/** Minimal `Cookie` header parsing; only the usage-control visitor cookie is ever read back out of it. */
function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** The race permit travels only in this dedicated header (R8, R9); missing it is a direct-call bypass attempt. */
function readPermitHeader(req) {
  const raw = req.headers[RACE_PERMIT_HEADER];
  const permit = Array.isArray(raw) ? raw[0] : raw;
  if (!permit) throw new UsageError('race_permit_required', 401, 'A race permit is required for this route.');
  return permit;
}

/** Resolves (without minting a fresh cookie) the anonymous visitor id bound to this request, if any. */
function visitorIdFromRequest(req, usage) {
  const cookies = parseCookieHeader(req.headers.cookie);
  return usage.resolveVisitor(cookies[USAGE_COOKIE_NAME]).visitorId;
}

/** Builds the decide request, forwarding only the dossier fields (never any ground truth). */
function parseDecideRequest(body, config) {
  const { deskId, paper, profile } = body ?? {};
  if (![1, 2, 3].includes(deskId)) throw new HttpError(400, 'deskId must be 1, 2 or 3');
  if (!paper || !Number.isInteger(paper.id) || paper.id < 1 || paper.id > 100000) throw new HttpError(400, 'paper.id must be a positive integer');
  const problem = validateDossier(paper.dossier);
  if (problem) throw new HttpError(400, problem);
  const dossier = Object.fromEntries(FIELDS.map(([key]) => [key, paper.dossier[key]]));
  return {
    deskId,
    ...(profile === undefined ? {} : { profile: parseProfile(profile, config) }),
    paper: { id: paper.id, dossier, ...(config.mock ? { hint: sanitizeHint(paper.hint) } : {}) },
  };
}

/**
 * The API spends the user's credits, so it only answers same-origin requests and, when bound to
 * loopback, only to loopback Host headers (blocks DNS-rebinding from other sites).
 */
function isAllowedOrigin(req, config) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (LOOPBACK_HOSTS.has(config.host)) {
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!LOOPBACK_HOSTS.has(hostname)) return false;
  }
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  const mount = STATIC_MOUNTS.find((m) => decoded.startsWith(m.prefix));
  const relative = decoded.slice(mount.prefix.length) || 'index.html';
  if (decoded.includes('\0') || relative.split(/[\\/]/).some((segment) => segment.startsWith('.'))) throw new HttpError(404, 'Not found');

  let filePath = path.resolve(mount.dir, relative);
  if (filePath !== mount.dir && !filePath.startsWith(mount.dir + path.sep)) throw new HttpError(404, 'Not found');
  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) throw new HttpError(404, 'Not found');

  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

// Every public route capable of spending model credits (R8); `/api/test` is further gated below (KTD9).
const USAGE_GATED_ROUTES = ['/api/races/start', '/api/prepare', '/api/test', '/api/decide'];

export function createApp(config, runtime, usage = null) {
  async function handleApi(req, res, pathname) {
    if (!isAllowedOrigin(req, config)) throw new HttpError(403, 'Forbidden origin');

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const options = { signal: controller.signal };

    if (pathname === '/api/config') {
      if (req.method !== 'GET') throw new HttpError(405, 'Use GET');
      return sendJson(res, 200, runtime.publicConfig());
    }
    if (!USAGE_GATED_ROUTES.includes(pathname)) throw new HttpError(404, 'Unknown API route');
    // KTD9: once live usage control is enabled, the paid diagnostics route is removed from the public app.
    if (pathname === '/api/test' && !(config.mock || !config.usage.enabled)) throw new HttpError(404, 'Unknown API route');
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST');

    const usageEnabled = config.usage.enabled;
    // KTD7: a wiring bug that leaves `usage` unset must never silently reopen an enabled deployment.
    if (usageEnabled && !usage) throw new UsageError('usage_control_unavailable', 503, 'Usage control is enabled but not available.');

    const protectedRoute = pathname === '/api/races/start' || ((pathname === '/api/prepare' || pathname === '/api/decide') && usageEnabled);
    if (protectedRoute) res.setHeader('cache-control', 'no-store, private'); // R8: permit/protected responses are never cached.

    const body = await readJson(req);

    if (pathname === '/api/races/start') {
      if (!usageEnabled) return sendJson(res, 200, { enabled: false });

      const runId = parseIdentifier(body?.runId, 'runId');
      const queueSize = parseQueueSize(body?.queueSize);
      const profiles = parseProfiles(body?.profiles, config) ?? config.lineup;
      const deskCount = profiles.length;

      // Best-effort burst prefilter (KTD8); never the authority, and never reached once input is invalid.
      const socketIp = req.socket?.remoteAddress ?? '';
      const forwardedFor = req.headers['x-forwarded-for'];
      if (!usage.checkIpBurst(socketIp, { appService: config.usage.appService, forwardedFor })) {
        throw new UsageError('start_rate_limit', 429, 'Too many race starts from this address; try again shortly.', { retryAfterMs: 60_000 });
      }

      const cookies = parseCookieHeader(req.headers.cookie);
      const { visitorId, cookieValue } = usage.resolveVisitor(cookies[USAGE_COOKIE_NAME]);
      const race = await usage.startRace({ visitorId, runId, profiles, queueSize, deskCount });

      // Sets or refreshes the signed visitor cookie regardless of whether it already existed (R1, R4).
      res.setHeader('set-cookie', usage.cookieHeader(cookieValue, { secure: !LOOPBACK_HOSTS.has(config.host) }));
      // Only the opaque permit and timing are returned; remaining visitor/global capacity is never exposed.
      return sendJson(res, 200, { permit: race.permit, resetAt: race.resetAt.toISOString(), expiresAt: race.expiresAt.toISOString() });
    }

    if (pathname === '/api/prepare') {
      const profiles = parseProfiles(body?.profiles, config);
      if (usageEnabled) {
        const permit = readPermitHeader(req);
        const operationId = parseIdentifier(body?.operationId, 'operationId');
        const reservation = await usage.reservePreparation({ permit, visitorId: visitorIdFromRequest(req, usage), operationId });
        // KTD11: a transport-retried operation id is recognized, not re-reserved -- it must not start a second
        // preparation either, so a replayed request answers from the reservation alone.
        if (reservation.recognized) return sendJson(res, 200, { desks: [], recognized: true });
      }
      return sendJson(res, 200, { desks: await runtime.prepare({ ...options, profiles }) });
    }
    if (pathname === '/api/test') return sendJson(res, 200, { desks: await runtime.test({ ...options, profiles: parseProfiles(body?.profiles, config) }) });

    const decideRequest = parseDecideRequest(body, config);
    if (usageEnabled) {
      const permit = readPermitHeader(req);
      const operationId = parseIdentifier(body?.operationId, 'operationId');
      // The model actually seated at this desk: the requested profile, or the default line-up's one for it.
      const effectiveProfile = decideRequest.profile ?? config.desks.find((desk) => desk.id === decideRequest.deskId)?.profile;
      const reservation = await usage.reserveDecision({ permit, visitorId: visitorIdFromRequest(req, usage), operationId, profile: effectiveProfile });
      // Same idempotency guarantee as preparation: a replayed decision operation id is answered, never re-run.
      if (reservation.recognized) return sendJson(res, 200, { ok: true, recognized: true, deskId: decideRequest.deskId, paperId: decideRequest.paper.id });
    }
    return sendJson(res, 200, await runtime.decide(decideRequest, options));
  }

  return async function handle(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', CSP);
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else await serveStatic(req, res, pathname);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof UsageError) {
        // R14: never serialize raw errors, permits, cookies, or addresses -- only the stable code and timing.
        const body = { error: error.message, code: error.code };
        const headers = { 'cache-control': 'no-store, private' };
        if (error.resetAt) {
          body.resetAt = error.resetAt.toISOString();
          headers['retry-after'] = String(Math.max(0, Math.ceil((error.resetAt.getTime() - Date.now()) / 1000)));
        }
        if (error.retryAfterMs != null) headers['retry-after'] = String(Math.max(0, Math.ceil(error.retryAfterMs / 1000)));
        return sendJson(res, error.status, body, headers);
      }
      if (error instanceof HttpError) {
        if (error.status === 413) res.setHeader('connection', 'close');
        return sendJson(res, error.status, { error: error.message });
      }
      console.error('Unhandled request error:', error);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}
