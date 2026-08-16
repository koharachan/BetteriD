import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BetterIdApi } from '../src/api.js';

let server: Server;
let baseUrl: string;
let lastBody: unknown;

before(async () => {
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', baseUrl);
      if (request.method === 'POST' && url.pathname === '/api/osm-ai/tag-suggestions') {
        lastBody = raw ? JSON.parse(raw) : undefined;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            summary: '道路应标记为单行道。',
            suggestions: [{ key: 'oneway', value: 'yes', reason: '现场标志。', confidence: 0.9 }],
            sources: [],
            warnings: []
          })
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/search') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify([
            {
              display_name: '人民广场, 黄浦区, 上海市, 中国',
              lat: '31.2297',
              lon: '121.4722',
              type: 'square'
            }
          ])
        );
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('suggestTags posts to the BetteriD AI API', async () => {
  const api = new BetterIdApi({ webBaseUrl: baseUrl, timeoutMs: 5000 });
  const result = await api.suggestTags({
    description: '一条单行道',
    tags: { highway: 'residential' },
    geometry: 'line',
    location: { lat: 31.2, lon: 121.4 }
  });
  assert.equal((result as { summary?: string }).summary, '道路应标记为单行道。');
  assert.deepEqual(lastBody, {
    description: '一条单行道',
    tags: { highway: 'residential' },
    geometry: 'line',
    location: { lat: 31.2, lon: 121.4 }
  });
});

test('geocode queries Nominatim-style search endpoint', async () => {
  const api = new BetterIdApi({ nominatimUrl: baseUrl, timeoutMs: 5000 });
  const result = await api.geocode('人民广场', 1);
  assert.ok(Array.isArray(result));
  assert.equal((result as { display_name?: string }[])[0].display_name, '人民广场, 黄浦区, 上海市, 中国');
});

test('API errors surface as descriptive exceptions', async () => {
  const api = new BetterIdApi({ webBaseUrl: `${baseUrl}/missing`, timeoutMs: 5000 });
  await assert.rejects(
    api.suggestTags({ description: '测试', location: { lat: 31, lon: 121 } }),
    /HTTP 404/
  );
});
