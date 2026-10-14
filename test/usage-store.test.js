import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageStore, StoreError } from '../server/usage-store.js';

/** Mimics the shape of an Azure SDK RestError (statusCode, message) without touching the network. */
class FakeRestError extends Error {
  constructor(statusCode, message = 'fake error') {
    super(message);
    this.name = 'RestError';
    this.statusCode = statusCode;
  }
}

function fakeClient(overrides = {}) {
  return {
    createTable: async () => {},
    getEntity: async () => {
      throw new FakeRestError(404, 'Not found');
    },
    createEntity: async () => ({ etag: 'W/"1"' }),
    updateEntity: async () => ({ etag: 'W/"2"' }),
    submitTransaction: async () => [],
    ...overrides,
  };
}

const usageConfig = { tableEndpoint: 'https://acct.table.core.windows.net', tableName: 'RaceUsage' };

test('init() reaches the table and resolves; a storage failure raises StoreError("unavailable")', async () => {
  const ok = createUsageStore(usageConfig, { clientFactory: () => fakeClient() });
  await assert.doesNotReject(() => ok.init());

  const broken = createUsageStore(usageConfig, {
    clientFactory: () => fakeClient({ createTable: async () => { throw new FakeRestError(401, 'auth failed'); } }),
  });
  await assert.rejects(() => broken.init(), (error) => error instanceof StoreError && error.code === 'unavailable');
});

test('getEntity returns null for a missing row instead of throwing', async () => {
  const store = createUsageStore(usageConfig, { clientFactory: () => fakeClient() });
  assert.equal(await store.getEntity('20261014', 'global'), null);
});

test('getEntity returns the row when present', async () => {
  const entity = { partitionKey: '20261014', rowKey: 'global', consumed: 3, etag: 'W/"9"' };
  const store = createUsageStore(usageConfig, { clientFactory: () => fakeClient({ getEntity: async () => entity }) });
  assert.deepEqual(await store.getEntity('20261014', 'global'), entity);
});

test('getEntity raises StoreError("unavailable") for a non-404 failure, e.g. a network error', async () => {
  const store = createUsageStore(usageConfig, {
    clientFactory: () => fakeClient({ getEntity: async () => { throw new Error('ECONNRESET'); } }),
  });
  await assert.rejects(() => store.getEntity('20261014', 'global'), (error) => error instanceof StoreError && error.code === 'unavailable');
});

test('createEntity raises StoreError("conflict") when the row already exists (409)', async () => {
  const store = createUsageStore(usageConfig, {
    clientFactory: () => fakeClient({ createEntity: async () => { throw new FakeRestError(409, 'EntityAlreadyExists'); } }),
  });
  await assert.rejects(() => store.createEntity({ partitionKey: 'p', rowKey: 'r' }), (error) => error instanceof StoreError && error.code === 'conflict');
});

test('replaceEntity raises StoreError("conflict") on an ETag mismatch (412)', async () => {
  const store = createUsageStore(usageConfig, {
    clientFactory: () => fakeClient({ updateEntity: async () => { throw new FakeRestError(412, 'PreconditionFailed'); } }),
  });
  await assert.rejects(() => store.replaceEntity({ partitionKey: 'p', rowKey: 'r' }, 'W/"1"'), (error) => error instanceof StoreError && error.code === 'conflict');
});

test('replaceEntity passes the ETag through as a conditional update', async () => {
  let seenMode;
  let seenOptions;
  const store = createUsageStore(usageConfig, {
    clientFactory: () =>
      fakeClient({
        updateEntity: async (entity, mode, options) => {
          seenMode = mode;
          seenOptions = options;
          return { etag: 'W/"3"' };
        },
      }),
  });
  await store.replaceEntity({ partitionKey: 'p', rowKey: 'r', consumed: 2 }, 'W/"1"');
  assert.equal(seenMode, 'Replace');
  assert.deepEqual(seenOptions, { etag: 'W/"1"' });
});

test('submitTransaction raises StoreError("conflict") when any action in the batch loses (409/412)', async () => {
  const store = createUsageStore(usageConfig, {
    clientFactory: () => fakeClient({ submitTransaction: async () => { throw new FakeRestError(409, 'EntityAlreadyExists'); } }),
  });
  await assert.rejects(() => store.submitTransaction([['create', { partitionKey: 'p', rowKey: 'r' }]]), (error) => error instanceof StoreError && error.code === 'conflict');
});

test('submitTransaction raises StoreError("unavailable") for a network/timeout failure, never authorizing silently', async () => {
  const store = createUsageStore(usageConfig, {
    clientFactory: () => fakeClient({ submitTransaction: async () => { throw new Error('timeout'); } }),
  });
  await assert.rejects(() => store.submitTransaction([]), (error) => error instanceof StoreError && error.code === 'unavailable');
});

test('submitTransaction resolves and forwards the actions on success', async () => {
  let seenActions;
  const store = createUsageStore(usageConfig, {
    clientFactory: () => fakeClient({ submitTransaction: async (actions) => { seenActions = actions; return [{ etag: 'W/"1"' }]; } }),
  });
  const actions = [['create', { partitionKey: 'p', rowKey: 'global' }]];
  await store.submitTransaction(actions);
  assert.deepEqual(seenActions, actions);
});

test('createUsageStore refuses to build a client with neither a table endpoint nor a connection string', () => {
  assert.throws(() => createUsageStore({ tableName: 'RaceUsage' }), StoreError);
});
