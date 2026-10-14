import { test } from 'node:test';
import assert from 'node:assert/strict';
import { azureAuth, classifyEndpoint, foundryBaseUrl, foundryDeploymentHint, foundryRoutes, loadConfig, publicConfig, UsageConfigError } from '../server/config.js';

const HOST = 'https://example-resource.services.ai.azure.com';

test('foundryBaseUrl accepts every endpoint shape that gets pasted from the portal', () => {
  const expected = 'https://res.services.ai.azure.com/openai/v1';
  assert.equal(foundryBaseUrl('https://res.services.ai.azure.com'), expected);
  assert.equal(foundryBaseUrl('https://res.services.ai.azure.com/'), expected);
  assert.equal(foundryBaseUrl('res.services.ai.azure.com'), expected);
  assert.equal(foundryBaseUrl('https://res.services.ai.azure.com/api/projects/my-proj'), expected);
  assert.equal(foundryBaseUrl('https://res.services.ai.azure.com/openai/v1/'), expected);
  assert.equal(foundryBaseUrl('https://res.openai.azure.com/'), 'https://res.openai.azure.com/openai/v1');
  assert.equal(
    foundryBaseUrl('https://res.openai.azure.com/openai/deployments/gpt-x/chat/completions?api-version=2025-01-01-preview'),
    'https://res.openai.azure.com/openai/v1',
  );
  assert.equal(foundryBaseUrl('https://llama-70b.eastus2.models.ai.azure.com'), 'https://llama-70b.eastus2.models.ai.azure.com/v1');
  assert.equal(foundryBaseUrl('http://exa mple'), null);
});

test('foundryDeploymentHint reads the deployment from a pasted Target URI', () => {
  assert.equal(foundryDeploymentHint('https://r.openai.azure.com/openai/deployments/my-gpt/chat/completions?api-version=1'), 'my-gpt');
  assert.equal(foundryDeploymentHint('https://r.openai.azure.com/'), '');
});

test('classifyEndpoint recognises the three URLs the Foundry portal shows, and uses them verbatim', () => {
  for (const [path, api] of [['/openai/v1/responses', 'responses'], ['/openai/v1/chat/completions', 'chat'], ['/providers/microsoft/v1/systemone', 'systemone']]) {
    const info = classifyEndpoint(`${HOST}${path}`);
    assert.equal(info.api, api, path);
    assert.equal(info.href, `${HOST}${path}`);
    assert.equal(info.origin, HOST);
  }
  assert.equal(classifyEndpoint(`${HOST}/openai/v1/responses/`).api, 'responses');
  assert.equal(classifyEndpoint(`${HOST}/OpenAI/v1/Chat/Completions`).api, 'chat');
});

test('classifyEndpoint treats a bare resource or project endpoint as an endpoint without an API', () => {
  for (const raw of [HOST, `${HOST}/`, `${HOST}/api/projects/my-proj`, `${HOST}/api/projects/my-proj/`]) {
    const info = classifyEndpoint(raw);
    assert.equal(info.api, null, raw);
    assert.equal(info.origin, HOST);
    assert.equal(info.href, null);
  }
});

test('project-scoped routes are called on the resource, because API keys are scoped to the resource', () => {
  const info = classifyEndpoint(`${HOST}/api/projects/my-proj/openai/v1/responses`);
  assert.equal(info.api, 'responses');
  assert.equal(info.href, `${HOST}/openai/v1/responses`);
});

test('a classic Target URI keeps its path and api-version and yields the deployment name', () => {
  const raw = 'https://r.openai.azure.com/openai/deployments/gpt-x/chat/completions?api-version=2025-01-01-preview';
  const info = classifyEndpoint(raw);
  assert.equal(info.api, 'chat');
  assert.equal(info.href, raw);
  assert.equal(info.deployment, 'gpt-x');
  assert.equal(classifyEndpoint('http://exa mple'), null);
});

test('foundryRoutes derive every route from a resource endpoint', () => {
  assert.deepEqual(foundryRoutes('https://r.services.ai.azure.com', 'r.services.ai.azure.com'), {
    chat: 'https://r.services.ai.azure.com/openai/v1/chat/completions',
    responses: 'https://r.services.ai.azure.com/openai/v1/responses',
    systemone: 'https://r.services.ai.azure.com/providers/microsoft/v1/systemone',
  });
  assert.equal(foundryRoutes('https://m.eastus2.models.ai.azure.com', 'm.eastus2.models.ai.azure.com').chat, 'https://m.eastus2.models.ai.azure.com/v1/chat/completions');
});

test('Azure hosts send the key as api-key with a bearer fallback; other hosts only a bearer token', () => {
  const bearer = { authorization: 'Bearer K' };
  assert.deepEqual(azureAuth('r.openai.azure.com', 'K'), { headers: { 'api-key': 'K' }, altHeaders: bearer });
  assert.deepEqual(azureAuth('r.services.ai.azure.com', 'K'), { headers: { 'api-key': 'K' }, altHeaders: bearer });
  assert.deepEqual(azureAuth('legacy.eastus2.models.ai.azure.com', 'K'), { headers: bearer, altHeaders: { 'api-key': 'K' } });
  assert.deepEqual(azureAuth('127.0.0.1', 'K'), { headers: bearer, altHeaders: null });
});

test('default lineup: JEV via KodeKey, two Foundry desks that report exactly what is missing', () => {
  const config = loadConfig({});
  assert.equal(config.mock, false);
  const [jev, two, three] = config.desks;
  assert.deepEqual([jev.provider, jev.model, jev.kind, jev.label], ['kodekey', 'typesafe/jev-1.13.0', 'systemone', 'JEV']);
  assert.deepEqual(jev.missing, ['KODEKEY_API_KEY']);
  assert.equal(jev.upstream.chatUrl, 'https://api.ai.kodekloud.com/v1/chat/completions');
  assert.equal(jev.upstream.systemOneUrl, 'https://api.ai.kodekloud.com/v1/systemone');
  assert.equal(jev.mode, 'questions', 'KodeKey takes the typed questions in response_format');
  assert.equal(jev.priceIn, 0.042);
  assert.equal(jev.priceOut, 0);
  assert.deepEqual(two.missing, ['FOUNDRY_API_KEY', 'FOUNDRY_ENDPOINT', 'DESK2_MODEL']);
  assert.equal(two.api, 'chat');
  assert.equal(two.maxTokens, 4096);
  assert.equal(three.configured, false);
});

test('a fully configured environment is ready and builds the right upstream targets', () => {
  const config = loadConfig({
    KODEKEY_API_KEY: 'kk-secret',
    KODEKEY_BASE_URL: 'https://gw.example.com/v1/',
    FOUNDRY_ENDPOINT: 'https://res.services.ai.azure.com',
    FOUNDRY_API_KEY: 'fk-secret',
    DESK2_MODEL: 'fast-one',
    DESK3_MODEL: 'big-one',
    DESK3_LABEL: 'Big One',
    DESK3_REASONING_EFFORT: 'LOW',
    DESK3_PRICE_IN: '1.5',
    DESK3_PRICE_OUT: '6',
    DESK3_TEMPERATURE: '0',
  });
  const [jev, two, three] = config.desks;
  assert.ok(config.desks.every((d) => d.configured));
  assert.equal(jev.upstream.chatUrl, 'https://gw.example.com/v1/chat/completions');
  assert.deepEqual(jev.upstream.headers, { authorization: 'Bearer kk-secret' });
  assert.equal(jev.upstream.altHeaders, null);
  assert.equal(two.upstream.chatUrl, 'https://res.services.ai.azure.com/openai/v1/chat/completions');
  assert.equal(two.upstream.responsesUrl, 'https://res.services.ai.azure.com/openai/v1/responses');
  assert.deepEqual(two.upstream.headers, { 'api-key': 'fk-secret' });
  assert.deepEqual(two.upstream.altHeaders, { authorization: 'Bearer fk-secret' });
  assert.equal(two.label, 'fast-one');
  assert.equal(three.label, 'Big One');
  assert.equal(three.reasoningEffort, 'low');
  assert.equal(three.temperature, 0);
  assert.equal(three.priceIn, 1.5);
  assert.equal(three.priceOut, 6);
  assert.equal(two.priceIn, null);
});

test('a Target URI supplies the deployment name when DESKn_MODEL is empty', () => {
  const config = loadConfig({
    FOUNDRY_ENDPOINT: 'https://r.openai.azure.com/openai/deployments/pasted-deployment/chat/completions?api-version=2025-01-01-preview',
    FOUNDRY_API_KEY: 'k',
  });
  assert.equal(config.desks[1].model, 'pasted-deployment');
  assert.deepEqual(config.desks[1].upstream.headers, { 'api-key': 'k' });
});

test('portal URLs wire each desk to the right API, host, auth and kind (one resource, one key)', () => {
  const config = loadConfig({
    FOUNDRY_API_KEY: 'fk-secret',
    DESK1_URL: `${HOST}/providers/microsoft/v1/systemone`,
    DESK1_MODEL: 'decision-prod',
    DESK1_LABEL: 'Decision 1',
    DESK2_URL: `${HOST}/openai/v1/responses`,
    DESK2_MODEL: 'gpt-4.1-mini',
    DESK3_URL: `${HOST}/openai/v1/chat/completions`,
    DESK3_MODEL: 'grok-4.7',
    DESK3_REASONING_EFFORT: 'low',
  });
  const [one, two, three] = config.desks;
  assert.ok(config.desks.every((d) => d.configured), JSON.stringify(config.desks.map((d) => d.missing)));
  assert.deepEqual([one.provider, one.kind, one.mode, one.api, one.model], ['foundry', 'systemone', 'systemone', null, 'decision-prod']);
  assert.equal(one.upstream.systemOneUrl, `${HOST}/providers/microsoft/v1/systemone`);
  assert.deepEqual(one.upstream.headers, { 'api-key': 'fk-secret' });
  assert.equal(one.priceIn, null, 'the JEV list price must not be applied to another model');
  assert.deepEqual([two.provider, two.kind, two.api], ['foundry', 'llm', 'responses']);
  assert.equal(two.upstream.responsesUrl, `${HOST}/openai/v1/responses`);
  assert.deepEqual([three.kind, three.api, three.reasoningEffort], ['llm', 'chat', 'low']);
  assert.equal(three.upstream.chatUrl, `${HOST}/openai/v1/chat/completions`);
});

test('a Foundry desk with only a model name and no URL uses the resource endpoint', () => {
  const config = loadConfig({ FOUNDRY_ENDPOINT: HOST, FOUNDRY_API_KEY: 'k', DESK2_MODEL: 'gpt-4.1-mini', DESK2_API: 'responses', DESK3_MODEL: 'grok-4.7' });
  const [, two, three] = config.desks;
  assert.deepEqual([two.api, three.api], ['responses', 'chat']);
  assert.equal(two.upstream.responsesUrl, `${HOST}/openai/v1/responses`);
  assert.equal(three.upstream.chatUrl, `${HOST}/openai/v1/chat/completions`);
});

test('Microsoft-Decision-1 is recognised by name and defaults to its provider route', () => {
  const config = loadConfig({ FOUNDRY_ENDPOINT: HOST, FOUNDRY_API_KEY: 'k', DESK2_MODEL: 'Microsoft-Decision-1', DESK3_MODEL: 'pi-decision-1' });
  for (const desk of [config.desks[1], config.desks[2]]) {
    assert.deepEqual([desk.kind, desk.mode, desk.api, desk.configured], ['systemone', 'systemone', null, true]);
    assert.equal(desk.upstream.systemOneUrl, `${HOST}/providers/microsoft/v1/systemone`);
  }
});

test('LINEUP picks model profiles for the desks and DESKn_ settings are used for unlisted desks', () => {
  const config = loadConfig({
    LINEUP: 'jev, gpt41mini, GROK-4_7',
    KODEKEY_API_KEY: 'kk',
    FOUNDRY_API_KEY: 'fk',
    FOUNDRY_ENDPOINT: HOST,
    MODEL_JEV_MODEL: 'jev-latest',
    MODEL_JEV_LABEL: 'JEV',
    MODEL_GPT41MINI_URL: `${HOST}/openai/v1/responses`,
    MODEL_GPT41MINI_MODEL: 'gpt-4.1-mini',
    MODEL_GPT41MINI_LABEL: 'GPT-4.1 mini',
    MODEL_GROK_4_7_URL: `${HOST}/openai/v1/chat/completions`,
    MODEL_GROK_4_7_MODEL: 'grok-4.7',
    MODEL_GROK_4_7_REASONING_EFFORT: 'low',
    DESK1_MODEL: 'ignored-because-the-profile-wins',
  });
  const [one, two, three] = config.desks;
  assert.ok(config.desks.every((d) => d.configured));
  assert.deepEqual([one.provider, one.kind, one.model, one.profile, one.envPrefix], ['kodekey', 'systemone', 'jev-latest', 'JEV', 'MODEL_JEV_']);
  assert.deepEqual([two.label, two.api, two.model, two.envPrefix], ['GPT-4.1 mini', 'responses', 'gpt-4.1-mini', 'MODEL_GPT41MINI_']);
  assert.deepEqual([three.label, three.api, three.reasoningEffort], ['grok-4.7', 'chat', 'low']);

  const partial = loadConfig({ LINEUP: 'JEV', MODEL_JEV_MODEL: 'jev-latest', DESK2_MODEL: 'x', DESK3_MODEL: 'y' });
  assert.deepEqual(partial.desks.map((d) => d.envPrefix), ['MODEL_JEV_', 'DESK2_', 'DESK3_']);
  assert.deepEqual(partial.desks.map((d) => d.model), ['jev-latest', 'x', 'y']);
});

test('LINEUP problems are reported: unknown profile, too many models', () => {
  const unknown = loadConfig({ LINEUP: 'NOPE' });
  assert.ok(unknown.warnings.some((w) => w.includes('NOPE')));
  assert.ok(unknown.desks[0].missing.includes('MODEL_NOPE_MODEL'));

  const many = loadConfig({ LINEUP: 'A,B,C,D', MODEL_A_MODEL: 'a', MODEL_B_MODEL: 'b', MODEL_C_MODEL: 'c', MODEL_D_MODEL: 'd' });
  assert.ok(many.warnings.some((w) => /4 models/.test(w)));
  assert.deepEqual(many.desks.map((d) => d.profile), ['A', 'B', 'C']);
});

test('model name decides the adapter, DESKn_KIND, DESKn_MODE and DESKn_API can override', () => {
  const config = loadConfig({
    DESK1_MODEL: 'gpt-x',
    DESK2_PROVIDER: 'kodekey',
    DESK2_MODEL: 'jev-1.13.0',
    DESK2_MODE: 'nonsense',
    DESK3_MODEL: 'weird',
    DESK3_KIND: 'systemone',
    DESK1_API: 'bogus',
  });
  assert.deepEqual(config.desks.map((d) => d.kind), ['llm', 'systemone', 'systemone']);
  assert.equal(config.desks[1].mode, 'questions');
  assert.equal(config.desks[0].api, 'chat');
  assert.ok(config.warnings.some((w) => w.includes('DESK2_MODE')));
  assert.ok(config.warnings.some((w) => w.includes('DESK1_API')));
  assert.equal(loadConfig({ DESK2_MODEL: 'm', DESK2_API: 'AUTO' }).desks[1].api, 'auto');
});

test('mock mode needs no keys, ignores LINEUP and uses descriptive labels', () => {
  const config = loadConfig({ LINEUP: 'A,B,C', MODEL_A_LABEL: 'Real model', DESK1_LABEL: 'Real' }, { mock: true });
  assert.equal(config.mock, true);
  assert.ok(config.desks.every((d) => d.configured && d.missing.length === 0));
  assert.deepEqual(config.desks.map((d) => d.label), ['JEV', 'Decision 1', 'Fast LLM']);
  assert.deepEqual(config.desks.map((d) => d.kind), ['systemone', 'systemone', 'llm']);
  assert.equal(loadConfig({ MOCK_MODE: 'true' }).mock, true);
});

test('invalid numbers fall back to defaults and are clamped', () => {
  const config = loadConfig({ PORT: 'abc', REQUEST_TIMEOUT_MS: '5', MAX_RETRIES: '99' });
  assert.equal(config.port, 3000);
  assert.equal(config.timeoutMs, 1000);
  assert.equal(config.maxRetries, 5);
});

test('publicConfig shows how each desk is called and never contains a secret, header or credential-bearing URL', () => {
  const config = loadConfig({
    KODEKEY_API_KEY: 'kk-TOPSECRET',
    FOUNDRY_ENDPOINT: HOST,
    FOUNDRY_API_KEY: 'fk-TOPSECRET',
    DESK2_URL: `${HOST}/openai/v1/responses`,
    DESK2_MODEL: 'm2',
    DESK3_MODEL: 'Microsoft-Decision-1',
  });
  const json = JSON.stringify(publicConfig(config));
  assert.ok(!json.includes('TOPSECRET'));
  assert.ok(!/authorization|api-key|upstream|chatUrl|responsesUrl|systemOneUrl/i.test(json));
  const desks = JSON.parse(json).desks;
  assert.deepEqual(desks.map((d) => d.api), [null, 'responses', null]);
  assert.deepEqual(desks.map((d) => d.mode), ['questions', null, 'systemone']);
  assert.equal(desks.length, 3);
  assert.equal(publicConfig(config, new Map([['DESK1', 'chat']]), new Map()).desks[0].mode, 'chat');
});

// --- Usage control configuration (U1: R7, R13, R14; KTD3, KTD10) ---

test('usage control is disabled by default and the default visitor allowance and test availability are still public', () => {
  const config = loadConfig({});
  assert.deepEqual(config.usage, {
    enabled: false,
    appService: false,
    visitorDailyLimit: 10,
    dailyGlobalRaces: null,
    tableEndpoint: null,
    tableName: 'RaceUsage',
    storageConnectionString: null,
    signingSecret: null,
    permitMinutes: 45,
    startsPerMinute: 6,
  });
  const pub = publicConfig(config);
  assert.deepEqual(pub.usage, { enabled: false, visitorDailyLimit: 10, testAvailable: true });
});

test('a fully specified enabled configuration parses the global cap, visitor limit, permit lifetime, table target and burst ceiling', () => {
  const config = loadConfig({
    USAGE_CONTROL_ENABLED: 'true',
    USAGE_DAILY_GLOBAL_RACES: '500',
    USAGE_TABLE_ENDPOINT: 'https://acct.table.core.windows.net',
    USAGE_TABLE_NAME: 'RaceUsageDev',
    USAGE_SIGNING_SECRET: 'a-stable-secret',
    USAGE_PERMIT_MINUTES: '60',
    USAGE_STARTS_PER_MINUTE: '12',
    USAGE_VISITOR_DAILY_LIMIT: '25',
  });
  assert.equal(config.usage.enabled, true);
  assert.equal(config.usage.dailyGlobalRaces, 500);
  assert.equal(config.usage.tableEndpoint, 'https://acct.table.core.windows.net');
  assert.equal(config.usage.tableName, 'RaceUsageDev');
  assert.equal(config.usage.permitMinutes, 60);
  assert.equal(config.usage.startsPerMinute, 12);
  assert.equal(config.usage.visitorDailyLimit, 25);
});

test('the visitor allowance defaults to 10 a day and USAGE_VISITOR_DAILY_LIMIT sets it, publicly too', () => {
  const base = { USAGE_CONTROL_ENABLED: 'true', USAGE_DAILY_GLOBAL_RACES: '100', USAGE_SIGNING_SECRET: 's', USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net' };
  assert.equal(loadConfig(base).usage.visitorDailyLimit, 10);
  assert.equal(loadConfig({ ...base, USAGE_VISITOR_DAILY_LIMIT: '' }).usage.visitorDailyLimit, 10);
  assert.equal(loadConfig({ ...base, USAGE_VISITOR_DAILY_LIMIT: '3' }).usage.visitorDailyLimit, 3);
  assert.equal(loadConfig({ ...base, USAGE_VISITOR_DAILY_LIMIT: ' 1000 ' }).usage.visitorDailyLimit, 1000);
  assert.equal(publicConfig(loadConfig({ ...base, USAGE_VISITOR_DAILY_LIMIT: '3' })).usage.visitorDailyLimit, 3);
});

test('enabled usage control rejects a visitor limit that is not a whole number from 1 to 1000', () => {
  const base = { USAGE_CONTROL_ENABLED: 'true', USAGE_DAILY_GLOBAL_RACES: '100', USAGE_SIGNING_SECRET: 's', USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net' };
  for (const bad of ['0', '-3', '2.5', 'ten', '1001']) {
    assert.throws(
      () => loadConfig({ ...base, USAGE_VISITOR_DAILY_LIMIT: bad }),
      (error) => error instanceof UsageConfigError && /USAGE_VISITOR_DAILY_LIMIT/.test(error.message),
      `USAGE_VISITOR_DAILY_LIMIT=${bad} should fail startup`,
    );
  }
});

test('a bad USAGE_VISITOR_DAILY_LIMIT is ignored while usage control is disabled', () => {
  assert.equal(loadConfig({ USAGE_VISITOR_DAILY_LIMIT: 'ten' }).usage.visitorDailyLimit, 10);
});

test('a local connection string is accepted outside App Service without a table endpoint', () => {
  const config = loadConfig({
    USAGE_CONTROL_ENABLED: 'true',
    USAGE_DAILY_GLOBAL_RACES: '10',
    USAGE_SIGNING_SECRET: 'secret',
    USAGE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
  });
  assert.equal(config.usage.storageConnectionString, 'UseDevelopmentStorage=true');
});

test('zero is a valid USAGE_DAILY_GLOBAL_RACES (emergency stop)', () => {
  const config = loadConfig({
    USAGE_CONTROL_ENABLED: 'true',
    USAGE_DAILY_GLOBAL_RACES: '0',
    USAGE_SIGNING_SECRET: 'secret',
    USAGE_TABLE_ENDPOINT: 'https://acct.table.core.windows.net',
  });
  assert.equal(config.usage.dailyGlobalRaces, 0);
});

test('enabled usage control rejects a missing global cap', () => {
  assert.throws(
    () => loadConfig({ USAGE_CONTROL_ENABLED: 'true', USAGE_SIGNING_SECRET: 's', USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net' }),
    (error) => error instanceof UsageConfigError && /USAGE_DAILY_GLOBAL_RACES/.test(error.message),
  );
});

test('enabled usage control rejects a negative global cap', () => {
  assert.throws(
    () => loadConfig({ USAGE_CONTROL_ENABLED: 'true', USAGE_DAILY_GLOBAL_RACES: '-1', USAGE_SIGNING_SECRET: 's', USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net' }),
    UsageConfigError,
  );
});

test('enabled usage control rejects a missing signing secret', () => {
  assert.throws(
    () => loadConfig({ USAGE_CONTROL_ENABLED: 'true', USAGE_DAILY_GLOBAL_RACES: '10', USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net' }),
    (error) => error instanceof UsageConfigError && /USAGE_SIGNING_SECRET/.test(error.message),
  );
});

test('enabled usage control rejects a missing storage target outside App Service', () => {
  assert.throws(
    () => loadConfig({ USAGE_CONTROL_ENABLED: 'true', USAGE_DAILY_GLOBAL_RACES: '10', USAGE_SIGNING_SECRET: 's' }),
    (error) => error instanceof UsageConfigError && /USAGE_TABLE_ENDPOINT/.test(error.message),
  );
});

test('enabled usage control rejects an invalid table name', () => {
  assert.throws(
    () =>
      loadConfig({
        USAGE_CONTROL_ENABLED: 'true',
        USAGE_DAILY_GLOBAL_RACES: '10',
        USAGE_SIGNING_SECRET: 's',
        USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net',
        USAGE_TABLE_NAME: '1-bad name!',
      }),
    (error) => error instanceof UsageConfigError && /USAGE_TABLE_NAME/.test(error.message),
  );
});

test('enabled usage control rejects out-of-range numeric settings', () => {
  assert.throws(
    () =>
      loadConfig({
        USAGE_CONTROL_ENABLED: 'true',
        USAGE_DAILY_GLOBAL_RACES: '10',
        USAGE_SIGNING_SECRET: 's',
        USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net',
        USAGE_PERMIT_MINUTES: '0',
      }),
    (error) => error instanceof UsageConfigError && /USAGE_PERMIT_MINUTES/.test(error.message),
  );
  assert.throws(
    () =>
      loadConfig({
        USAGE_CONTROL_ENABLED: 'true',
        USAGE_DAILY_GLOBAL_RACES: '10',
        USAGE_SIGNING_SECRET: 's',
        USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net',
        USAGE_STARTS_PER_MINUTE: '-5',
      }),
    (error) => error instanceof UsageConfigError && /USAGE_STARTS_PER_MINUTE/.test(error.message),
  );
});

test('enabled usage control collects every validation issue in one error', () => {
  assert.throws(
    () => loadConfig({ USAGE_CONTROL_ENABLED: 'true' }),
    (error) => error instanceof UsageConfigError && error.issues.length >= 3,
  );
});

test('App Service rejects a connection string and requires a table endpoint instead', () => {
  assert.throws(
    () =>
      loadConfig({
        USAGE_CONTROL_ENABLED: 'true',
        USAGE_DAILY_GLOBAL_RACES: '10',
        USAGE_SIGNING_SECRET: 's',
        USAGE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
        WEBSITE_SITE_NAME: 'ai-model-speed-race',
      }),
    (error) => error instanceof UsageConfigError && /USAGE_STORAGE_CONNECTION_STRING/.test(error.message) && /App Service/.test(error.message),
  );
  const config = loadConfig({
    USAGE_CONTROL_ENABLED: 'true',
    USAGE_DAILY_GLOBAL_RACES: '10',
    USAGE_SIGNING_SECRET: 's',
    USAGE_TABLE_ENDPOINT: 'https://acct.table.core.windows.net',
    WEBSITE_SITE_NAME: 'ai-model-speed-race',
  });
  assert.equal(config.usage.appService, true);
  assert.equal(config.usage.storageConnectionString, null);
});

test('publicConfig never exposes the signing secret, connection string or table endpoint', () => {
  const config = loadConfig({
    USAGE_CONTROL_ENABLED: 'true',
    USAGE_DAILY_GLOBAL_RACES: '10',
    USAGE_SIGNING_SECRET: 'TOPSECRETSIGNINGKEY',
    USAGE_TABLE_ENDPOINT: 'https://acct.table.core.windows.net',
  });
  const json = JSON.stringify(publicConfig(config));
  assert.ok(!json.includes('TOPSECRETSIGNINGKEY'));
  assert.ok(!/table.core.windows.net|signingSecret|storageConnectionString|tableEndpoint/i.test(json));
  assert.deepEqual(JSON.parse(json).usage, { enabled: true, visitorDailyLimit: 10, testAvailable: false });
});

test('mock mode keeps /api/test available even when usage control is enabled', () => {
  const config = loadConfig(
    { USAGE_CONTROL_ENABLED: 'true', USAGE_DAILY_GLOBAL_RACES: '10', USAGE_SIGNING_SECRET: 's', USAGE_TABLE_ENDPOINT: 'https://a.table.core.windows.net' },
    { mock: true },
  );
  assert.equal(publicConfig(config).usage.testAvailable, true);
});
