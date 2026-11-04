import { select as d3_select } from 'd3-selection';

import {
    extraPlugins,
    loadInstalledPlugins,
    normalizeExtraPlugin,
    pluginCatalog,
    setExtraPlugins,
    setInstalledPluginIds
} from '../../../modules/core/betterid_plugins';
import { prefs } from '../../../modules/core/preferences';
import { setup as setupHello } from '../../../modules/plugins/hello.js';


describe('betterid plugins', function() {
    afterEach(function() {
        prefs('betterid.plugins.installed', null);
        prefs('betterid.plugins.extra', null);
        document.body.innerHTML = '';
    });

    it('publishes the curated marketplace entry', function() {
        const hello = pluginCatalog().find(plugin => plugin.id === 'betterid.hello');
        expect(hello.name).toBeTruthy();
        expect(hello.description).toMatch(/\bPR\b/);
        expect(hello.icon).toMatch(/^data:image\/svg\+xml/);
        expect(hello.builtin).toEqual('hello');
        expect(hello.version).toBeTruthy();
    });

    it('accepts an https manifest and rejects other origins', function() {
        const plugin = normalizeExtraPlugin({
            id: 'example.tool',
            name: 'Example',
            description: 'A remote tool',
            entry: 'https://example.com/plugin.js'
        });
        expect(plugin.entry).toEqual('https://example.com/plugin.js');
        expect(() => normalizeExtraPlugin({
            id: 'example.tool',
            name: 'Example',
            description: 'A remote tool',
            entry: 'http://evil.example/plugin.js'
        })).toThrow(/https/);
    });

    it('loads the built-in example after it is installed', async function() {
        document.body.innerHTML = '<div id="app"><div class="map-footer"></div></div>';
        const container = d3_select('#app');
        setExtraPlugins([]);
        setInstalledPluginIds(['betterid.hello']);
        await loadInstalledPlugins({ container: () => container });
        expect(container.select('.betterid-plugin-hello').text()).toEqual('Map status note');
        expect(extraPlugins()).toEqual([]);
    });

    it('draws the example line once', function() {
        document.body.innerHTML = '<div id="app"><div class="map-footer"></div></div>';
        const api = {
            context: { container: () => d3_select('#app') },
            plugin: { name: 'Map status note', description: 'long' }
        };
        setupHello(api);
        setupHello(api);
        expect(document.querySelectorAll('.betterid-plugin-hello')).toHaveLength(1);
    });
});
