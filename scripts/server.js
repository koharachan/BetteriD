/* eslint-disable no-process-env */

import http from 'node:http';
import https from 'node:https';
import { glob } from 'node:fs/promises';
import { styleText } from 'node:util';
import { watch } from 'chokidar';
import dotenv from 'dotenv';
import serve from 'serve-handler';
import { buildCSS } from './build_css.js';

dotenv.config({ quiet: true });

const MAX_BODY_BYTES = 64 * 1024;
const port = 8080;
const targetLanguageMap = new Map([
  ['en', 'en'],
  ['zh', 'zh-Hans'],
  ['zh-Hant', 'zh-Hant'],
]);

watch(
  await Array.fromAsync(glob('css/**/*.css')), {
  ignoreInitial: false
}).on('all', () => {
  buildCSS();
});


function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}


function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      body += chunk.toString();
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}


function proxyJson(options, data) {
  return new Promise((resolve, reject) => {
    const request = https.request(options, response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Upstream request failed with status ${response.statusCode || 502}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Upstream returned invalid JSON'));
        }
      });
    });

    request.setTimeout(15000, () => request.destroy(new Error('Upstream request timed out')));
    request.on('error', reject);
    request.end(JSON.stringify(data));
  });
}


async function handleTranslate(request, response) {
  try {
    if (!process.env.BING_TRANSLATE_API_KEY) {
      sendJson(response, 503, { error: 'Translation service is not configured' });
      return;
    }

    const body = await parseJsonBody(request);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const targets = Array.isArray(body.target_langs) ? body.target_langs : [];
    const requested = [...new Set(targets)].filter(lang => targetLanguageMap.has(lang));
    if (!text || text.length > 500 || !requested.length) {
      sendJson(response, 400, { error: 'Invalid translation request' });
      return;
    }

    const query = requested.map(lang => `to=${encodeURIComponent(targetLanguageMap.get(lang))}`).join('&');
    const result = await proxyJson({
      hostname: 'api.cognitive.microsofttranslator.com',
      path: `/translate?api-version=3.0&${query}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': process.env.BING_TRANSLATE_API_KEY,
        'Ocp-Apim-Subscription-Region': process.env.BING_TRANSLATE_REGION || 'global',
      },
    }, [{ Text: text }]);

    const translated = result?.[0]?.translations || [];
    const translations = requested.flatMap(lang => {
      const target = targetLanguageMap.get(lang);
      const match = translated.find(item => item.to === target);
      return match?.text ? [{ lang, text: match.text }] : [];
    });
    sendJson(response, 200, { translations });
  } catch {
    sendJson(response, 502, { error: 'Translation service request failed' });
  }
}


async function handleSummarize(request, response) {
  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      sendJson(response, 503, { error: 'AI service is not configured' });
      return;
    }

    const body = await parseJsonBody(request);
    const summaryData = body.summary;
    if (!summaryData || typeof summaryData !== 'object') {
      sendJson(response, 400, { error: 'Invalid summary request' });
      return;
    }

    const structuredSummary = JSON.stringify(summaryData).slice(0, 12000);
    const prompt = [
      '请用简洁的中文总结以下 OpenStreetMap 结构化变更摘要。',
      '只输出适合作为 changeset comment 的一句话，不超过 50 个汉字，不要添加引号或解释。',
      structuredSummary,
    ].join('\n');

    const result = await proxyJson({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 100,
      stream: false,
      temperature: 0.2,
    });

    const summary = result?.choices?.[0]?.message?.content?.trim() || '';
    sendJson(response, 200, { summary });
  } catch {
    sendJson(response, 502, { error: 'AI service request failed' });
  }
}


const server = http.createServer((request, response) => {
  if (request.url === '/api/osm-ai/translate' && request.method === 'POST') {
    handleTranslate(request, response);
    return;
  }

  if (request.url === '/api/osm-ai/summarize' && request.method === 'POST') {
    handleSummarize(request, response);
    return;
  }

  serve(request, response, {
    cleanUrls: false,
    rewrites: [{
      source: '/',
      destination: '/index.html'
    }],
    symlinks: true,
    headers: [{
      source: '**',
      headers: [{
        key: 'Cache-Control',
        value: 'no-cache'
      }]
    }]
  });
});

server.listen(port, () => {
  /* eslint-disable no-console */
  console.log(styleText('yellow', `Listening on ${port}`));
});
