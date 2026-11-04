import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createMcpAdmin, mutateStore, normalizeServer } from '../../../scripts/mcp_admin.mjs';


function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: options.method || 'GET',
            headers: options.headers
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({
                    status: response.statusCode,
                    text: () => text,
                    json: () => JSON.parse(text)
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}


describe('betterid MCP admin', function() {
    it('normalizes and removes a stored server', function() {
        const added = mutateStore({ servers: [] }, {
            type: 'add',
            server: { name: 'Local', transport: 'http', url: 'http://127.0.0.1:9', args: 'one two' }
        });
        expect(added.server.transport).toEqual('http');
        expect(added.server.args).toEqual(['one', 'two']);
        expect(() => normalizeServer({ name: '' })).toThrow(/name/);
        const removed = mutateStore(added.store, { type: 'remove', id: added.server.id });
        expect(removed.store.servers).toEqual([]);
    });

    it('serves the management page and a browser Codex login', async function() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterid-mcp-'));
        const admin = createMcpAdmin({
            prefix: '',
            storePath: path.join(dir, 'servers.json')
        });
        const started = await admin.start({ host: '127.0.0.1', port: 0 });
        try {
            const page = await request(`${started.url}/`);
            expect(page.status).toBe(200);
            expect(await page.text()).toContain('BetteriD MCP');

            const created = await request(`${started.url}/api/servers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Probe', transport: 'http', url: 'http://127.0.0.1:9' })
            });
            const server = await created.json();
            expect(server.name).toEqual('Probe');

            const listed = (await request(`${started.url}/api/servers`)).json();
            expect(listed.servers.map(item => item.id)).toContain(server.id);

            const removed = await request(`${started.url}/api/servers/${server.id}`, { method: 'DELETE' });
            expect(removed.status).toBe(200);
            const after = (await request(`${started.url}/api/servers`)).json();
            expect(after.servers).toEqual([]);

            const login = await request(`${started.url}/api/codex/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'browser' })
            });
            const body = await login.json();
            const authorize = decodeURIComponent(body.authorizeUrl);
            expect(authorize).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
            expect(authorize).toContain('http://localhost:');
            expect(authorize).toContain('/auth/callback');
        } finally {
            await admin.stop();
        }
    });
});
