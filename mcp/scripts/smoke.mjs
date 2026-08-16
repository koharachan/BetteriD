import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const baseUrl = process.env.OSM_WEB_URL || 'https://map.osm.asia';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    ...process.env,
    OSM_WEB_URL: baseUrl,
    OSM_MCP_HEADLESS: '1',
    OSM_MCP_PROFILE_DIR: './.smoke-profile',
    OSM_MCP_TIMEOUT_MS: '120000'
  }
});
const client = new Client({ name: 'betterid-mcp-smoke', version: '0.0.1' });

try {
  await client.connect(transport);

  const tools = await client.listTools(undefined, { timeout: 180000 });
  console.log(`tools: ${tools.tools.length}`);
  console.log(tools.tools.map((tool) => tool.name).join(', '));

  const state = await callTool({
    name: 'open_editor',
    arguments: { lat: 31.2304, lon: 121.4737, zoom: 17 }
  });
  console.log('open_editor:', textOf(state).slice(0, 400));

  const way = await callTool({
    name: 'add_way',
    arguments: {
      points: [
        { lat: 31.2304, lon: 121.4737 },
        { lat: 31.2308, lon: 121.4741 },
        { lat: 31.2312, lon: 121.4745 }
      ],
      tags: { highway: 'busway', name: '冒烟测试线路' },
      closed: false
    }
  });
  console.log('add_way:', textOf(way).slice(0, 300));

  const changes = await callTool({ name: 'get_changes', arguments: {} });
  console.log('get_changes:', textOf(changes).slice(0, 300));

  const shot = await callTool({ name: 'screenshot', arguments: {} });
  const image = shot.content.find((item) => item.type === 'image');
  console.log('screenshot image bytes:', image ? Math.round(image.data.length * 0.75) : 'missing');

  const undone = await callTool({ name: 'undo', arguments: {} });
  console.log('undo:', textOf(undone).slice(0, 200));

  await client.close();
  console.log('smoke ok');
} catch (error) {
  console.error('smoke failed:', error);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}

function textOf(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function callTool(params) {
  return client.callTool(params, undefined, { timeout: 180000, maxTotalTimeout: 240000 });
}
