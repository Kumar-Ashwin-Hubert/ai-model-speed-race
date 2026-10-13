// npm run check  ->  tests every configured desk with real calls and explains what to fix.
import { loadConfig } from '../server/config.js';
import { loadEnv } from '../server/env.js';
import { requestJson, withAuthFallback } from '../server/http.js';
import { probeJevMode } from '../server/providers/jev.js';
import { probeLlmApi } from '../server/providers/llm.js';
import { createRuntime } from '../server/runtime.js';

loadEnv();
const config = loadConfig(process.env, { mock: process.argv.includes('--mock') });
const runtime = createRuntime(config);
const { redact } = runtime;

const line = (text = '') => console.log(text);
const ms = (value) => `${Math.round(value)} ms`;
const API_LABELS = { chat: 'Chat Completions API', responses: 'Responses API', auto: 'API: auto-detect' };
const describe = (desk) => (desk.kind === 'systemone' ? `System One, call mode: ${desk.mode}` : API_LABELS[desk.api]);
let failures = 0;

line('\nAI Model Speed Race: connection check\n');
if (config.mock) line('MOCK MODE: nothing below is a real model call.\n');
for (const warning of config.warnings) line(`Warning: ${warning}`);

async function listGatewayModels(desk) {
  const baseUrl = desk.upstream.chatUrl.replace(/\/chat\/completions$/, '');
  try {
    const { json } = await requestJson(`${baseUrl}/models`, { method: 'GET', headers: desk.upstream.headers, timeoutMs: 15000 });
    if (!Array.isArray(json?.data)) {
      line('  The gateway did not return an OpenAI-style model list from /models.');
      return;
    }
    const ids = json.data.map((model) => model.id).filter(Boolean);
    const jevIds = ids.filter((id) => /jev|typesafe|system.?one/i.test(id));
    line(`  Gateway lists ${ids.length} models for this key.`);
    line(jevIds.length ? `  JEV-like model ids: ${jevIds.join(', ')}` : '  No JEV-like model id found in that list.');
    if (jevIds.length && !ids.includes(desk.model)) line(`  -> "${desk.model}" is not in the list. Set ${desk.envPrefix}MODEL=${jevIds[0]} in .env.`);
    if (!jevIds.length && !ids.includes(desk.model)) line(`  -> "${desk.model}" is not in the list either; ask KodeKloud for the exact JEV model id.`);
  } catch (error) {
    line(`  Could not list models: ${redact(error.message)}`);
  }
}

const deploymentLists = new Map();
const printedResources = new Set();

/**
 * Lists the deployments of a Foundry resource with the same key (best effort, once per resource) and checks that
 * this desk's model is one of them. Catches the most common mistake: the model name used instead of the deployment name.
 */
async function checkFoundryDeployments(desk) {
  const origin = new URL(desk.upstream.chatUrl).origin;
  if (!deploymentLists.has(origin)) {
    try {
      const { json } = await withAuthFallback(desk, (headers) =>
        requestJson(`${origin}/openai/deployments?api-version=2024-10-21`, { method: 'GET', headers, timeoutMs: 15000 }),
      );
      const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.value) ? json.value : null;
      deploymentLists.set(origin, items ? items.map((item) => ({ name: item.id ?? item.name, model: item.model ?? item.properties?.model?.name })).filter((item) => item.name) : null);
    } catch (error) {
      deploymentLists.set(origin, `could not list deployments (${redact(error.message)}); this check is optional`);
    }
  }
  const found = deploymentLists.get(origin);
  if (typeof found === 'string') return line(`  Note: ${found}.`);
  if (!found) return line('  Note: the resource did not return a deployment list; skipping the deployment-name check.');
  if (!printedResources.has(origin)) {
    printedResources.add(origin);
    line(`  Deployments on this resource: ${found.map((item) => (item.model && item.model !== item.name ? `${item.name} (${item.model})` : item.name)).join(', ') || 'none'}`);
  }
  if (!found.some((item) => item.name === desk.model)) {
    const similar = found.filter((item) => item.model && desk.model && item.model.toLowerCase() === desk.model.toLowerCase()).map((item) => item.name);
    line(`  -> "${desk.model}" is not a deployment name on this resource.${similar.length ? ` Did you mean ${similar.join(' or ')}?` : ''} Set ${desk.envPrefix}MODEL to the deployment name.`);
  }
}

/** Detection the game does silently before a race, printed step by step here. Returns false when the desk cannot work. */
async function detect(desk) {
  if (config.mock) return true;
  try {
    if (desk.kind === 'systemone' && desk.mode === 'auto') {
      const { mode, log } = await probeJevMode(desk, { timeoutMs: config.timeoutMs });
      runtime.jevModes.set(desk.profile, mode);
      for (const entry of log) line(`  detect ${entry.mode.padEnd(9)} ${entry.ok ? 'works' : `no: ${redact(entry.error)}`}`);
      line(`  Using call mode "${mode}" (pin it with ${desk.envPrefix}MODE=${mode}).`);
    } else if (desk.kind === 'llm' && desk.api === 'auto') {
      const { api, log } = await probeLlmApi(desk, { timeoutMs: config.timeoutMs });
      runtime.llmApis.set(desk.profile, api);
      for (const entry of log) line(`  detect ${entry.api.padEnd(9)} ${entry.ok ? 'works' : `no: ${redact(entry.error)}`}`);
      line(`  Using the ${API_LABELS[api]} (pin it with ${desk.envPrefix}API=${api}, or paste the portal URL into ${desk.envPrefix}URL).`);
    }
    return true;
  } catch (error) {
    for (const entry of error.probeLog ?? []) line(`  detect ${(entry.mode ?? entry.api).padEnd(9)} no: ${redact(entry.error)}`);
    line(`  FAILED: ${redact(error.message)}`);
    line(
      desk.kind === 'systemone' && desk.provider === 'kodekey'
        ? `  Hint: KodeKey serves JEV as a typesafe/... chat model that takes the typed questions in response_format.\n        Check the model id above (${desk.envPrefix}MODEL), or set ${desk.envPrefix}MODE / ${desk.envPrefix}URL if your gateway differs.\n`
        : `  Hint: check the key, and that ${desk.envPrefix}MODEL is the deployment name shown in the Foundry portal.\n`,
    );
    return false;
  }
}

for (const desk of config.desks) {
  line(`Desk ${desk.id}: ${desk.label}  (${desk.providerLabel}, model "${desk.model || 'not set'}", ${describe(desk)})`);
  if (!desk.configured) {
    line(`  SKIPPED: set ${desk.missing.join(', ')} in .env\n`);
    failures += 1;
    continue;
  }

  if (!config.mock && desk.provider === 'kodekey') await listGatewayModels(desk);
  if (!config.mock && desk.provider === 'foundry') await checkFoundryDeployments(desk);
  if (!(await detect(desk))) {
    failures += 1;
    continue;
  }

  const [report] = await runtime.test({ deskIds: [desk.id] });
  for (const check of report.checks) {
    if (!check.ok) {
      line(`  [FAIL] ${check.name}: ${check.error}`);
      failures += 1;
    } else {
      line(`  [${check.correct ? 'PASS' : 'WARN'}] ${check.name}: ${check.got.toUpperCase()} (expected ${check.expected.toUpperCase()}) in ${ms(check.latencyMs)}`);
      if (!check.correct) line('         The call works, but the model disagreed with the sample. Fine for a connectivity check.');
    }
  }
  line();
}

if (failures === 0) line('All configured desks answered. Run "npm start" and open the game.\n');
else line(`${failures} problem(s) found. Fix them in .env and run "npm run check" again.\n`);
process.exit(failures === 0 ? 0 : 1);
