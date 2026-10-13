import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { FIELDS, RULE_IDS, validateDossier } from '../shared/rulebook.js';
import { ROOT } from './env.js';

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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
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

export function createApp(config, runtime) {
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
    if (!['/api/prepare', '/api/test', '/api/decide'].includes(pathname)) throw new HttpError(404, 'Unknown API route');
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST');

    const body = await readJson(req);
    if (pathname === '/api/prepare') return sendJson(res, 200, { desks: await runtime.prepare({ ...options, profiles: parseProfiles(body?.profiles, config) }) });
    if (pathname === '/api/test') return sendJson(res, 200, { desks: await runtime.test({ ...options, profiles: parseProfiles(body?.profiles, config) }) });
    return sendJson(res, 200, await runtime.decide(parseDecideRequest(body, config), options));
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
      if (error instanceof HttpError) {
        if (error.status === 413) res.setHeader('connection', 'close');
        return sendJson(res, error.status, { error: error.message });
      }
      console.error('Unhandled request error:', error);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}
