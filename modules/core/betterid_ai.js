/**
 * Direct (browser-side) AI access.
 *
 * The AI endpoint the servers are configured with is only reachable from
 * ordinary client networks, so instead of proxying every request through
 * `/api/osm-ai/*`, the editor can talk to the endpoint itself with the visitor's
 * own connection. The server tells us where to go in `window.OSM_PROXY_CONFIG
 * .ai`; the prompts and the response parsing stay identical to the server path,
 * because both are produced here and only the transport differs.
 */

const DEFAULT_TIMEOUT = 120000;


function config() {
  return globalThis.OSM_PROXY_CONFIG?.ai || null;
}


/** True when the deployment ships an absolute AI endpoint for the browser. */
export function directAiAvailable() {
  const ai = config();
  return Boolean(ai && ai.baseUrl && ai.apiKey);
}


export function directAiModel(kind) {
  const ai = config();
  if (!ai) return null;
  if (kind === 'vision') return ai.visionModel || ai.textModel || null;
  return ai.textModel || null;
}


/** First JSON object inside a completion, tolerating code fences and prose. */
export function extractJsonObject(text) {
  if (!text) return null;
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* keep looking */ }

  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}


/**
 * One chat completion against the configured endpoint.
 *
 * @param {{prompt: string, system?: string, maxTokens?: number, image?: string,
 *          model?: string, signal?: AbortSignal}} request
 * @returns {Promise<string>} the assistant text
 */
export async function directAiChat(request) {
  const ai = config();
  if (!ai || !ai.baseUrl || !ai.apiKey) throw new Error('AI endpoint is not configured');

  const model = request.model || directAiModel(request.image ? 'vision' : 'text');
  const content = request.image
    ? [
      { type: 'text', text: request.prompt },
      { type: 'image_url', image_url: { url: request.image } }
    ]
    : request.prompt;

  const messages = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  messages.push({ role: 'user', content });

  const payload = {
    model,
    messages,
    stream: false,
    max_tokens: request.maxTokens || 2048
  };
  if (ai.disableThinking && !request.image) {
    payload.thinking = { type: 'disabled' };
  }
  // The tag assistant needs a strict object: without this the model may answer
  // with its own schema (it happens with web-search flavoured prompts).
  if (request.json) {
    payload.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeout || DEFAULT_TIMEOUT);
  const onAbort = () => controller.abort();
  if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(`${ai.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`AI endpoint returned ${response.status}${body ? ': ' + body.slice(0, 200) : ''}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('AI endpoint returned an empty completion');
    }
    return text;
  } finally {
    clearTimeout(timer);
    if (request.signal) request.signal.removeEventListener('abort', onAbort);
  }
}


/** Same call, but returning the first JSON object of the answer. */
export async function directAiJson(request) {
  const text = await directAiChat({ ...request, json: true });
  const parsed = extractJsonObject(text);
  if (!parsed) throw new Error('AI endpoint did not return JSON');
  return parsed;
}
