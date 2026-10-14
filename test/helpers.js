import http from 'node:http';
import { RULE_IDS } from '../shared/rulebook.js';
import { createApp } from '../server/app.js';

/** Starts the application on an ephemeral loopback port for an integration test. */
export async function withApp(config, runtime, usageOrFn, maybeFn) {
  const usage = typeof usageOrFn === 'function' ? null : usageOrFn;
  const fn = typeof usageOrFn === 'function' ? usageOrFn : maybeFn;
  const server = http.createServer(createApp(config, runtime, usage));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

export const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** In-memory Azure Table stand-in with atomic transaction commits and optimistic concurrency. */
export function createFakeStore() {
  const rows = new Map();
  const keyOf = (pk, rk) => `${pk}\u0000${rk}`;
  let etagSeq = 0;
  const conflict = (message) => Object.assign(new Error(message), { code: 'conflict' });

  return {
    rows,
    async getEntity(pk, rk) {
      await Promise.resolve();
      const row = rows.get(keyOf(pk, rk));
      return row ? { ...row } : null;
    },
    async createEntity(entity) {
      const key = keyOf(entity.partitionKey, entity.rowKey);
      if (rows.has(key)) throw conflict('already exists');
      rows.set(key, { ...entity, etag: `W/"${++etagSeq}"` });
    },
    async replaceEntity(entity, etag) {
      const key = keyOf(entity.partitionKey, entity.rowKey);
      const current = rows.get(key);
      if (!current || current.etag !== etag) throw conflict('etag mismatch');
      rows.set(key, { ...entity, etag: `W/"${++etagSeq}"` });
    },
    async submitTransaction(actions) {
      for (const [kind, entity, , options] of actions) {
        const key = keyOf(entity.partitionKey, entity.rowKey);
        const current = rows.get(key);
        if (kind === 'create' && current) throw conflict('already exists');
        if (kind === 'update' && (!current || current.etag !== options?.etag)) throw conflict('etag mismatch');
      }
      for (const [, entity] of actions) rows.set(keyOf(entity.partitionKey, entity.rowKey), { ...entity, etag: `W/"${++etagSeq}"` });
    },
  };
}

/**
 * Starts a throwaway upstream HTTP server. `handler(call, n)` returns
 * { status, json, text, headers, delayMs } or undefined for a LiteLLM-style 404.
 */
export async function startStub(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // keep null
    }
    const call = { method: req.method, path: req.url, headers: req.headers, body };
    calls.push(call);
    const result = (await handler(call, calls.length)) ?? { status: 404, json: { detail: 'Not Found' } };
    if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...(result.headers ?? {}) });
    res.end(result.text ?? JSON.stringify(result.json ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    calls,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

export const chatReply = (content, { finish = 'stop', usage = { prompt_tokens: 120, completion_tokens: 2 }, model = 'stub-model' } = {}) => ({
  json: { id: 'chatcmpl-test', model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage },
});

export const responsesReply = (text, { status = 'completed', usage = { input_tokens: 150, output_tokens: 3 }, model = 'gpt-4.1-mini-2025-04-14', reasoning = false, extra = {} } = {}) => ({
  json: {
    id: 'resp_test',
    object: 'response',
    status,
    model,
    output: [
      ...(reasoning ? [{ type: 'reasoning', id: 'rs_test', summary: [] }] : []),
      { type: 'message', id: 'msg_test', status: 'completed', role: 'assistant', content: text === null ? [] : [{ type: 'output_text', text, annotations: [] }] },
    ],
    usage,
    ...extra,
  },
});

export const systemOneReply = (noul, usage = { input_tokens: 310, output_tokens: 0 }) => ({
  json: {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(
      ['forged', 'expired', 'contraband', 'watchlist', 'unsponsored', 'contradiction'].map((id) => [id, { type: 'noul', noul: noul[id] ?? 0.01 }]),
    ),
    usage,
  },
});

/** What KodeKey's LiteLLM returns for typesafe/jev-*: the answers map as JSON text in the chat message content. */
export const questionsReply = (noul = {}, usage = { prompt_tokens: 459, completion_tokens: 108 }) =>
  chatReply(JSON.stringify(Object.fromEntries(RULE_IDS.map((id) => [id, { noul: noul[id] ?? 0.02, type: 'noul' }]))), { usage, model: 'typesafe/jev-1.13.0' });