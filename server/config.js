import { LIST_PRICES, listPriceFor } from '../shared/pricing.js';
import { DEFAULT_VISITOR_DAILY_LIMIT } from '../shared/usage.js';

const PROVIDER_LABELS = { kodekey: 'KodeKey gateway', foundry: 'Azure AI Foundry' };
const JEV_MODES = ['auto', 'questions', 'systemone'];
const LLM_APIS = ['auto', 'chat', 'responses'];
const SYSTEM_ONE_MODEL = /jev|decision[-_ ]?1/i;
const MAX_DESKS = 3;

const USAGE_TABLE_NAME_DEFAULT = 'RaceUsage';
// Conservative enough to outlast a reasoning-model race with retries (see "Different race sizes and retries" risk).
const USAGE_PERMIT_MINUTES_DEFAULT = 45;
const USAGE_STARTS_PER_MINUTE_DEFAULT = 6;
const USAGE_PERMIT_MINUTES_RANGE = { min: 1, max: 180 };
const USAGE_STARTS_PER_MINUTE_RANGE = { min: 1, max: 1000 };
const USAGE_VISITOR_DAILY_LIMIT_RANGE = { min: 1, max: 1000 };
// Azure table names: 3-63 chars, start with a letter, alphanumeric only.
const TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9]{2,62}$/;

const DESK_DEFAULTS = {
  // KodeKloud's gateway lists JEV as "typesafe/jev-1.13.0" (npm run check shows the ids your key can use).
  1: { provider: 'kodekey', model: 'typesafe/jev-1.13.0', label: 'JEV' },
  2: { provider: 'foundry', model: '', label: '' },
  3: { provider: 'foundry', model: '', label: '' },
};

// Simulated models for `npm run demo`. `sim` picks the latency and accuracy profile in providers/mock.js and `price` the
// list price (shared/pricing.js) of the real model it imitates, so a simulated race shows costs too.
// The default line-up mirrors the live one (two System One models and a small LLM); the others can be seated from Setup.
const MOCK_MODELS = {
  JEV: { label: 'JEV', model: 'jev-sim', provider: 'kodekey', sim: 'jev', price: 'jev' },
  DECISION1: { label: 'Decision 1', model: 'decision-1-sim', provider: 'foundry', sim: 'decision1', price: 'decision-1' },
  FAST_LLM: { label: 'Fast LLM', model: 'fast-llm-sim', provider: 'foundry', sim: 'fast', price: 'gpt-4.1-mini' },
  LARGE_LLM: { label: 'Large LLM', model: 'large-llm-sim', provider: 'foundry', sim: 'large', price: 'gpt-4.1' },
  REASONING_LLM: { label: 'Reasoning LLM', model: 'reasoning-llm-sim', provider: 'foundry', sim: 'reasoning', price: 'grok-4.7' },
};
const MOCK_LINEUP = ['JEV', 'DECISION1', 'FAST_LLM'];

const text = (value) => (value ?? '').trim();
const trimSlash = (value) => value.replace(/\/+$/, '');
const isTrue = (value) => /^(1|true|yes|on)$/i.test(text(value));

function number(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (text(value) === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** True when `raw` is a finite number inside `range` (and a whole number when `integer` is set). */
function inRange(raw, { min, max }, { integer = false } = {}) {
  const value = Number(raw);
  return Number.isFinite(value) && (!integer || Number.isInteger(value)) && value >= min && value <= max;
}

function optionalNumber(value) {
  return text(value) === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

function parseUrl(raw) {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

const isAzureHost = (hostname) => /\.(azure\.com|azure\.net)$/i.test(hostname);
const isLegacyServerless = (hostname) => /\.models\.ai\.azure\.com$/i.test(hostname);

/** Deployment name embedded in a pasted Target URI (/openai/deployments/<name>/...), if any. */
export function foundryDeploymentHint(raw) {
  const match = /\/openai\/deployments\/([^/?#]+)/i.exec(raw);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * Reads a pasted endpoint. A URL that ends in a known route (as the Foundry portal shows it) tells
 * us which API to speak and is used verbatim. Anything else is treated as a bare resource endpoint.
 */
export function classifyEndpoint(raw) {
  const url = parseUrl(raw);
  if (!url) return null;
  // API keys are scoped to the Foundry *resource*. A project-scoped URL (/api/projects/<name>/openai/v1/...)
  // is therefore called on the resource itself, which is where keys are accepted.
  url.pathname = url.pathname.replace(/^\/api\/projects\/[^/]+/i, '') || '/';
  const path = url.pathname.replace(/\/+$/, '');
  const api = /\/responses$/i.test(path) ? 'responses' : /\/chat\/completions$/i.test(path) ? 'chat' : /\/systemone$/i.test(path) ? 'systemone' : null;
  return { origin: url.origin, hostname: url.hostname, api, href: api ? url.href : null, deployment: foundryDeploymentHint(raw) };
}

/** Default routes of a Foundry / Azure OpenAI resource, used when only the resource endpoint is known. */
export function foundryRoutes(origin, hostname) {
  return {
    // Legacy serverless endpoints already speak the OpenAI shape at /v1.
    chat: isLegacyServerless(hostname) ? `${origin}/v1/chat/completions` : `${origin}/openai/v1/chat/completions`,
    responses: `${origin}/openai/v1/responses`,
    systemone: `${origin}/providers/microsoft/v1/systemone`,
  };
}

/** The OpenAI-compatible v1 base URL of a resource endpoint (kept for callers that need only a base). */
export function foundryBaseUrl(raw) {
  const info = classifyEndpoint(raw);
  if (!info) return null;
  return isLegacyServerless(info.hostname) ? `${info.origin}/v1` : `${info.origin}/openai/v1`;
}

/**
 * Azure hosts accept the key as an `api-key` header on every route (it is the documented form for the
 * System One route), and as a bearer token on the OpenAI v1 routes. The alternative is kept for a one-time
 * retry on 401, so a mismatch between route and header style heals itself.
 */
export function azureAuth(hostname, apiKey) {
  const keyHeader = { 'api-key': apiKey };
  const bearer = { authorization: `Bearer ${apiKey}` };
  if (!isAzureHost(hostname)) return { headers: bearer, altHeaders: null };
  return isLegacyServerless(hostname) ? { headers: bearer, altHeaders: keyHeader } : { headers: keyHeader, altHeaders: bearer };
}

const hasProfileVars = (env, name) => Object.keys(env).some((key) => key.startsWith(`MODEL_${name}_`));

/**
 * The USD-per-1M-token price a model is charged at. A price in .env wins over the built-in list price, field by field.
 * The list's cached-input rate only applies while the input rate is the list's too; with your own input price, cached
 * tokens cost the normal input rate unless you also set a cached one.
 */
function resolvePrice(env, listed) {
  const fromEnv = env.in !== null || env.cachedIn !== null || env.out !== null;
  if (!fromEnv && !listed) return { priceIn: null, priceOut: null, priceCachedIn: null, priceSource: null };
  return {
    priceIn: env.in ?? listed?.in ?? null,
    priceOut: env.out ?? listed?.out ?? null,
    priceCachedIn: env.cachedIn ?? (env.in === null ? listed?.cachedIn : null) ?? null,
    priceSource: fromEnv ? 'env' : 'list',
  };
}

const PROFILE_KEY = /^MODEL_(.+)_(?:LABEL|MODEL|URL|PROVIDER|API|MODE|KIND|REASONING_EFFORT|TEMPERATURE|MAX_TOKENS|PRICE_IN|PRICE_CACHED_IN|PRICE_OUT)$/;

/** Every usable model profile in the environment (MODEL_<NAME>_*), in the order the variables appear. */
function discoverProfiles(env) {
  const names = new Set();
  for (const key of Object.keys(env)) {
    const name = PROFILE_KEY.exec(key)?.[1];
    // A profile needs a model or a URL to be of any use; this also keeps unrelated MODEL_* variables out.
    if (name && (text(env[`MODEL_${name}_MODEL`]) || text(env[`MODEL_${name}_URL`]))) names.add(name);
  }
  return [...names];
}

/** LINEUP=JEV,GPT41MINI,GROK47 names the model profiles (MODEL_<NAME>_*) that sit at desks 1..3 by default. */
function parseLineup(env, warnings) {
  const names = text(env.LINEUP)
    .split(',')
    .map((name) => name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_'))
    .filter(Boolean);
  if (names.length > MAX_DESKS) warnings.push(`LINEUP lists ${names.length} models but the hall has ${MAX_DESKS} desks; only the first ${MAX_DESKS} are used.`);
  const lineup = names.slice(0, MAX_DESKS);
  for (const name of lineup) {
    if (!hasProfileVars(env, name) && !/^DESK[123]$/.test(name)) warnings.push(`LINEUP names "${name}" but no MODEL_${name}_* variables are defined.`);
  }
  return lineup;
}

/**
 * Builds the settings of one model profile (MODEL_<NAME>_*). A name like DESK2 without MODEL_DESK2_* variables is
 * the older per-desk style (DESK2_*). The result has no desk id: that is assigned when the model is seated at a desk.
 */
function buildDesk(name, env, providers, { mock, warnings }) {
  const legacyId = mock || hasProfileVars(env, name) ? 0 : Number(/^DESK([123])$/.exec(name)?.[1] ?? 0);
  const prefix = legacyId ? `DESK${legacyId}_` : `MODEL_${name}_`;
  const read = (key) => (mock ? '' : text(env[`${prefix}${key}`]));
  const mockModel = mock ? MOCK_MODELS[name] : null;
  const defaults = mockModel ?? (legacyId ? DESK_DEFAULTS[legacyId] : {});

  const rawUrl = read('URL');
  const target = rawUrl ? classifyEndpoint(rawUrl) : null;
  if (rawUrl && !target) warnings.push(`${prefix}URL is not a valid URL.`);

  let provider = read('PROVIDER').toLowerCase();
  if (!provider) {
    if (target) provider = isAzureHost(target.hostname) ? 'foundry' : 'kodekey';
    else provider = defaults.provider || (/jev/i.test(read('MODEL')) ? 'kodekey' : 'foundry');
  }
  // A desk's default model only applies while it still points at its default provider.
  let model = read('MODEL') || (provider === defaults.provider ? defaults.model : '') || target?.deployment || '';
  if (!model && provider === 'foundry') model = foundryDeploymentHint(providers.foundry.endpoint);
  if (mock) model = defaults.model;

  const kindOverride = read('KIND').toLowerCase();
  const kind =
    kindOverride === 'systemone' || kindOverride === 'llm'
      ? kindOverride
      : target?.api === 'systemone' || SYSTEM_ONE_MODEL.test(model)
        ? 'systemone'
        : 'llm';

  let api = read('API').toLowerCase();
  if (api && !LLM_APIS.includes(api)) {
    warnings.push(`${prefix}API="${api}" is not one of ${LLM_APIS.join(', ')}; using "chat".`);
    api = '';
  }
  api = target?.api === 'chat' || target?.api === 'responses' ? target.api : api || 'chat';

  let mode = read('MODE').toLowerCase();
  if (mode && !JEV_MODES.includes(mode)) {
    warnings.push(`${prefix}MODE="${mode}" is not one of ${JEV_MODES.join(', ')}; using the default.`);
    mode = '';
  }
  if (!mode) mode = target?.api === 'systemone' ? 'systemone' : target?.api === 'chat' ? 'questions' : provider === 'foundry' ? 'systemone' : 'questions';

  const label = read('LABEL') || defaults.label || model || (legacyId ? `Desk ${legacyId}` : name);

  const missing = [];
  const upstream = { chatUrl: '', responsesUrl: '', systemOneUrl: '', headers: {}, altHeaders: null };
  if (provider === 'kodekey') {
    const { baseUrl, apiKey, jevPath } = providers.kodekey;
    if (!apiKey) missing.push('KODEKEY_API_KEY');
    if (!baseUrl) missing.push('KODEKEY_BASE_URL');
    Object.assign(upstream, {
      chatUrl: target?.api === 'chat' ? target.href : `${baseUrl}/chat/completions`,
      responsesUrl: target?.api === 'responses' ? target.href : `${baseUrl}/responses`,
      systemOneUrl: target?.api === 'systemone' ? target.href : `${baseUrl}${jevPath}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } else if (provider === 'foundry') {
    const source = target ?? providers.foundry.endpointInfo;
    if (!providers.foundry.apiKey) missing.push('FOUNDRY_API_KEY');
    if (!source) missing.push(rawUrl ? `${prefix}URL` : 'FOUNDRY_ENDPOINT');
    else {
      const routes = foundryRoutes(source.origin, source.hostname);
      Object.assign(
        upstream,
        {
          chatUrl: target?.api === 'chat' ? target.href : routes.chat,
          responsesUrl: target?.api === 'responses' ? target.href : routes.responses,
          systemOneUrl: target?.api === 'systemone' ? target.href : routes.systemone,
        },
        azureAuth(source.hostname, providers.foundry.apiKey),
      );
    }
  } else {
    missing.push(`${prefix}PROVIDER (must be "kodekey" or "foundry")`);
  }
  if (!model) missing.push(`${prefix}MODEL`);

  const price = resolvePrice(
    { in: optionalNumber(read('PRICE_IN')), cachedIn: optionalNumber(read('PRICE_CACHED_IN')), out: optionalNumber(read('PRICE_OUT')) },
    mockModel ? LIST_PRICES[mockModel.price] : listPriceFor(model),
  );
  return {
    label,
    provider,
    providerLabel: PROVIDER_LABELS[provider] ?? provider,
    model,
    kind,
    mode,
    api: kind === 'llm' ? api : null,
    envPrefix: prefix,
    profile: name,
    sim: mockModel?.sim ?? null,
    maxTokens: number(read('MAX_TOKENS'), 4096, { min: 16, max: 32768 }),
    temperature: optionalNumber(read('TEMPERATURE')),
    reasoningEffort: read('REASONING_EFFORT').toLowerCase(),
    ...price,
    configured: mock || missing.length === 0,
    missing: mock ? [] : missing,
    upstream,
  };
}

/** App Service sets these for every instance; their presence means managed identity, not a connection string, must be used (KTD3). */
export function isAppServiceEnvironment(env) {
  return Boolean(text(env.WEBSITE_INSTANCE_ID) || text(env.WEBSITE_SITE_NAME));
}

/** Thrown when USAGE_CONTROL_ENABLED=true but the Configuration Contract is incomplete (KTD10: fail startup, not false-safe). */
export class UsageConfigError extends Error {
  constructor(issues) {
    super(`Usage control is enabled but misconfigured: ${issues.join('; ')}`);
    this.name = 'UsageConfigError';
    this.issues = issues;
  }
}

/**
 * Parses the Configuration Contract (R13). Usage control defaults to disabled and never requires Azure.
 * When enabled, every required setting is validated up front so a protected deployment cannot start in
 * a false-safe state (KTD7, KTD10); zero is a valid USAGE_DAILY_GLOBAL_RACES (an emergency stop).
 */
function parseUsage(env) {
  const enabled = isTrue(env.USAGE_CONTROL_ENABLED);
  const appService = isAppServiceEnvironment(env);
  const tableName = text(env.USAGE_TABLE_NAME) || USAGE_TABLE_NAME_DEFAULT;
  const tableEndpoint = text(env.USAGE_TABLE_ENDPOINT) || null;
  const storageConnectionString = text(env.USAGE_STORAGE_CONNECTION_STRING) || null;
  const signingSecret = text(env.USAGE_SIGNING_SECRET) || null;
  const permitMinutes = number(env.USAGE_PERMIT_MINUTES, USAGE_PERMIT_MINUTES_DEFAULT, USAGE_PERMIT_MINUTES_RANGE);
  const startsPerMinute = number(env.USAGE_STARTS_PER_MINUTE, USAGE_STARTS_PER_MINUTE_DEFAULT, USAGE_STARTS_PER_MINUTE_RANGE);

  const usage = {
    enabled,
    appService,
    visitorDailyLimit: Math.trunc(number(env.USAGE_VISITOR_DAILY_LIMIT, DEFAULT_VISITOR_DAILY_LIMIT, USAGE_VISITOR_DAILY_LIMIT_RANGE)),
    dailyGlobalRaces: null,
    tableEndpoint,
    tableName,
    // A connection string is a local-development escape hatch only; App Service must use the managed identity.
    storageConnectionString: appService ? null : storageConnectionString,
    signingSecret,
    permitMinutes,
    startsPerMinute,
  };
  if (!enabled) return usage;

  const issues = [];
  const rawCap = text(env.USAGE_DAILY_GLOBAL_RACES);
  const cap = Number(rawCap);
  if (rawCap === '' || !Number.isInteger(cap) || cap < 0) {
    issues.push('USAGE_DAILY_GLOBAL_RACES must be a non-negative integer when usage control is enabled (0 is a valid emergency stop).');
  } else {
    usage.dailyGlobalRaces = cap;
  }

  if (!signingSecret) issues.push('USAGE_SIGNING_SECRET is required when usage control is enabled.');
  if (!TABLE_NAME_RE.test(tableName)) issues.push(`USAGE_TABLE_NAME "${tableName}" is not a valid Azure table name.`);

  if (appService) {
    if (storageConnectionString) issues.push('USAGE_STORAGE_CONNECTION_STRING is not allowed on App Service; grant the managed identity access and set USAGE_TABLE_ENDPOINT instead.');
    if (!tableEndpoint) issues.push('USAGE_TABLE_ENDPOINT is required when usage control is enabled on App Service.');
  } else if (!tableEndpoint && !storageConnectionString) {
    issues.push('USAGE_TABLE_ENDPOINT (or a local USAGE_STORAGE_CONNECTION_STRING) is required when usage control is enabled.');
  }

  const rawPermit = text(env.USAGE_PERMIT_MINUTES);
  if (rawPermit !== '' && !inRange(rawPermit, USAGE_PERMIT_MINUTES_RANGE)) {
    issues.push(`USAGE_PERMIT_MINUTES must be a number of minutes between ${USAGE_PERMIT_MINUTES_RANGE.min} and ${USAGE_PERMIT_MINUTES_RANGE.max}.`);
  }
  const rawStarts = text(env.USAGE_STARTS_PER_MINUTE);
  if (rawStarts !== '' && !inRange(rawStarts, USAGE_STARTS_PER_MINUTE_RANGE)) {
    issues.push(`USAGE_STARTS_PER_MINUTE must be a number between ${USAGE_STARTS_PER_MINUTE_RANGE.min} and ${USAGE_STARTS_PER_MINUTE_RANGE.max}.`);
  }
  const rawVisitorLimit = text(env.USAGE_VISITOR_DAILY_LIMIT);
  if (rawVisitorLimit !== '' && !inRange(rawVisitorLimit, USAGE_VISITOR_DAILY_LIMIT_RANGE, { integer: true })) {
    issues.push(`USAGE_VISITOR_DAILY_LIMIT must be a whole number between ${USAGE_VISITOR_DAILY_LIMIT_RANGE.min} and ${USAGE_VISITOR_DAILY_LIMIT_RANGE.max}.`);
  }

  if (issues.length) throw new UsageConfigError(issues);
  return usage;
}

/** Reads the environment into a config object. Secrets live only in `desk.upstream`. */
export function loadConfig(env = process.env, { mock = false } = {}) {
  const warnings = [];
  const useMock = mock || isTrue(env.MOCK_MODE);

  const kodekeyJevPath = text(env.KODEKEY_JEV_PATH);
  const foundryEndpoint = text(env.FOUNDRY_ENDPOINT);
  const endpointInfo = foundryEndpoint ? classifyEndpoint(foundryEndpoint) : null;
  if (foundryEndpoint && !endpointInfo) warnings.push('FOUNDRY_ENDPOINT is not a valid URL.');
  const providers = {
    kodekey: {
      baseUrl: trimSlash(text(env.KODEKEY_BASE_URL) || 'https://api.ai.kodekloud.com/v1'),
      apiKey: text(env.KODEKEY_API_KEY),
      jevPath: kodekeyJevPath ? (kodekeyJevPath.startsWith('/') ? kodekeyJevPath : `/${kodekeyJevPath}`) : '/systemone',
    },
    foundry: { endpoint: foundryEndpoint, endpointInfo, apiKey: text(env.FOUNDRY_API_KEY) },
  };

  // The default line-up is LINEUP, topped up with the older DESKn_* settings for any desk it does not name.
  const named = useMock ? MOCK_LINEUP : parseLineup(env, warnings);
  const lineup = [1, 2, 3].map((id) => named[id - 1] ?? `DESK${id}`);
  const profiles = new Map();
  const add = (name) => {
    if (!profiles.has(name)) profiles.set(name, buildDesk(name, env, providers, { mock: useMock, warnings }));
  };
  lineup.forEach(add);
  (useMock ? Object.keys(MOCK_MODELS) : discoverProfiles(env)).forEach(add);

  return {
    port: number(env.PORT, 3000, { min: 1, max: 65535 }),
    host: text(env.HOST) || '127.0.0.1',
    mock: useMock,
    timeoutMs: number(env.REQUEST_TIMEOUT_MS, 60000, { min: 1000, max: 600000 }),
    maxRetries: number(env.MAX_RETRIES, 2, { min: 0, max: 5 }),
    // Every model that can be seated at a desk, and who sits where unless the browser picks otherwise.
    catalog: [...profiles.values()],
    lineup,
    desks: lineup.map((name, index) => ({ ...profiles.get(name), id: index + 1 })),
    warnings,
    usage: parseUsage(env),
  };
}

/** The browser-safe view of the config: no URLs with credentials, no headers, no keys. */
export function publicConfig(config, resolvedModes = new Map(), resolvedApis = new Map()) {
  const describe = (desk) => ({
    id: desk.id,
    profile: desk.profile,
    label: desk.label,
    provider: desk.provider,
    providerLabel: desk.providerLabel,
    model: desk.model,
    kind: desk.kind,
    mode: desk.kind === 'systemone' ? (config.mock ? 'simulated' : (resolvedModes.get(desk.profile) ?? desk.mode)) : null,
    api: desk.kind === 'llm' ? (config.mock ? 'simulated' : (resolvedApis.get(desk.profile) ?? desk.api)) : null,
    configured: desk.configured,
    missing: desk.missing,
    envPrefix: desk.envPrefix,
    priceIn: desk.priceIn,
    priceCachedIn: desk.priceCachedIn,
    priceOut: desk.priceOut,
    priceSource: desk.priceSource,
  });
  return {
    mock: config.mock,
    timeoutMs: config.timeoutMs,
    lineup: config.lineup,
    catalog: config.catalog.map(describe),
    desks: config.desks.map(describe),
    // Only what the browser needs to explain itself (R12); never storage settings, secrets or raw identifiers.
    usage: {
      enabled: config.usage.enabled,
      visitorDailyLimit: config.usage.visitorDailyLimit,
      // KTD9: the live public test route is unavailable once live usage control is enabled; mock mode keeps it.
      testAvailable: config.mock || !config.usage.enabled,
    },
  };
}
