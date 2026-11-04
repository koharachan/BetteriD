/**
 * Built-in example plugin. Marketplace entries with `"builtin": "hello"`
 * run this instead of fetching a remote module.
 */
export function setup(api) {
    const container = api.context && api.context.container && api.context.container();
    if (!container || typeof container.select !== 'function') return;
    const footer = container.select('.map-footer');
    if (!footer || footer.empty() || !footer.select('.betterid-plugin-hello').empty()) return;
    footer.append('p')
        .attr('class', 'betterid-plugin-hello')
        .text(api.plugin.name);
}
