import { FIELDS, RULES, SAMPLE_PAPERS, buildLlmMessages, buildSystemOneQuestions, dossierToText } from '../../shared/rulebook.js';
import { PACE } from './race.js';
import { DESK_ACCENTS, el, fill, fmtMoney, fmtMs, fmtPercent, fmtTokens } from './util.js';

const chip = (label, kind = 'neutral') => el('span', { class: `chip chip-${kind}` }, label);
const section = (title, ...children) => el('section', { class: 'section' }, el('h4', {}, title), ...children);
const muted = (value) => el('p', { class: 'muted' }, value);

const API_LABELS = { chat: 'Chat Completions API', responses: 'Responses API', auto: 'API auto-detect', simulated: 'simulated' };
const callingLabel = (desk) => (desk.mode ? `call mode: ${desk.mode}` : desk.api ? (API_LABELS[desk.api] ?? desk.api) : null);

function decisionChip(record) {
  if (!record.ok) return chip('ERROR', 'warn');
  return record.decision === 'approve' ? chip('APPROVED', 'ok') : chip('REJECTED', 'bad');
}

const truthLabel = (paper) => (paper.truth === 'approve' ? 'APPROVE' : `REJECT (${paper.violations.join(', ')})`);

// ---- Case file ---------------------------------------------------------------------------------

function dossierTable(paper) {
  return el('dl', { class: 'dossier' }, FIELDS.flatMap(([key, label]) => [el('dt', {}, label), el('dd', {}, paper.dossier[key])]));
}

function ruleBars(detail) {
  return el(
    'div',
    { class: 'rules' },
    RULES.map((rule) => {
      const p = detail.probabilities?.[rule.id] ?? 0;
      return el(
        'div',
        { class: `rule${p >= 0.5 ? ' violated' : ''}` },
        el('span', { class: 'rule-name' }, rule.title),
        el('span', { class: 'bar' }, el('span', { class: 'fill', style: { width: `${Math.round(p * 100)}%` } })),
        el('span', { class: 'pct' }, `${Math.round(p * 100)}%`),
      );
    }),
  );
}

function decisionBlock(record, paper) {
  const meta = [fmtMs(record.latencyMs)];
  if (record.attempts > 1) meta.push(`${record.attempts} attempts`);
  if (record.usage) meta.push(`${record.usage.inputTokens} in / ${record.usage.outputTokens} out tokens`);

  const verdict = !record.ok
    ? el('p', { class: 'verdict bad' }, record.error)
    : record.correct
      ? el('p', { class: 'verdict good' }, `Correct. Ground truth: ${truthLabel(paper)}`)
      : el('p', { class: 'verdict bad' }, `Wrong. Ground truth: ${truthLabel(paper)}`);

  const detail = record.detail;
  return el(
    'div',
    { class: 'decision' },
    el('div', { class: 'decision-head' }, decisionChip(record), el('span', { class: 'muted' }, `#${record.paperId}  ${meta.join('  -  ')}`)),
    verdict,
    detail?.kind === 'systemone'
      ? el('div', {}, ruleBars(detail), el('p', { class: 'muted small' }, `Confidence ${fmtPercent(detail.confidence)}. Each bar is the probability that the rule is violated, from one parallel Noul question.`))
      : detail?.reply
        ? el('p', { class: 'muted small' }, 'Model reply: ', el('code', {}, detail.reply))
        : null,
  );
}

function recentList(run, race) {
  const rows = run.records.slice(-8).reverse();
  if (rows.length === 0) return muted('Nothing decided yet.');
  return el(
    'ul',
    { class: 'recent' },
    rows.map((record) => {
      const paper = race.papers.find((p) => p.id === record.paperId);
      return el(
        'li',
        {},
        el('span', { class: 'rid' }, `#${record.paperId}`),
        decisionChip(record),
        el('span', { class: 'rms' }, fmtMs(record.latencyMs)),
        el('span', { class: record.correct ? 'mark good' : 'mark bad' }, record.correct ? 'right' : record.ok ? `wrong, was ${paper?.truth}` : 'failed'),
      );
    }),
  );
}

function statusChip(run) {
  const map = { ready: ['Ready', 'neutral'], stepping: ['Calling next applicant', 'neutral'], reviewing: ['Reviewing', 'accent'], stamping: ['Stamping', 'accent'], finished: [`Queue cleared (#${run.rank})`, 'ok'], aborted: ['Stopped', 'bad'], offline: ['Offline', 'bad'] };
  const [label, kind] = map[run.phase] ?? ['Idle', 'neutral'];
  return chip(label, kind);
}

export function renderCaseFile(container, { race, deskIndex }) {
  const run = race.runs[deskIndex];
  const desk = run.meta;
  const last = run.records[run.records.length - 1];
  const lastPaper = last ? race.papers.find((p) => p.id === last.paperId) : null;
  const atWindow = run.queue[0];
  const subtitle = [desk.providerLabel, desk.model || 'no model', callingLabel(desk)].filter(Boolean).join('  -  ');

  fill(container, 
    el('div', { class: 'cf-head' }, el('h3', {}, `Desk ${desk.id}: ${desk.label}`), statusChip(run)),
    muted(subtitle),
    run.note ? el('p', { class: 'verdict bad' }, run.note) : null,
    section('At the window', atWindow ? dossierTable(atWindow) : muted('Nobody is waiting.')),
    section('Last decision', last ? decisionBlock(last, lastPaper) : muted('No decision yet. Start the shift.')),
    section('Recent decisions', recentList(run, race)),
  );
}

// ---- Rulebook ----------------------------------------------------------------------------------

export function renderRulebook(container) {
  const [system, user] = buildLlmMessages(SAMPLE_PAPERS.reject);
  const questions = buildSystemOneQuestions();
  const viaKodeKey = { model: 'typesafe/jev-1.13.0', messages: [{ role: 'user', content: dossierToText(SAMPLE_PAPERS.reject) }], response_format: { type: 'questions', questions } };
  const native = { model: 'jev-latest', state: SAMPLE_PAPERS.reject, questions };
  fill(container, 
    el('h3', {}, 'The rulebook'),
    muted('Reject an application if ANY rule is violated, otherwise approve it. Every desk applies the same rules to the same applications, in the same order.'),
    el('ol', { class: 'rulelist' }, RULES.map((rule) => el('li', {}, el('strong', {}, rule.title), el('span', {}, rule.text)))),
    el('details', {}, el('summary', {}, 'What each LLM desk receives'), el('pre', {}, `${system.content}\n\n--- application ---\n${user.content}`), muted('Chat Completions sends this as a system and a user message. The Responses API sends the same text as `instructions` and `input`.')),
    el(
      'details',
      {},
      el('summary', {}, 'What JEV receives (typed questions)'),
      muted('Through KodeKey the questions travel in a chat completions request (response_format type "questions"). The answers come back as a JSON map in the message content.'),
      el('pre', {}, JSON.stringify(viaKodeKey, null, 2)),
      muted('The native System One request, used by the TypeSafe API and by Microsoft Decision 1 on Foundry:'),
      el('pre', {}, JSON.stringify(native, null, 2)),
      muted('JEV scores every question in parallel. The game then composes the decision in code: reject when any rule is violated. That is how TypeSafe recommends using it: atomic questions, logic in code.'),
    ),
    muted('Applications avoid arithmetic, date maths and counting on purpose. Those are documented weak spots for jev-1.13 and would turn the race into a test of something else.'),
  );
}

// ---- About JEV ---------------------------------------------------------------------------------

const link = (href, label) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label);

export function renderAbout(container) {
  fill(container, 
    el('h3', {}, 'About JEV'),
    el('p', {}, 'JEV is the first "System One" model from TypeSafe AI (early access 15 September 2026, hosted API public since 21 September 2026). It does not write text. You send a state and typed questions; it answers each one in parallel with probabilities and a calibrated confidence.'),
    section('Why it fits this game', el('p', {}, 'Approvals are bounded, high-volume decisions. Every extra second of model time is a longer queue. One JEV request can carry all six rule checks at once, and adding questions barely changes the response time.')),
    section(
      'What TypeSafe claims',
      el('ul', {}, [
        el('li', {}, 'End-to-end answers in 70-500 ms.'),
        el('li', {}, '40-200x faster and 40-400x cheaper than frontier LLMs on comparable tasks.'),
        el('li', {}, '$0.042 per million input tokens, output free.'),
        el('li', {}, 'Typed outputs only, so no parsing and no format errors.'),
      ]),
      muted('These are vendor claims, partly from the vendor\'s own workflows. The race measures your live latency, accuracy and cost instead.'),
    ),
    section(
      'Know the limits',
      el('ul', {}, [
        el('li', {}, 'TypeSafe reports roughly mid-tier LLM accuracy on its own 4-workflow benchmark (about 68%).'),
        el('li', {}, 'jev-1.13 reads literally and is weak at arithmetic, dates, counting and multi-hop reasoning.'),
        el('li', {}, 'It returns numbers, not explanations. It is not for chat or text generation.'),
      ]),
    ),
    section(
      'Also on Azure AI Foundry',
      el('p', {}, 'Microsoft-Decision-1 is a Microsoft model in the same class: you send a state and typed questions (noul, choice, score) and get calibrated probabilities back, with no explanations. It uses the same request shape as System One, so it can sit at any desk.'),
      el('ul', { class: 'links' }, [el('li', {}, link('https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision', 'Microsoft Learn: Deploy and use Microsoft-Decision-1'))]),
    ),
    section(
      'Sources',
      el('ul', { class: 'links' }, [
        el('li', {}, link('https://typesafe.ai/blog/introducing-system-one-models-and-jev', 'TypeSafe: Introducing System One models and Jev')),
        el('li', {}, link('https://docs.typesafe.ai/introduction', 'TypeSafe docs: Introduction')),
        el('li', {}, link('https://docs.typesafe.ai/model-jaggedness/jev-1.13', 'TypeSafe docs: jev-1.13 jaggedness')),
        el('li', {}, link('https://www.datacamp.com/blog/system-one-models-jev', 'DataCamp: Jev explained')),
        el('li', {}, link('https://en.wikipedia.org/wiki/Jev_(AI_model)', 'Wikipedia: Jev (AI model)')),
      ]),
    ),
  );
}

// ---- Setup -------------------------------------------------------------------------------------

function testResults(testState) {
  if (!testState) return null;
  if (testState.running) return muted('Sending a clean and a bad sample application through every desk...');
  if (testState.error) return el('p', { class: 'verdict bad' }, testState.error);
  return el(
    'div',
    { class: 'tests' },
    testState.desks.map((desk) =>
      el(
        'div',
        { class: 'test' },
        el('div', { class: 'test-head' }, el('strong', {}, `Desk ${desk.deskId}`), desk.skipped ? chip('SKIPPED', 'warn') : chip(desk.ok ? 'REACHABLE' : 'FAILED', desk.ok ? 'ok' : 'bad'), desk.mode ? chip(`mode: ${desk.mode}`, 'neutral') : null),
        desk.skipped ? muted(desk.error) : null,
        ...(desk.checks ?? []).map((check) =>
          el('p', { class: `small ${check.ok ? '' : 'bad'}` }, check.ok ? `${check.name}: ${check.got.toUpperCase()} (${check.correct ? 'as expected' : `expected ${check.expected.toUpperCase()}`}) in ${fmtMs(check.latencyMs)}` : `${check.name}: ${check.error}`),
        ),
      ),
    ),
  );
}

const deskStatus = (desk, config) => (desk.configured ? chip(config.mock ? 'simulated' : 'configured', 'ok') : chip(`missing ${desk.missing.join(', ')}`, 'bad'));

const modelDescription = (desk) => [desk.providerLabel, callingLabel(desk)].filter(Boolean).join(' - ');

/** One picker per desk, offering every model defined in .env. Nothing but a model's name leaves this page. */
function lineupSection({ config, lineup, locked, onLineup, onResetLineup }) {
  const { catalog } = config;
  if (!catalog || !lineup) {
    return section(
      'Desk lineup',
      el(
        'ul',
        { class: 'lineup' },
        config.desks.map((desk) => el('li', {}, el('strong', {}, `Desk ${desk.id}: ${desk.label}`), el('span', { class: 'muted small' }, [`${desk.providerLabel} - ${desk.model || 'no model'}`, callingLabel(desk)].filter(Boolean).join(' - ')), deskStatus(desk, config))),
      ),
      muted('This server is older than the page, so it cannot offer a model choice yet. Restart it with "npm start" to pick the models here. Until then the lineup comes from .env.'),
    );
  }
  const byProfile = new Map(catalog.map((entry) => [entry.profile, entry]));
  const isDefault = lineup.every((profile, index) => profile === config.lineup[index]);
  return section(
    'Desk lineup',
    lineup.map((profile, index) => {
      const seated = byProfile.get(profile);
      return el(
        'div',
        { class: 'lineup-row' },
        el(
          'label',
          { class: 'lineup-pick' },
          el('span', { class: 'dot', style: { background: DESK_ACCENTS[index] } }),
          el('span', { class: 'desk-name' }, `Desk ${index + 1}`),
          el(
            'select',
            { name: `desk${index + 1}`, 'aria-label': `Model at desk ${index + 1}`, disabled: locked, onchange: (event) => onLineup(index, event.target.value) },
            catalog.map((entry) => el('option', { value: entry.profile, selected: entry.profile === profile, disabled: !entry.configured && entry.profile !== profile }, `${entry.label} - ${entry.model || 'no model'}${entry.configured ? '' : ' (not configured)'}`)),
          ),
        ),
        el('div', { class: 'lineup-meta' }, el('span', { class: 'muted small' }, modelDescription(seated)), deskStatus(seated, config)),
      );
    }),
    el('div', { class: 'lineup-foot' }, el('button', { class: 'btn small', disabled: locked || isDefault, onclick: onResetLineup }, 'Use the .env lineup')),
    muted('Any model defined in .env can sit at any desk, and the same model can sit at several. Keys stay on the server and never reach this page. To add a model, define a MODEL_<NAME>_* group in .env and restart the server.'),
  );
}

export function renderSetup(container, { config, lineup, settings, locked, onSettings, onLineup, onResetLineup, onNewSeed, onTest, testState }) {
  const select = (name, options, value) =>
    el('select', { name, disabled: locked, onchange: (event) => onSettings({ [name]: name === 'queueSize' ? Number(event.target.value) : event.target.value }) },
      options.map(([optionValue, label]) => el('option', { value: optionValue, selected: String(optionValue) === String(value) }, label)));

  fill(container, 
    el('h3', {}, 'Setup'),
    lineupSection({ config, lineup, locked, onLineup, onResetLineup }),
    section(
      'Race settings',
      el('label', { class: 'field' }, el('span', {}, 'Applicants per desk'), select('queueSize', [[10, '10'], [20, '20'], [30, '30'], [50, '50']], settings.queueSize)),
      el('label', { class: 'field' }, el('span', {}, 'Animation pace'), select('pace', Object.values(PACE).map((p) => [p.id, `${p.label} (${p.stepMs + p.stampMs} ms)`]), settings.pace)),
      el('label', { class: 'field' }, el('span', {}, 'Queue seed'), el('input', { type: 'number', name: 'seed', value: settings.seed, min: 1, max: 999999, disabled: locked, onchange: (event) => onSettings({ seed: Math.max(1, Math.min(999999, Number(event.target.value) || 1)) }) }), el('button', { class: 'btn small', disabled: locked, onclick: onNewSeed }, 'New seed')),
      el('label', { class: 'field check' }, el('input', { type: 'checkbox', checked: settings.sound, onchange: (event) => onSettings({ sound: event.target.checked }) }), el('span', {}, 'Sound effects')),
      muted('The animation overhead is the same for every desk and is shown in the results. Benchmark pace removes it entirely, so only model latency decides the race.'),
    ),
    section(
      'Connections',
      el('button', { class: 'btn', disabled: locked || testState?.running, onclick: onTest }, testState?.running ? 'Testing...' : config.mock ? 'Test simulated desks' : 'Test connections'),
      muted(config.mock ? 'Mock mode: no real calls are made.' : 'Sends two tiny sample applications through every configured desk using your real keys.'),
      testResults(testState),
    ),
  );
}

// ---- Results -----------------------------------------------------------------------------------

const speedupText = (value) => (value === null || value === undefined ? '-' : `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}x`);

function headline(summary) {
  const { ranked, rows } = summary;
  if (ranked.length === 0) {
    const stuck = rows.every((row) => row.outcome === 'offline' || row.outcome === 'aborted');
    return stuck ? 'No desk could finish its queue. Fix the errors below, then run "npm run check" to test every connection.' : 'No desk has cleared its queue yet.';
  }
  const winner = ranked[0];
  if (ranked.length === 1) return `${winner.desk.label} cleared ${summary.queueSize} applicants in ${fmtMs(winner.elapsedMs)}.`;
  const slowest = ranked[ranked.length - 1];
  return `${winner.desk.label} cleared ${summary.queueSize} applicants in ${fmtMs(winner.elapsedMs)}: ${speedupText(winner.speedup)} faster than ${slowest.desk.label} (${fmtMs(slowest.elapsedMs)}).`;
}

function retryNotes(rows) {
  return rows
    .map((row) => ({ row, retried: row.run.records.filter((record) => record.attempts > 1).length }))
    .filter(({ retried }) => retried > 0)
    .map(({ row, retried }) =>
      el('li', { class: 'warn' }, `${row.desk.label} needed a retry on ${retried} of ${row.done} calls (rate limits or transient errors). The waiting time is included in its latency; a higher quota would make it faster.`),
    );
}

function speedBars(summary) {
  const { ranked } = summary;
  if (ranked.length < 2) return null;
  const slowest = Math.max(...ranked.map((row) => row.elapsedMs));
  return el(
    'div',
    { class: 'speedbars', 'aria-label': 'Time to clear the queue' },
    ranked.map((row) =>
      el(
        'div',
        { class: 'speedbar' },
        el('span', { class: 'sb-label' }, row.desk.label),
        el('span', { class: 'sb-track' }, el('span', { class: 'sb-fill', style: { width: `${Math.max(1.5, (row.elapsedMs / slowest) * 100)}%`, background: DESK_ACCENTS[row.desk.id - 1] } })),
        el('span', { class: 'sb-time' }, fmtMs(row.elapsedMs)),
      ),
    ),
  );
}

function disagreementTable(race) {
  const byDesk = race.runs.map((run) => new Map(run.records.map((record) => [record.paperId, record])));
  const rows = race.papers.filter((paper) => byDesk.some((map) => map.has(paper.id) && !map.get(paper.id).correct));
  if (rows.length === 0) return muted('Every decision matched the ground truth.');
  const cell = (record) => (record ? el('td', { class: record.correct ? 'good' : 'bad' }, record.ok ? record.decision.toUpperCase() : 'ERROR') : el('td', { class: 'muted' }, '-'));
  return el(
    'table',
    { class: 'table compact' },
    el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Ground truth'), ...race.runs.map((run) => el('th', {}, run.meta.label)))),
    el('tbody', {}, rows.map((paper) => el('tr', {}, el('td', {}, `#${paper.id}`), el('td', {}, truthLabel(paper)), ...byDesk.map((map) => cell(map.get(paper.id)))))),
  );
}

export function renderResults(dialog, { race, config, summary, onRunAgain, onExport, onClose }) {
  const running = race.status !== 'finished';
  const rows = [...summary.rows].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.desk.id - b.desk.id);
  const cells = (row) => [
    el('td', {}, row.rank ? String(row.rank) : '-'),
    el('td', {}, el('strong', {}, row.desk.label), el('div', { class: 'muted small' }, row.desk.model || ''), row.note && !row.rank ? el('div', { class: 'bad small' }, row.note) : null),
    el('td', {}, row.rank ? fmtMs(row.elapsedMs) : '-'),
    el('td', {}, row.rank ? speedupText(row.speedup) : '-'),
    el('td', {}, fmtMs(row.avgMs)),
    el('td', {}, fmtMs(row.p95Ms)),
    el('td', {}, row.perMinute ? `${row.perMinute.toFixed(row.perMinute < 100 ? 1 : 0)}/min` : '-'),
    el('td', {}, `${fmtPercent(row.accuracy)}${row.falseApprovals ? ` (${row.falseApprovals} wrongly approved)` : ''}`),
    el('td', {}, fmtTokens(row.tokensIn + row.tokensOut)),
    el('td', {}, fmtMoney(row.cost), row.cost !== null && row.done > 0 ? el('div', { class: 'muted small' }, `${fmtMoney((row.cost / row.done) * 1000)} per 1k decisions`) : null),
  ];

  fill(dialog, 
    el('div', { class: 'dialog-body' },
      el('h2', {}, running ? 'Shift report (race in progress)' : 'Shift report'),
      el('p', { class: 'headline' }, headline(summary)),
      speedBars(summary),
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['Rank', 'Approver', 'Cleared in', 'Speed-up', 'Avg decision', 'P95', 'Throughput', 'Accuracy', 'Tokens', 'Cost'].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows.map((row) => el('tr', { class: row.rank === 1 ? 'winner' : '' }, cells(row)))),
      ),
      el('ul', { class: 'notes' }, [
        el('li', {}, `Wall-clock time includes a fixed ${summary.overheadMs} ms of animation per applicant for every desk (${summary.pace.label} pace). Avg decision and P95 are pure model latency.`),
        el('li', {}, 'Latency is measured server-side around each model call, retries included. Connection warm-up and one-off call-mode detection are excluded.'),
        el('li', {}, 'Accuracy is checked against each application\'s hidden ground truth; failed calls count as wrong. Cost uses token usage and the prices in .env (JEV: published list price).'),
        rows.some((row) => row.cost === null) ? el('li', {}, 'Cost shows n/a for desks without DESKn_PRICE_IN and DESKn_PRICE_OUT in .env. Add your model prices there to compare cost as well as speed.') : null,
        ...retryNotes(rows),
        config.mock ? el('li', { class: 'warn' }, 'SIMULATED RUN: the delays are modelled on live runs, but none of these numbers is a measurement of a real model.') : null,
      ]),
      el('details', {}, el('summary', {}, 'Decisions that did not match the ground truth'), disagreementTable(race)),
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn primary', onclick: onRunAgain }, 'Run again with a new queue'),
        el('button', { class: 'btn', onclick: onExport }, 'Export JSON'),
        el('button', { class: 'btn', onclick: onClose }, 'Close'),
      ),
    ),
  );
}
