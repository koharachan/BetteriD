/**
 * Chat transports for the provider the user configures.
 *
 * OpenAI Chat Completions (including SSE), the OpenAI Responses stream,
 * Anthropic Messages, and Gemini generateContent all return assistant text.
 * Callers still receive one string; streaming responses are concatenated.
 */

export const BETTERID_AI_PROTOCOLS = Object.freeze([
  'openai',
  'openai-responses',
  'anthropic',
  'gemini',
  'codex'
]);


function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}


function streamEnabled(ai, request) {
  if (request && request.stream !== undefined) return Boolean(request.stream);
  return Boolean(ai && ai.stream);
}


function dataUrlParts(dataUrl) {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl || '');
  if (!match) return null;
  return { mediaType: match[1] || 'image/png', data: match[2] };
}


function openaiMessages(request) {
  const messages = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  const content = request.image
    ? [
      { type: 'text', text: request.prompt },
      { type: 'image_url', image_url: { url: request.image } }
    ]
    : request.prompt;
  messages.push({ role: 'user', content });
  return messages;
}


function anthropicContent(request) {
  if (!request.image) return request.prompt;
  const image = dataUrlParts(request.image);
  const parts = [{ type: 'text', text: request.prompt }];
  if (image) {
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data }
    });
  }
  return parts;
}


function geminiParts(request) {
  const parts = [{ text: request.prompt }];
  const image = request.image && dataUrlParts(request.image);
  if (image) parts.push({ inline_data: { mime_type: image.mediaType, data: image.data } });
  return parts;
}


function responsesInput(request) {
  const items = [];
  if (request.system) {
    items.push({ role: 'system', content: [{ type: 'input_text', text: request.system }] });
  }
  const content = [{ type: 'input_text', text: request.prompt }];
  if (request.image) content.push({ type: 'input_image', image_url: request.image });
  items.push({ role: 'user', content });
  return items;
}


function authHeaders(ai, extra) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extra);
  if (ai.apiKey && !headers.Authorization && !headers['x-api-key'] && !headers['x-goog-api-key']) {
    headers.Authorization = `Bearer ${ai.apiKey}`;
  }
  return headers;
}


/**
 * The HTTP call for one chat turn.
 * @returns {{url: string, headers: object, body: object}}
 */
export function buildChatCall(ai, request) {
  const protocol = BETTERID_AI_PROTOCOLS.includes(ai.protocol) ? ai.protocol : 'openai';
  const stream = streamEnabled(ai, request);
  const maxTokens = request.maxTokens || 2048;
  const model = request.model;

  if (protocol === 'anthropic') {
    const root = String(ai.baseUrl || '').replace(/\/+$/, '');
    const path = /\/v1$/.test(root) ? '/messages' : '/v1/messages';
    const body = {
      model,
      max_tokens: maxTokens,
      stream,
      messages: [{ role: 'user', content: anthropicContent(request) }]
    };
    if (request.system) body.system = request.system;
    return {
      url: root + path,
      headers: authHeaders(ai, {
        'x-api-key': ai.apiKey || '',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      }),
      body
    };
  }

  if (protocol === 'gemini') {
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const body = {
      contents: [{ role: 'user', parts: geminiParts(request) }],
      generationConfig: { maxOutputTokens: maxTokens }
    };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
    const headers = { 'Content-Type': 'application/json' };
    if (ai.apiKey) headers['x-goog-api-key'] = ai.apiKey;
    return {
      url: joinUrl(ai.baseUrl, `/models/${encodeURIComponent(model)}:${action}`),
      headers,
      body
    };
  }

  if (protocol === 'openai-responses' || protocol === 'codex') {
    const headers = authHeaders(ai);
    if (protocol === 'codex') {
      headers['OpenAI-Beta'] = 'responses=experimental';
      if (ai.accountId) headers['ChatGPT-Account-ID'] = ai.accountId;
    }
    return {
      url: joinUrl(ai.baseUrl, '/responses'),
      headers,
      body: {
        model,
        input: responsesInput(request),
        stream,
        max_output_tokens: maxTokens
      }
    };
  }

  const body = {
    model,
    messages: openaiMessages(request),
    stream,
    max_tokens: maxTokens
  };
  if (ai.disableThinking && !request.image) body.thinking = { type: 'disabled' };
  if (request.json) body.response_format = { type: 'json_object' };
  return {
    url: joinUrl(ai.baseUrl, '/chat/completions'),
    headers: authHeaders(ai),
    body
  };
}


function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part) return '';
    if (typeof part === 'string') return part;
    return part.text || part.content || '';
  }).join('');
}


function textFromJson(data, protocol) {
  if (!data || typeof data !== 'object') return '';
  if (protocol === 'anthropic') {
    return textFromContent(data.content);
  }
  if (protocol === 'gemini') {
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    return textFromContent(parts);
  }
  if (protocol === 'openai-responses' || protocol === 'codex') {
    if (typeof data.output_text === 'string') return data.output_text;
    if (Array.isArray(data.output)) {
      return data.output.map(item => textFromContent(item && (item.content || item.text))).join('');
    }
  }
  const message = data.choices && data.choices[0] && data.choices[0].message;
  return textFromContent(message && message.content);
}


function deltaFromEvent(protocol, event, json) {
  if (!json || typeof json !== 'object') return '';
  if (protocol === 'anthropic' || event === 'content_block_delta') {
    return json.delta && (json.delta.text || json.delta.partial_json) || '';
  }
  if (protocol === 'gemini') return textFromJson(json, 'gemini');
  if (protocol === 'openai-responses' || protocol === 'codex' || event === 'response.output_text.delta') {
    if (typeof json.delta === 'string') return json.delta;
    if (json.delta && typeof json.delta.text === 'string') return json.delta.text;
  }
  const choice = json.choices && json.choices[0];
  if (choice && choice.delta) return textFromContent(choice.delta.content);
  return '';
}


/** Concatenate an SSE body. A non-stream JSON body is handled by the caller. */
export function parseEventStream(raw, protocol) {
  let out = '';
  const blocks = String(raw || '').split(/\n\n+/);
  blocks.forEach(block => {
    let event = '';
    const dataLines = [];
    block.split('\n').forEach(line => {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    });
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return;
    try {
      out += deltaFromEvent(protocol, event, JSON.parse(data));
    } catch { /* keep the text assembled so far */ }
  });
  return out;
}


/** Assistant text from a JSON body or an SSE stream. */
export function extractCompletionText(raw, protocol) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const name = BETTERID_AI_PROTOCOLS.includes(protocol) ? protocol : 'openai';
  if (trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
    const streamed = parseEventStream(trimmed, name);
    if (streamed.trim()) return streamed;
  }
  try {
    return textFromJson(JSON.parse(trimmed), name);
  } catch {
    return '';
  }
}
