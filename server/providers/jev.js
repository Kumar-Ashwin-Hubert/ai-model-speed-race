import { SAMPLE_PAPERS, buildSystemOneQuestions, dossierToText } from '../../shared/rulebook.js';
import { UpstreamError, postChat, requestJson, withAuthFallback } from '../http.js';
import { decideFromProbabilities, extractAnswers, extractText, probabilitiesFromAnswers, withBilling } from '../decision.js';

/**
 * How a System One model can be reached:
 *  - questions  OpenAI chat completions with the typed questions in `response_format` (KodeKey, LiteLLM's TypeSafe
 *               provider). The application is the user message; the answers come back as JSON in the message content.
 *  - systemone  the native endpoint: { model, state, questions } -> { answers, usage } (TypeSafe's own API and
 *               Microsoft-Decision-1 on Foundry).
 * "auto" tries them in this order once, outside the timed race.
 */
const JEV_PROBE_ORDER = ['questions', 'systemone'];

function buildSystemOneBody(desk, dossier) {
  return { model: desk.model, state: dossier, questions: buildSystemOneQuestions() };
}

function buildQuestionsBody(desk, dossier) {
  return {
    model: desk.model,
    messages: [{ role: 'user', content: dossierToText(dossier) }],
    response_format: { type: 'questions', questions: buildSystemOneQuestions() },
  };
}

function interpretJevReply(json, mode) {
  const answers = extractAnswers(json);
  if (!answers) {
    const content = extractText(json?.choices?.[0]?.message?.content).trim();
    throw new UpstreamError(content ? `the reply holds no System One answers: "${content.slice(0, 80)}"` : 'empty reply, no System One answers', { code: 'invalid_output', status: 200 });
  }
  const result = decideFromProbabilities(probabilitiesFromAnswers(answers));
  return {
    decision: result.decision,
    detail: { kind: 'systemone', mode, probabilities: result.probabilities, violated: result.violated, confidence: result.confidence },
  };
}

export async function callJevMode(mode, desk, dossier, options) {
  const { json, headers } =
    mode === 'systemone'
      ? await withAuthFallback(desk, (authHeaders) => requestJson(desk.upstream.systemOneUrl, { headers: authHeaders, body: buildSystemOneBody(desk, dossier), ...options }))
      : await withAuthFallback(desk, (authHeaders) => postChat(desk.upstream.chatUrl, { headers: authHeaders, body: buildQuestionsBody(desk, dossier), ...options }));
  return withBilling(json, headers, desk.model, () => interpretJevReply(json, mode));
}

/**
 * Finds the first mode that yields usable answers. Auth problems and transient failures are
 * rethrown untouched: they say nothing about which mode is right.
 */
export async function probeJevMode(desk, options) {
  const log = [];
  for (const mode of JEV_PROBE_ORDER) {
    try {
      const result = await callJevMode(mode, desk, SAMPLE_PAPERS.reject, options);
      log.push({ mode, ok: true, decision: result.decision });
      return { mode, log };
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.retryable || error.status === 401 || error.status === 403 || error.code === 'cancelled') throw error;
      log.push({ mode, ok: false, status: error.status, error: error.message });
    }
  }
  const summary = log.map((entry) => `${entry.mode} -> ${entry.error}`).join(' | ');
  const failure = new UpstreamError(`No working way to call "${desk.model}" was found. ${summary}`, { status: log[0]?.status ?? 0, code: 'unsupported' });
  failure.probeLog = log;
  throw failure;
}
