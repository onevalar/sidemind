/**
 * Direct model calls for the ChatGit canvas, reusing LibreChat's endpoint configuration:
 * custom OpenAI-compatible endpoints (user-provided key/URL) and the ChatGPT connection.
 * Same recipe as the title/activity-label paths: provider options → initializeModel.
 */
const { getProviderConfig } = require('@librechat/api');
const { initializeModel } = require('@librechat/agents');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const { getUserKey, getUserKeyValues } = require('~/models');

/** Generation options that must not reach providers which reject them (ChatGPT Responses). */
const STRIP = ['maxTokens', 'temperature', 'topP', 'presencePenalty', 'frequencyPenalty'];

async function resolveModel(req, { endpoint, model, streaming = true, maxOutputTokens }) {
  const providerConfig = getProviderConfig({ provider: endpoint, appConfig: req.config });
  const options = await providerConfig.getOptions({
    req,
    endpoint,
    model_parameters: { model },
    db: { getUserKey, getUserKeyValues },
  });
  const provider = options.provider ?? providerConfig.overrideProvider;
  // Fail fast: the user sees the error and can retry; long silent backoffs look like a hang.
  const clientOptions = { maxRetries: 1, ...(options.llmConfig ?? {}), streaming };
  // Side calls (summary, suggestions) get a small cap; the main answer keeps the endpoint's own.
  if (maxOutputTokens != null) {
    for (const key of STRIP) {
      delete clientOptions[key];
    }
    if (clientOptions.useResponsesApi !== true) {
      clientOptions.maxTokens = maxOutputTokens;
    }
  }
  if (options.configOptions) {
    clientOptions.configuration = options.configOptions;
  }
  return initializeModel({ provider, clientOptions });
}

function toLangChain(messages) {
  return messages.map((m) => {
    if (m.role === 'system') {
      return new SystemMessage(m.content);
    }
    if (m.role === 'assistant') {
      return new AIMessage(m.content);
    }
    return new HumanMessage(m.content);
  });
}

/** Text from a LangChain chunk/message: plain string or content parts (Responses API). */
function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' || part?.type === 'output_text' ? part.text ?? '' : ''))
      .join('');
  }
  return '';
}

/** Stream an answer; calls onText(delta) and resolves with the full text. */
async function streamAnswer(req, { endpoint, model, messages, signal, onText }) {
  const llm = await resolveModel(req, { endpoint, model, streaming: true });
  let full = '';
  const stream = await llm.stream(toLangChain(messages), { signal });
  for await (const chunk of stream) {
    const delta = textOf(chunk?.content);
    if (delta) {
      full += delta;
      onText(delta, full);
    }
  }
  return full;
}

async function complete(req, { endpoint, model, messages, signal, maxOutputTokens = 600 }) {
  const llm = await resolveModel(req, { endpoint, model, streaming: false, maxOutputTokens });
  const result = await llm.invoke(toLangChain(messages), { signal });
  return textOf(result?.content);
}

/** Map provider/key errors to short, user-actionable codes (never leak provider payloads). */
function classifyError(error) {
  const message = String(error?.message ?? '');
  if (error?.name === 'AbortError' || /aborted/i.test(message)) {
    return { code: 'aborted' };
  }
  try {
    const parsed = JSON.parse(message);
    if (parsed?.type) {
      return { code: String(parsed.type) };
    }
  } catch {
    // not a LibreChat typed error
  }
  if (/401|unauthori[sz]ed|invalid api key/i.test(message)) {
    return { code: 'auth' };
  }
  if (/429|rate limit|quota/i.test(message)) {
    return { code: 'rate_limit' };
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|timeout/i.test(message)) {
    return { code: 'network' };
  }
  return { code: 'provider' };
}

module.exports = { streamAnswer, complete, classifyError, textOf };
