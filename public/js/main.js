import { generatePapers } from '../../shared/rulebook.js';
import { createAudio } from './audio.js';
import { PACE, Race } from './race.js';
import { Renderer } from './renderer.js';
import { renderAbout, renderCaseFile, renderResults, renderRulebook, renderSetup } from './ui.js';

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
      queueSize: [10, 20, 30, 50].includes(saved.queueSize) ? saved.queueSize : defaults.queueSize,
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

async function prepare({ signal }) {
  const response = await fetch('/api/prepare', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(lineupBody()), signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { desks } = await response.json();
  for (const entry of desks) {
    const desk = state.race.desks.find((d) => d.id === entry.deskId);
    if (desk && entry.mode) desk.mode = entry.mode;
    if (desk && entry.api) desk.api = entry.api;
  }
  return desks;
}

async function decide({ deskId, paper, signal }) {
  const profile = state.config.catalog ? state.race.desks.find((desk) => desk.id === deskId)?.profile : undefined;
  const body = { deskId, ...(profile ? { profile } : {}), paper: { id: paper.id, dossier: paper.dossier } };
  // Ground truth is only ever sent to the local server in simulation mode, where nothing leaves the machine.
  if (state.config.mock) body.paper.hint = { truth: paper.truth, violations: paper.violations };
  try {
    const response = await fetch('/api/decide', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal });
    const json = await response.json().catch(() => null);
    if (!json) return { ok: false, code: 'server', status: response.status, error: `Game server answered HTTP ${response.status}` };
    if (json.ok === undefined) return { ok: false, code: 'http', status: response.status, error: json.error ?? `HTTP ${response.status}` };
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

function buildRace() {
  state.race?.reset();
  const papers = generatePapers(state.settings.seed, state.settings.queueSize);
  state.race = new Race({ desks: lineupDesks(), papers, decide, prepare, pace: state.settings.pace, onEvent });
  renderer?.resetVisuals();
  updateToolbar();
  renderTab();
}

async function startRace() {
  if (!state.race || state.race.status !== 'ready') return;
  audio.setEnabled(state.settings.sound);
  const result = await state.race.start();
  if (!result.started && result.reason) toast(result.reason, 'bad', 9000);
}

function resetRace() {
  if (!state.race || state.race.status === 'ready') return;
  closeResults();
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
  ready: 'Ready. Both queues are identical for every desk.',
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
  $('statusText').textContent = anyReady || state.config.mock ? STATUS_TEXT[race.status] : 'No desk is configured yet. Paste your keys into .env and restart the server, or run "npm run demo".';
}

function raceLocked() {
  return state.race.status === 'warming' || state.race.status === 'running';
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
      tokensIn: row.tokensIn, tokensOut: row.tokensOut, estimatedCostUsd: row.cost, decisionsPerMinute: row.perMinute,
    })),
    papers: race.papers.map((paper) => ({ id: paper.id, truth: paper.truth, violations: paper.violations })),
    decisions: Object.fromEntries(
      race.runs.map((run) => [run.meta.id, run.records.map((r) => ({ paperId: r.paperId, decision: r.decision, correct: r.correct, latencyMs: r.latencyMs, attempts: r.attempts, error: r.error }))]),
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
