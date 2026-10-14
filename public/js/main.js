import { generatePapers } from '../../shared/rulebook.js';
import { DEFAULT_VISITOR_DAILY_LIMIT, QUEUE_SIZES, RACE_PERMIT_HEADER } from '../../shared/usage.js';
import { createAudio } from './audio.js';
import { PACE, Race } from './race.js';
import { Renderer } from './renderer.js';
import { renderAbout, renderCaseFile, renderResults, renderRulebook, renderSetup } from './ui.js';
import { fmtIndiaTime } from './util.js';

const $ = (id) => document.getElementById(id);
const JSON_HEADERS = { 'content-type': 'application/json' };
const STORAGE_KEY = 'checkpoint-one.settings';
const LINEUP_KEY = 'checkpoint-one.lineup';

const randomSeed = () => 1000 + Math.floor(Math.random() * 99000);

function loadSettings() {
  const defaults = { queueSize: 20, pace: 'standard', sound: false };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return {
      queueSize: QUEUE_SIZES.includes(saved.queueSize) ? saved.queueSize : defaults.queueSize,
      pace: PACE[saved.pace] ? saved.pace : defaults.pace,
      sound: Boolean(saved.sound),
    };
  } catch {
    return defaults;
  }
}

const state = {
  config: null,
  lineup: null,
  settings: { ...loadSettings(), seed: randomSeed() },
  race: null,
  selectedDesk: 0,
  tab: 'case',
  testState: null,
  // A persistent, accessible refusal/service notice (visitor/global/burst/unavailable): shown through #statusText,
  // not only a fading toast, and not distinguished by color alone (R12).
  raceNotice: null,
};

const audio = createAudio();
let renderer = null;
let toastTimer = null;
let panelFrame = 0;

// ---- Line-up -----------------------------------------------------------------------------------
// The server knows every model defined in .env (the catalog). The browser only chooses which of them sits at
// each desk, by name. URLs and keys never travel through this page. An older server has no catalog; then the
// line-up simply stays whatever .env says.

function loadLineup(config) {
  if (!config.catalog) return null;
  const known = new Set(config.catalog.map((entry) => entry.profile));
  try {
    const saved = JSON.parse(localStorage.getItem(LINEUP_KEY) ?? 'null');
    if (Array.isArray(saved) && saved.length === config.desks.length && saved.every((name) => known.has(name))) return saved;
  } catch {
    // An unreadable saved line-up falls back to the default.
  }
  return [...config.lineup];
}

function saveLineup() {
  try {
    const isDefault = state.lineup.every((name, index) => name === state.config.lineup[index]);
    if (isDefault) localStorage.removeItem(LINEUP_KEY);
    else localStorage.setItem(LINEUP_KEY, JSON.stringify(state.lineup));
  } catch {
    // Storage can be blocked; the line-up then lasts for this page view.
  }
}

/** The models at desks 1..3 as race desks: a catalog entry plus its desk position. */
function lineupDesks() {
  const { catalog } = state.config;
  if (!catalog || !state.lineup) return state.config.desks;
  return state.lineup.map((profile, index) => ({ ...catalog.find((entry) => entry.profile === profile), id: index + 1 }));
}

function changeLineup(index, profile) {
  state.lineup = state.lineup.map((name, position) => (position === index ? profile : name));
  saveLineup();
  state.testState = null;
  buildRace();
}

function resetLineup() {
  state.lineup = [...state.config.lineup];
  saveLineup();
  state.testState = null;
  buildRace();
}

/** Copies what the server resolved (call mode, API) from the catalog onto the desks of a race that has not started. */
function syncRaceDesks() {
  if (!state.race || !state.config.catalog) return;
  for (const desk of state.race.desks) {
    const entry = state.config.catalog.find((candidate) => candidate.profile === desk.profile);
    if (entry) Object.assign(desk, { mode: entry.mode, api: entry.api });
  }
}

// ---- API ---------------------------------------------------------------------------------------

/** The line-up the current race was built with, as the server wants it. Empty for an older server. */
const lineupBody = () => (state.config.catalog && state.race ? { profiles: state.race.desks.map((desk) => desk.profile) } : {});

/** The permit, if any, travels only in this dedicated header -- never a cookie, query string, or URL (R8, R9). */
const permitHeaders = (permit) => (permit ? { [RACE_PERMIT_HEADER]: permit } : {});

/** Parses the server's Error Contract body `{ error, code, resetAt? }` plus any `Retry-After`, for a failed response. */
async function parseApiFailure(response) {
  const json = await response.json().catch(() => null);
  const retryAfterHeader = response.headers.get('retry-after');
  return {
    code: json?.code ?? 'http',
    error: json?.error ?? `HTTP ${response.status}`,
    resetAt: json?.resetAt ?? null,
    retryAfterMs: retryAfterHeader ? Number(retryAfterHeader) * 1000 : null,
  };
}

/** Requests one race permit for a deliberate Start/Run again action (R1-R3); a no-op server answers `{enabled:false}`. */
async function authorizeRace({ runId, queueSize, profiles, signal }) {
  const body = { runId, queueSize, ...(state.config.catalog ? { profiles } : {}) };
  let response;
  try {
    response = await fetch('/api/races/start', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal });
  } catch (error) {
    if (signal?.aborted) return { ok: false, code: 'cancelled', error: 'Cancelled' };
    return { ok: false, code: 'usage_control_unavailable', error: `Cannot reach the game server: ${error.message}` };
  }
  if (!response.ok) return { ok: false, ...(await parseApiFailure(response)) };
  const json = await response.json();
  return { ok: true, permit: json.permit ?? null, resetAt: json.resetAt ?? null, expiresAt: json.expiresAt ?? null };
}

async function prepare({ signal, permit, operationId }) {
  const body = { ...lineupBody(), ...(operationId ? { operationId } : {}) };
  const headers = { ...JSON_HEADERS, ...permitHeaders(permit) };
  const response = await fetch('/api/prepare', { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { desks } = await response.json();
  for (const entry of desks) {
    const desk = state.race.desks.find((d) => d.id === entry.deskId);
    if (desk && entry.mode) desk.mode = entry.mode;
    if (desk && entry.api) desk.api = entry.api;
  }
  return desks;
}

async function decide({ deskId, paper, signal, permit, operationId }) {
  const profile = state.config.catalog ? state.race.desks.find((desk) => desk.id === deskId)?.profile : undefined;
  const body = { deskId, ...(profile ? { profile } : {}), paper: { id: paper.id, dossier: paper.dossier }, ...(operationId ? { operationId } : {}) };
  // Ground truth is only ever sent to the local server in simulation mode, where nothing leaves the machine.
  if (state.config.mock) body.paper.hint = { truth: paper.truth, violations: paper.violations };
  const headers = { ...JSON_HEADERS, ...permitHeaders(permit) };
  try {
    const response = await fetch('/api/decide', { method: 'POST', headers, body: JSON.stringify(body), signal });
    const json = await response.json().catch(() => null);
    if (!json) return { ok: false, code: 'server', status: response.status, error: `Game server answered HTTP ${response.status}` };
    // A structured Error Contract failure (e.g. race_permit_invalid, usage_control_unavailable) carries its own code;
    // an older/unrelated HTTP error falls back to the generic "http" code, as before.
    if (json.ok === undefined) return { ok: false, code: json.code ?? 'http', status: response.status, error: json.error ?? `HTTP ${response.status}`, resetAt: json.resetAt ?? null };
    return json;
  } catch (error) {
    if (signal?.aborted) return { ok: false, code: 'cancelled', error: 'Cancelled' };
    return { ok: false, code: 'client_network', status: 0, error: `Cannot reach the game server: ${error.message}` };
  }
}

async function refreshConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const fresh = await response.json();
  if (!state.config) {
    state.config = fresh;
    return;
  }
  state.config.mock = fresh.mock;
  for (const desk of fresh.desks) Object.assign(state.config.desks.find((d) => d.id === desk.id), desk);
  if (fresh.catalog && state.config.catalog) {
    for (const entry of fresh.catalog) Object.assign(state.config.catalog.find((known) => known.profile === entry.profile) ?? {}, entry);
  }
}

// ---- Race lifecycle ----------------------------------------------------------------------------

/** How many races this visitor gets per India day, from public config; falls back to the default (R1). */
const visitorDailyLimit = () => state.config?.usage?.visitorDailyLimit ?? DEFAULT_VISITOR_DAILY_LIMIT;

/**
 * Turns one structured Start refusal into a persistent, accessible message (R11, R12): visitor/global/burst/
 * unavailable each read distinctly, the India reset time is explicit, and nothing here depends on color alone.
 */
function authNoticeFor(result) {
  const resetText = fmtIndiaTime(result.resetAt);
  const retrySeconds = result.retryAfterMs ? Math.max(1, Math.ceil(result.retryAfterMs / 1000)) : null;
  // The raw ISO instant travels with the notice too (as a `title`, in updateToolbar) so a machine-readable
  // absolute timestamp survives alongside the human-readable India-time label (R12).
  const base = { resetAt: result.resetAt ?? null, kind: 'bad' };
  switch (result.code) {
    case 'visitor_daily_limit':
      return { ...base, text: `Daily limit reached: you have used all ${visitorDailyLimit()} races today.${resetText ? ` Your allowance resets ${resetText}.` : ''}` };
    case 'global_daily_limit':
      return { ...base, text: `This public demo has reached today's shared capacity.${resetText ? ` Capacity resets ${resetText}.` : ''} Please try again after that.` };
    case 'start_rate_limit':
      return { ...base, text: `Too many race starts from this connection.${retrySeconds ? ` Try again in about ${retrySeconds}s.` : ' Try again shortly.'}` };
    case 'usage_control_unavailable':
      return { ...base, text: 'Race setup is temporarily unavailable (a service problem, not a daily limit). Please try again shortly.' };
    default:
      return { ...base, text: result.reason || 'Could not start the race. Please try again.' };
  }
}

/** Sets/clears the persistent notice shown through #statusText (not only a toast) until the next Start attempt. */
function setRaceNotice(notice) {
  state.raceNotice = notice;
  updateToolbar();
}

function clearRaceNotice() {
  if (!state.raceNotice) return;
  state.raceNotice = null;
  updateToolbar();
}

function buildRace() {
  state.race?.reset();
  clearRaceNotice();
  const papers = generatePapers(state.settings.seed, state.settings.queueSize);
  // Usage control gates Start itself (R2, R3); mock and unprotected local mode omit `authorize` to keep today's behavior.
  const authorize = state.config.usage?.enabled ? authorizeRace : undefined;
  state.race = new Race({ desks: lineupDesks(), papers, decide, prepare, authorize, pace: state.settings.pace, onEvent });
  renderer?.resetVisuals();
  updateToolbar();
  renderTab();
}

async function startRace() {
  if (!state.race || state.race.status !== 'ready') return;
  audio.setEnabled(state.settings.sound);
  clearRaceNotice();
  const result = await state.race.start();
  if (!result.started) {
    if (result.authFailure) setRaceNotice(authNoticeFor(result));
    else if (result.reason) toast(result.reason, 'bad', 9000);
  } else if (result.permitRevoked) {
    // Mid-race permit loss (KTD4): the race already finished (its completed records are preserved); a new Start
    // will request a fresh permit, so the persistent notice says so instead of implying this one can be resumed.
    setRaceNotice({ kind: 'bad', text: `Race authorization was lost mid-race: ${result.permitRevoked.message} Completed results are kept below; start a new race to continue.` });
  }
}

function resetRace() {
  if (!state.race || state.race.status === 'ready') return;
  closeResults();
  clearRaceNotice();
  state.race.reset();
  renderTab();
}

function onEvent(type, data = {}) {
  renderer?.handleEvent(type, data);
  const deskIndex = data.run ? data.run.meta.id - 1 : -1;
  if (type === 'decision') {
    if (data.record.ok) audio.stamp(deskIndex, data.record.decision);
    else audio.error(deskIndex);
  } else if (type === 'desk-finished') {
    audio.fanfare(data.rank, deskIndex);
  } else if (type === 'desk-aborted') {
    audio.error(deskIndex);
    toast(`${data.run.meta.label} stopped: ${data.reason}`, 'bad', 9000);
  } else if (type === 'done') {
    openResults();
  }
  if (type === 'status') {
    updateToolbar();
    if (state.tab === 'setup') renderTab();
  }
  scheduleCasefile();
}

// ---- Toolbar, tabs, panel ----------------------------------------------------------------------

const STATUS_TEXT = {
  ready: 'Ready. All three desks get the identical queue.',
  authorizing: 'Requesting authorization to start this race...',
  warming: 'Briefing the approvers: opening connections (not timed)...',
  running: 'Shift in progress. Click a lane to inspect that desk.',
  finished: 'Shift complete.',
};

function updateToolbar() {
  const race = state.race;
  if (!race) return;
  $('startBtn').disabled = race.status !== 'ready';
  $('resetBtn').disabled = race.status === 'ready';
  $('resultsBtn').disabled = !race.runs.some((run) => run.records.length > 0);
  const anyReady = race.runs.some((run) => run.phase !== 'offline');
  const statusNode = $('statusText');
  // A visitor/global/burst/unavailable refusal is shown here persistently while ready (not only as a fading toast,
  // and not by color alone): it replaces the normal "Ready." text until the next Start attempt clears it (R12).
  if (state.raceNotice && race.status === 'ready') {
    statusNode.textContent = state.raceNotice.text;
    statusNode.classList.toggle('bad', state.raceNotice.kind === 'bad');
    // The India-time label is human-readable; the exact machine-readable instant is kept available here too.
    statusNode.title = state.raceNotice.resetAt ?? '';
  } else {
    statusNode.classList.remove('bad');
    statusNode.title = '';
    statusNode.textContent = anyReady || state.config.mock ? STATUS_TEXT[race.status] : 'No desk is configured yet. Paste your keys into .env and restart the server, or run "npm run demo".';
  }
}

function raceLocked() {
  return state.race.status === 'authorizing' || state.race.status === 'warming' || state.race.status === 'running';
}

function scheduleCasefile() {
  if (state.tab !== 'case' || panelFrame) return;
  panelFrame = requestAnimationFrame(() => {
    panelFrame = 0;
    renderTab();
  });
}

function renderTab() {
  const panel = $('panel');
  if (!state.race) return;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const active = tab.dataset.tab === state.tab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  if (state.tab === 'case') renderCaseFile(panel, { race: state.race, deskIndex: state.selectedDesk });
  else if (state.tab === 'rules') renderRulebook(panel);
  else if (state.tab === 'about') renderAbout(panel);
  else {
    renderSetup(panel, {
      config: state.config,
      lineup: state.lineup,
      settings: state.settings,
      locked: raceLocked(),
      onSettings: changeSettings,
      onLineup: changeLineup,
      onResetLineup: resetLineup,
      onNewSeed: () => changeSettings({ seed: randomSeed() }),
      onTest: testConnections,
      testState: state.testState,
    });
  }
}

function showTab(tab) {
  state.tab = tab;
  renderTab();
}

function selectDesk(index) {
  state.selectedDesk = index;
  if (state.tab !== 'case') state.tab = 'case';
  renderTab();
}

function changeSettings(patch) {
  Object.assign(state.settings, patch);
  try {
    const { queueSize, pace, sound } = state.settings;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ queueSize, pace, sound }));
  } catch {
    // Storage can be blocked; settings then simply last for this page view.
  }
  audio.setEnabled(state.settings.sound);
  if ('queueSize' in patch || 'pace' in patch || 'seed' in patch) buildRace();
  else renderTab();
}

async function testConnections() {
  // Defence in depth: the button is already hidden when live usage control is enabled (ui.js), and the route
  // itself answers 404 (KTD9); this just avoids firing a request the server will refuse anyway.
  if (state.config.usage?.testAvailable === false) return;
  state.testState = { running: true };
  renderTab();
  try {
    const response = await fetch('/api/test', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(lineupBody()) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.testState = { desks: (await response.json()).desks };
    await refreshConfig();
    syncRaceDesks();
  } catch (error) {
    state.testState = { error: `The test could not run: ${error.message}` };
  }
  renderTab();
}

function toast(message, kind = 'info', ms = 4500) {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

// ---- Results -----------------------------------------------------------------------------------

function closeResults() {
  const dialog = $('results');
  if (dialog.open) dialog.close();
}

function openResults() {
  const dialog = $('results');
  renderResults(dialog, {
    race: state.race,
    config: state.config,
    summary: state.race.summary(),
    onRunAgain: () => {
      closeResults();
      state.settings.seed = randomSeed();
      buildRace();
      startRace();
    },
    onExport: exportResults,
    onClose: closeResults,
  });
  if (!dialog.open) dialog.showModal();
}

function exportResults() {
  const { race, config, settings } = state;
  const summary = race.summary();
  const data = {
    app: 'checkpoint-one',
    generatedAt: new Date().toISOString(),
    mode: config.mock ? 'simulated' : 'live',
    settings: { queueSize: settings.queueSize, pace: settings.pace, seed: settings.seed, animationOverheadMs: summary.overheadMs },
    desks: summary.rows.map((row) => ({
      id: row.desk.id, label: row.desk.label, profile: row.desk.profile ?? null, provider: row.desk.provider, model: row.desk.model, kind: row.desk.kind,
      rank: row.rank, outcome: row.outcome, note: row.note || null,
      clearedInMs: row.rank ? Math.round(row.elapsedMs) : null, speedupVsSlowest: row.speedup ?? null,
      avgLatencyMs: row.avgMs, p95LatencyMs: row.p95Ms, totalModelTimeMs: Math.round(row.modelMs),
      accuracy: row.accuracy, errors: row.errors, wronglyApproved: row.falseApprovals, wronglyRejected: row.falseRejections,
      tokensIn: row.tokensIn, tokensOut: row.tokensOut, tokensCached: row.tokensCached, costUsd: row.cost, costBasis: row.costBasis, decisionsPerMinute: row.perMinute,
    })),
    papers: race.papers.map((paper) => ({ id: paper.id, truth: paper.truth, violations: paper.violations })),
    decisions: Object.fromEntries(
      race.runs.map((run) => [
        run.meta.id,
        run.records.map((r) => ({
          paperId: r.paperId, decision: r.decision, correct: r.correct, latencyMs: r.latencyMs, attempts: r.attempts, error: r.error,
          tokensIn: r.usage?.inputTokens ?? null, tokensOut: r.usage?.outputTokens ?? null, tokensCached: r.usage?.cachedTokens ?? null,
          costUsd: r.cost?.usd ?? null, costBasis: r.cost?.basis ?? null,
        })),
      ]),
    ),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = Object.assign(document.createElement('a'), { href: url, download: 'checkpoint-one-results.json' });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Boot --------------------------------------------------------------------------------------

function toggleFocus() {
  const on = document.body.classList.toggle('focus');
  const button = $('focusBtn');
  button.textContent = on ? 'Show panel' : 'Focus view';
  button.setAttribute('aria-pressed', String(on));
}

function wire() {
  // Associates the persistent #statusText live region with the control it refuses/limits, for assistive tech (R12).
  $('startBtn').setAttribute('aria-describedby', 'statusText');
  $('startBtn').addEventListener('click', startRace);
  $('resetBtn').addEventListener('click', resetRace);
  $('resultsBtn').addEventListener('click', openResults);
  $('focusBtn').addEventListener('click', toggleFocus);
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => showTab(tab.dataset.tab));

  const canvas = $('stage');
  canvas.addEventListener('click', (event) => {
    const lane = renderer.laneAt(event);
    if (lane >= 0) selectDesk(lane);
  });

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.('input, select, textarea, dialog')) return;
    if (event.key === ' ' && event.target.tagName !== 'BUTTON') {
      event.preventDefault();
      startRace();
    } else if (event.key.toLowerCase() === 'r') resetRace();
    else if (event.key.toLowerCase() === 'f') toggleFocus();
    else if (['1', '2', '3'].includes(event.key)) selectDesk(Number(event.key) - 1);
  });

  new ResizeObserver(() => renderer.resize()).observe(canvas);
}

async function boot() {
  try {
    await refreshConfig();
  } catch (error) {
    $('statusText').textContent = `Cannot reach the game server (${error.message}). Is "npm start" running?`;
    return;
  }
  audio.setEnabled(state.settings.sound);
  state.lineup = loadLineup(state.config);
  const badge = $('modeBadge');
  badge.textContent = state.config.mock ? 'SIMULATED MODELS' : 'LIVE MODELS';
  badge.className = `badge ${state.config.mock ? 'badge-sim' : 'badge-live'}`;

  renderer = new Renderer($('stage'), () => ({ race: state.race, config: state.config, settings: state.settings, selectedDesk: state.selectedDesk }));
  buildRace();
  wire();
  renderer.start();
}

boot();
