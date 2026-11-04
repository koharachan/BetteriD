/**
 * Installable plugins.
 *
 * The marketplace list is `data/plugins/marketplace.json`. Adding a plugin
 * to that list is a pull request. Users can also paste their own manifest;
 * a remote entry is loaded only after they install it.
 */

import catalog from '../../data/plugins/marketplace.json';
import { prefs } from './preferences';
import { setup as setupHello } from '../plugins/hello.js';

export const PLUGIN_MARKETPLACE = catalog;
const INSTALLED_PREF = 'betterid.plugins.installed';
const EXTRA_PREF = 'betterid.plugins.extra';
const BUILTINS = Object.freeze({ hello: setupHello });
const loaded = new Set();


function readList(key) {
    try {
        const value = JSON.parse(prefs(key) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}


export function installedPluginIds() {
    return readList(INSTALLED_PREF).filter(id => typeof id === 'string');
}


export function extraPlugins() {
    return readList(EXTRA_PREF).filter(plugin => plugin && typeof plugin.id === 'string');
}


export function setInstalledPluginIds(ids) {
    prefs(INSTALLED_PREF, JSON.stringify(Array.from(new Set(ids))));
}


export function setExtraPlugins(plugins) {
    prefs(EXTRA_PREF, JSON.stringify(plugins));
}


export function pluginCatalog() {
    const seen = new Set();
    const list = [];
    [...(PLUGIN_MARKETPLACE.plugins || []), ...extraPlugins()].forEach(plugin => {
        if (!plugin || !plugin.id || seen.has(plugin.id)) return;
        seen.add(plugin.id);
        list.push(plugin);
    });
    return list;
}


export function normalizeExtraPlugin(input) {
    const source = typeof input === 'string' ? JSON.parse(input) : input;
    if (!source || typeof source !== 'object') throw new Error('Plugin manifest must be a JSON object');
    const id = String(source.id || '').trim();
    const name = String(source.name || '').trim();
    const description = String(source.description || '').trim();
    const entry = String(source.entry || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,80}$/i.test(id)) throw new Error('Plugin id must be a short identifier');
    if (!name || !description) throw new Error('Plugin name and description are required');
    if (!/^https:\/\//.test(entry) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(entry)) {
        throw new Error('Plugin entry must be an https URL, or http on localhost');
    }
    return {
        id,
        name: name.slice(0, 80),
        description: description.slice(0, 240),
        icon: String(source.icon || '').slice(0, 400),
        version: String(source.version || '0.0.0').slice(0, 32),
        author: String(source.author || '').slice(0, 80),
        license: String(source.license || '').slice(0, 40),
        homepage: String(source.homepage || '').slice(0, 200),
        entry
    };
}


function importEntry(url) {
    return import(/* @vite-ignore */ url);
}


async function activate(plugin, context) {
    const api = { context, plugin, prefs };
    if (plugin.builtin && BUILTINS[plugin.builtin]) {
        await BUILTINS[plugin.builtin](api);
        return;
    }
    if (!plugin.entry) throw new Error('Plugin has no entry');
    const mod = await importEntry(plugin.entry);
    const setup = mod.setup || mod.default;
    if (typeof setup !== 'function') throw new Error('Plugin entry must export setup(api)');
    await setup(api);
}


/** Load every installed plugin that is not already running. */
export async function loadInstalledPlugins(context) {
    const enabled = new Set(installedPluginIds());
    const pending = pluginCatalog().filter(plugin => enabled.has(plugin.id) && !loaded.has(plugin.id));
    for (const plugin of pending) {
        loaded.add(plugin.id);
        try {
            await activate(plugin, context);
        } catch (error) {
            loaded.delete(plugin.id);
            console.error(`BetteriD plugin ${plugin.id} failed`, error); // eslint-disable-line no-console
        }
    }
}
