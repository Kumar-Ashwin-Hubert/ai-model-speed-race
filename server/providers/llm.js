import { SAMPLE_PAPERS, buildLlmMessages } from '../../shared/rulebook.js';
import { UpstreamError, postChat, withAuthFallback } from '../http.js';
import { extractText, parseDecision, readUsage } from '../decision.js';

const emptyReplyHint = (desk) => `if the model reasons, raise ${desk.envPrefix}MAX_TOKENS or lower ${desk.envPrefix}REASONING_EFFORT`;

function buildChatBody(desk, dossier) {
  const body = {
    model: desk.model,
    messages: buildLlmMessages(dossier),
    max_completion_tokens: desk.maxTokens,
  };
  if (desk.temperature !== null) body.temperature = desk.temperature;
  if (desk.reasoningEffort) body.reasoning_effort = desk.reasoningEffort;
  return body;
}

/** Responses API: the system prompt goes in `instructions`, the application in `input`. Nothing is stored. */
function buildResponsesBody(desk, dossier) {
  const [system, user] = buildLlmMessages(dossier);
  const body = {
    model: desk.model,
    instructions: system.content,
    input: user.content,
    max_output_tokens: desk.maxTokens,
    store: false,
  };
  if (desk.temperature !== null) body.temperature = desk.temperature;
  if (desk.reasoningEffort) body.reasoning = { effort: desk.reasoningEffort };
  return body;
}

function finish(reply, desk, extras) {
  const decision = parseDecision(reply);
  if (!decision) {
    const reason = reply ? `unrecognised reply: "${reply.slice(0, 80)}"` : `empty reply (${extras.stopReason}); ${emptyReplyHint(desk)}`;
    throw new UpstreamError(reason, { code: 'invalid_output', status: 200 });
  }
  return {
    decision,
    detail: { kind: 'llm', api: extras.api, reply: reply.slice(0, 200), finishReason: extras.finishReason },
    usage: extras.usage,
    model: extras.model,
  };
}

function interpretChatReply(json, desk) {
  const choice = json?.choices?.[0];
  const reply = extractText(choice?.message?.content).trim();
  return finish(reply, desk, {
    api: 'chat',
    stopReason: `finish_reason=${choice?.finish_reason ?? 'unknown'}`,
    finishReason: choice?.finish_reason ?? null,
    usage: readUsage(json),
    model: json?.model ?? desk.model,
  });
}

/** Text of a Responses API reply: the raw REST body has `output[]` items; `output_text` only exists in SDKs. */
function readResponsesText(json) {
  if (typeof json?.output_text === 'string') return json.output_text;
  let reply = '';
  for (const item of json?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (typeof part?.text === 'string') reply += part.text;
    }
  }
  return reply;
}

function interpretResponsesReply(json, desk) {
  if (json?.status === 'failed') {
    throw new UpstreamError(`response failed: ${json?.error?.message ?? 'no details'}`, { code: 'invalid_output', status: 200 });
  }
  const reply = readResponsesText(json).trim();
  const incomplete = json?.incomplete_details?.reason;
  return finish(reply, desk, {
    api: 'responses',
    stopReason: `status=${json?.status ?? 'unknown'}${incomplete ? `, ${incomplete}` : ''}`,
    finishReason: incomplete ?? json?.status ?? null,
    usage: readUsage(json),
    model: json?.model ?? desk.model,
  });
}

/** One LLM decision through the chat completions API or the Responses API. */
export async function callLlm(desk, dossier, options, api = 'chat') {
  const responses = api === 'responses';
  const url = responses ? desk.upstream.responsesUrl : desk.upstream.chatUrl;
  const body = responses ? buildResponsesBody(desk, dossier) : buildChatBody(desk, dossier);
  let json;
  try {
    ({ json } = await withAuthFallback(desk, (headers) => postChat(url, { headers, body, ...options })));
  } catch (error) {
    if (!responses && error.code === 'http' && [400, 404].includes(error.status) && /does not work with|not supported|operation/i.test(error.message)) {
      error.message += ` | If this deployment only supports the Responses API, paste the portal's .../responses URL into ${desk.envPrefix}URL or set ${desk.envPrefix}API=responses.`;
    }
    throw error;
  }
  return responses ? interpretResponsesReply(json, desk) : interpretChatReply(json, desk);
}

const API_UNSUPPORTED_STATUS = new Set([400, 404, 405, 415, 501]);

/**
 * For `api: auto`: chat completions first, then the Responses API. Only "this API is not available for this
 * model" style failures move on. Auth problems, transient errors and unusable replies are rethrown.
 */
export async function probeLlmApi(desk, options) {
  const log = [];
  for (const api of ['chat', 'responses']) {
    try {
      await callLlm(desk, SAMPLE_PAPERS.reject, options, api);
      log.push({ api, ok: true });
      return { api, log };
    } catch (error) {
      const unsupported = error instanceof UpstreamError && error.code === 'http' && API_UNSUPPORTED_STATUS.has(error.status);
      if (!unsupported) throw error;
      log.push({ api, ok: false, status: error.status, error: error.message });
    }
  }
  const summary = log.map((entry) => `${entry.api} -> ${entry.error}`).join(' | ');
  const failure = new UpstreamError(`Neither chat completions nor the Responses API worked for "${desk.model}". ${summary}`, { status: log[0].status, code: 'unsupported' });
  failure.probeLog = log;
  throw failure;
}
