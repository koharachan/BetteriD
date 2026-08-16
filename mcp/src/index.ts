import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';

import { BetterIdApi } from './api.js';
import { BetterIdBrowser } from './browser.js';
import { BetterIdMcpServer } from './server.js';

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

async function main(): Promise<void> {
  const webBaseUrl = env('OSM_WEB_URL', 'http://127.0.0.1:9178');
  const editorPath = env('OSM_MCP_EDITOR_PATH', '/id/');
  const timeoutMs = envInt('OSM_MCP_TIMEOUT_MS', 180_000);
  const profileDir = env(
    'OSM_MCP_PROFILE_DIR',
    path.resolve(import.meta.dirname, '..', '.browser-profile')
  );
  const [width, height] = env('OSM_MCP_VIEWPORT', '1280,800')
    .split(',')
    .map((value) => Number(value.trim()));

  const browser = new BetterIdBrowser({
    baseUrl: webBaseUrl,
    editorPath,
    headless: envBool('OSM_MCP_HEADLESS', false),
    profileDir,
    timeoutMs,
    viewport: {
      width: Number.isFinite(width) && width > 0 ? width : 1280,
      height: Number.isFinite(height) && height > 0 ? height : 800
    }
  });
  const api = new BetterIdApi({
    webBaseUrl,
    nominatimUrl: env('OSM_MCP_NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
    timeoutMs
  });

  const server = new McpServer({ name: 'betterid-web-editor', version: '0.1.0' });
  new BetterIdMcpServer({ browser, api }).register(server);

  const shutdown = async () => {
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('betterid-mcp failed to start:', error);
  process.exit(1);
});
