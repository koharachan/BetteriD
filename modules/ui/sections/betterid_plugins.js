import { select as d3_select } from 'd3-selection';

import {
  extraPlugins,
  installedPluginIds,
  loadInstalledPlugins,
  normalizeExtraPlugin,
  pluginCatalog,
  setExtraPlugins,
  setInstalledPluginIds
} from '../../core/betterid_plugins';
import { t } from '../../core/localizer';
import { uiSection } from '../section';


export function uiSectionBetteridPlugins(context) {
  const section = uiSection('preferences-betterid-plugins', context)
    .label(() => t.append('preferences.plugins.title'))
    .disclosureContent(render);
  return section;


  function render(selection) {
    const installed = new Set(installedPluginIds());

    let help = selection.selectAll('.betterid-plugin-help').data([0]);
    help = help.enter().append('p').attr('class', 'betterid-plugin-help').merge(help);
    help.call(t.addOrUpdate('preferences.plugins.help'));

    const rows = selection.selectAll('.betterid-plugin-row').data(pluginCatalog(), plugin => plugin.id);
    rows.exit().remove();
    const rowEnter = rows.enter().append('div').attr('class', 'betterid-plugin-row');
    rowEnter.append('img').attr('class', 'betterid-plugin-icon').attr('alt', '');
    const text = rowEnter.append('div').attr('class', 'betterid-plugin-text');
    text.append('strong');
    text.append('p');
    rowEnter.append('button').attr('type', 'button');

    const merged = rowEnter.merge(rows);
    merged.select('img').attr('src', plugin => plugin.icon || '');
    merged.select('strong').text(plugin => plugin.name);
    merged.select('p').text(plugin => plugin.description);
    merged.select('button')
      .attr('class', plugin => installed.has(plugin.id) ? 'secondary-action' : 'action')
      .text(plugin => t(installed.has(plugin.id) ? 'preferences.plugins.disable' : 'preferences.plugins.install'))
      .on('click', (event, plugin) => {
        event.preventDefault();
        const ids = installedPluginIds();
        if (ids.includes(plugin.id)) {
          setInstalledPluginIds(ids.filter(id => id !== plugin.id));
        } else {
          setInstalledPluginIds(ids.concat(plugin.id));
          loadInstalledPlugins(context);
        }
        section.reRender();
      });

    let hint = selection.selectAll('.betterid-plugin-reload').data([0]);
    hint = hint.enter().append('p').attr('class', 'betterid-plugin-help betterid-plugin-reload').merge(hint);
    hint.call(t.addOrUpdate('preferences.plugins.reload_hint'));

    let extra = selection.selectAll('.betterid-plugin-extra').data([0]);
    const extraEnter = extra.enter().append('div').attr('class', 'betterid-plugin-extra');
    extraEnter.append('textarea')
      .attr('class', 'betterid-plugin-manifest')
      .attr('spellcheck', 'false')
      .attr('placeholder', t('preferences.plugins.manifest_placeholder'));
    extraEnter.append('button')
      .attr('type', 'button')
      .attr('class', 'action')
      .call(t.append('preferences.plugins.add_extra'))
      .on('click', function(event) {
        event.preventDefault();
        const box = d3_select(this.parentNode);
        try {
          const plugin = normalizeExtraPlugin(box.select('textarea').property('value'));
          setExtraPlugins(extraPlugins().filter(item => item.id !== plugin.id).concat(plugin));
          if (!installedPluginIds().includes(plugin.id)) {
            setInstalledPluginIds(installedPluginIds().concat(plugin.id));
          }
          loadInstalledPlugins(context);
          box.select('.betterid-plugin-extra-error').text('');
          section.reRender();
        } catch (error) {
          box.select('.betterid-plugin-extra-error').text(error.message);
        }
      });
    extraEnter.append('p').attr('class', 'betterid-plugin-extra-error');
  }
}
