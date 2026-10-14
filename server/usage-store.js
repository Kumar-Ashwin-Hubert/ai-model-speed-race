import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * Store-level outcome of a failed Table Storage call. `code` is one of:
 *   - "conflict": an entity already existed (create) or an ETag did not match (update/transaction).
 *   - "unavailable": authentication, network, timeout, or any other failure; the caller must fail closed (KTD7).
 * The policy layer (usage.js) only ever sees these two codes, never a raw Azure SDK error shape.
 */
export class StoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.cause = cause;
  }
}

function classify(error) {
  const status = error?.statusCode;
  return status === 409 || status === 412 ? 'conflict' : 'unavailable';
}

async function wrap(promise, message) {
  try {
    return await promise;
  } catch (error) {
    throw new StoreError(classify(error), `${message}: ${error?.message ?? 'unknown storage error'}`, error);
  }
}

/**
 * Builds the Azure Table client this deployment should use. Production authenticates the configured
 * endpoint with the App Service managed identity (KTD3: `DefaultAzureCredential`, no stored key); local
 * development may instead pass an explicit connection string. `clientFactory` lets tests and callers that
 * already hold a client (or a fake) skip Azure SDK construction entirely.
 */
function buildClient({ tableEndpoint, tableName, storageConnectionString, credential, clientFactory }) {
  if (clientFactory) return clientFactory();
  if (storageConnectionString) return TableClient.fromConnectionString(storageConnectionString, tableName, { allowInsecureConnection: true });
  if (!tableEndpoint) throw new StoreError('unavailable', 'Usage store has no Table Storage endpoint or connection string configured.');
  return new TableClient(tableEndpoint, tableName, credential ?? new DefaultAzureCredential());
}

/**
 * Thin adapter over the Azure Table client used for the daily usage ledger (KTD1). Every method maps
 * SDK/network failures onto the small, stable `StoreError` outcomes above so the policy layer never has
 * to know about Azure error shapes, status codes, or retry semantics.
 */
export function createUsageStore(usageConfig, { credential, clientFactory } = {}) {
  const client = buildClient({ ...usageConfig, credential, clientFactory });

  return {
    /** Verifies the table exists and is reachable before the server starts accepting traffic (KTD7). */
    async init() {
      await wrap(client.createTable(), 'Could not create or reach the usage Table Storage table');
    },

    /** Reads one entity, or null when it does not exist. Any other failure raises StoreError("unavailable"). */
    async getEntity(partitionKey, rowKey) {
      try {
        return await client.getEntity(partitionKey, rowKey);
      } catch (error) {
        if (error?.statusCode === 404) return null;
        throw new StoreError('unavailable', `Could not read usage entity: ${error?.message ?? 'unknown storage error'}`, error);
      }
    },

    /** Creates a new entity. Raises StoreError("conflict") if the row already exists (idempotent-start recovery path, KTD11). */
    async createEntity(entity) {
      await wrap(client.createEntity(entity), 'Could not create usage entity');
    },

    /** Conditionally replaces an entity by ETag (KTD2). Raises StoreError("conflict") on a mismatch. */
    async replaceEntity(entity, etag) {
      await wrap(client.updateEntity(entity, 'Replace', { etag }), 'Could not update usage entity');
    },

    /**
     * Submits a same-partition entity group transaction (KTD1). Azure Table transactions are all-or-nothing:
     * if any action loses (an existing row's ETag changed, or a "create" row already exists) the whole
     * batch is rolled back, so this never partially authorizes a race (AE6).
     */
    async submitTransaction(actions) {
      await wrap(client.submitTransaction(actions), 'Could not submit usage transaction');
    },
  };
}
