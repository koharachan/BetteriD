import { select as d3_select } from 'd3-selection';

import {
  BETTERID_PREFS,
  betteridBool,
  getProviderOrder,
  getSnapTolerance,
  getTranslationLanguages,
  setBetteridBool,
  setProviderOrder,
  setTranslationLanguages
} from '../../core/betterid_preferences';
import { localizer, t } from '../../core/localizer';
import { prefs } from '../../core/preferences';
import { svgIcon } from '../../svg/icon';
import { uiSection } from '../section';


function renderCheckbox(selection, options) {
  const checked = betteridBool(options.pref, options.defaultValue);
  let row = selection.selectAll(`.${options.className}`)
    .data([checked]);

  const rowEnter = row.enter()
    .append('label')
    .attr('class', `betterid-preference-row ${options.className}`);

  rowEnter.append('input')
    .attr('type', 'checkbox')
    .on('change', function() {
      setBetteridBool(options.pref, this.checked);
      if (options.onChange) options.onChange(this.checked);
    });

  rowEnter.append('span')
    .attr('class', 'betterid-preference-label')
    .call(t.append(options.label));

  if (options.description) {
    rowEnter.append('small')
      .call(t.append(options.description));
  }

  row = rowEnter.merge(row);
  row.classed('disabled', !!options.disabled);
  row.select('input')
    .property('checked', checked)
    .property('disabled', !!options.disabled);
}


function makeSimpleSection(id, label, render) {
  return function(context) {
    const section = uiSection(id, context)
      .label(() => t.append(label))
      .disclosureContent(selection => render(selection, section, context));
    return section;
  };
}


export const uiSectionBetteridGeneral = makeSimpleSection(
  'preferences-betterid-general',
  'preferences.general.title',
  (selection, section) => {
    renderCheckbox(selection, {
      className: 'preference-remember-location',
      pref: BETTERID_PREFS.rememberLocation,
      defaultValue: true,
      label: 'preferences.general.remember_location',
      description: 'preferences.general.remember_location_description',
      onChange: value => {
        if (!value) prefs('map-location', null);
        section.reRender();
      }
    });
  }
);


export const uiSectionBetteridEditing = makeSimpleSection(
  'preferences-betterid-editing',
  'preferences.editing.title',
  (selection, section) => {
    renderCheckbox(selection, {
      className: 'preference-right-drag',
      pref: BETTERID_PREFS.rightDrag,
      defaultValue: true,
      label: 'preferences.editing.right_drag',
      description: 'preferences.editing.right_drag_description',
      onChange: section.reRender
    });
    renderCheckbox(selection, {
      className: 'preference-josm-shortcuts',
      pref: BETTERID_PREFS.josmShortcuts,
      defaultValue: true,
      label: 'preferences.editing.josm_shortcuts',
      description: 'preferences.editing.josm_shortcuts_description',
      onChange: section.reRender
    });

    let snap = selection.selectAll('.preference-snap-tolerance')
      .data([getSnapTolerance()]);
    const snapEnter = snap.enter()
      .append('label')
      .attr('class', 'preference-snap-tolerance betterid-number-preference');
    snapEnter.append('span').call(t.append('preferences.editing.snap_tolerance'));
    snapEnter.append('input')
      .attr('type', 'number')
      .attr('min', 2)
      .attr('max', 30)
      .attr('step', 1)
      .on('change', function() {
        prefs(BETTERID_PREFS.snapTolerance, String(Math.max(2, Math.min(30, Number(this.value) || 8))));
        section.reRender();
      });
    snap = snapEnter.merge(snap);
    snap.select('input').property('value', getSnapTolerance());

    renderCheckbox(selection, {
      className: 'preference-smart-split',
      pref: 'smartSplit',
      defaultValue: false,
      label: 'preferences.editing.smart_split',
      description: 'preferences.editing.smart_split_description',
      onChange: section.reRender
    });

    const splitEnabled = prefs('smartSplit') === 'true';
    let split = selection.selectAll('.preference-split-settings')
      .data([0]);
    const splitEnter = split.enter()
      .append('div')
      .attr('class', 'preference-split-settings betterid-preference-subgroup');
    splitEnter.append('label')
      .append('span')
      .call(t.append('commit.split_type'));
    splitEnter.select('label')
      .append('select')
      .on('change', function() { prefs('splitType', this.value); section.reRender(); })
      .selectAll('option')
      .data(['auto', 'fixed', 'area'])
      .enter()
      .append('option')
      .attr('value', d => d)
      .text(d => t(`commit.split_${d}`));
    splitEnter.append('label')
      .attr('class', 'preference-split-count')
      .append('span')
      .call(t.append('commit.split_fixed_count'));
    splitEnter.select('.preference-split-count')
      .append('input')
      .attr('type', 'number')
      .attr('min', 1)
      .attr('max', 500)
      .on('change', function() {
        prefs('splitFixedCount', String(Math.max(1, Math.min(500, Number(this.value) || 50))));
      });
    split = splitEnter.merge(split);
    split.classed('disabled', !splitEnabled);
    split.selectAll('select,input').property('disabled', !splitEnabled);
    split.select('select').property('value', prefs('splitType') || 'auto');
    split.select('input').property('value', prefs('splitFixedCount') || '50');
  }
);


export const uiSectionBetteridLanguage = makeSimpleSection(
  'preferences-betterid-language',
  'preferences.language.title',
  (selection, section) => {
    const languages = getTranslationLanguages();
    let intro = selection.selectAll('.translation-language-intro').data([0]);
    intro.enter()
      .append('p')
      .attr('class', 'translation-language-intro')
      .call(t.append('preferences.language.description'));

    let list = selection.selectAll('.translation-language-list')
      .data([0]);
    list = list.enter().append('ol')
      .attr('class', 'translation-language-list betterid-order-list')
      .merge(list);

    const rows = list.selectAll('li').data(languages, d => d);
    rows.exit().remove();
    const rowsEnter = rows.enter().append('li');
    rowsEnter.append('span').attr('class', 'betterid-order-name');
    const controls = rowsEnter.append('span').attr('class', 'betterid-order-controls');
    controls.append('button')
      .attr('type', 'button')
      .attr('title', t('preferences.move_up'))
      .on('click', (event, code) => moveLanguage(event, code, -1))
      .call(svgIcon('#iD-icon-up'));
    controls.append('button')
      .attr('type', 'button')
      .attr('title', t('preferences.move_down'))
      .on('click', (event, code) => moveLanguage(event, code, 1))
      .call(svgIcon('#iD-icon-down'));
    controls.append('button')
      .attr('type', 'button')
      .attr('title', t('icons.remove'))
      .on('click', removeLanguage)
      .call(svgIcon('#iD-operation-delete'));

    const mergedRows = rowsEnter.merge(rows);
    mergedRows.select('.betterid-order-name')
      .text(code => `${localizer.languageName(code) || code} (${code})`);
    mergedRows.selectAll('button').property('disabled', languages.length === 1);

    let add = selection.selectAll('.translation-language-add').data([0]);
    const addEnter = add.enter().append('div').attr('class', 'translation-language-add');
    addEnter.append('select').attr('aria-label', t('preferences.language.add'));
    addEnter.append('button')
      .attr('type', 'button')
      .attr('class', 'secondary-action')
      .call(t.append('preferences.language.add'))
      .on('click', addLanguage);
    add = addEnter.merge(add);

    const languageData = localizer.languages() || {};
    const available = Object.keys(languageData)
      .filter(code => languageData[code]?.nativeName && !languages.includes(code))
      .sort((a, b) => (localizer.languageName(a) || a).localeCompare(localizer.languageName(b) || b));
    const options = add.select('select').selectAll('option').data(available, d => d);
    options.exit().remove();
    options.enter().append('option')
      .merge(options)
      .attr('value', d => d)
      .text(code => `${localizer.languageName(code) || languageData[code].nativeName} (${code})`);
    add.selectAll('select,button').property('disabled', languages.length >= 8 || !available.length);

    function moveLanguage(event, code, offset) {
      event.preventDefault();
      const index = languages.indexOf(code);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= languages.length) return;
      [languages[index], languages[target]] = [languages[target], languages[index]];
      setTranslationLanguages(languages);
      section.reRender();
    }

    function removeLanguage(event, code) {
      event.preventDefault();
      if (languages.length === 1) return;
      setTranslationLanguages(languages.filter(value => value !== code));
      section.reRender();
    }

    function addLanguage(event) {
      event.preventDefault();
      const code = d3_select(event.currentTarget.parentNode).select('select').property('value');
      if (code && languages.length < 8) setTranslationLanguages([...languages, code]);
      section.reRender();
    }
  }
);


export const uiSectionBetteridValidation = makeSimpleSection(
  'preferences-betterid-validation',
  'preferences.validation.title',
  (selection, section) => {
    renderCheckbox(selection, {
      className: 'preference-non-local-name',
      pref: BETTERID_PREFS.nonLocalName,
      defaultValue: true,
      label: 'preferences.validation.non_local_name',
      description: 'preferences.validation.non_local_name_description',
      onChange: section.reRender
    });
  }
);


export const uiSectionBetteridAI = makeSimpleSection(
  'preferences-betterid-ai',
  'preferences.ai.title',
  (selection, section) => {
    const groups = [
      { kind: 'search', label: 'preferences.ai.search_order' },
      { kind: 'text', label: 'preferences.ai.text_order' },
      { kind: 'vision', label: 'preferences.ai.vision_order' }
    ];

    let groupRows = selection.selectAll('.betterid-provider-group')
      .data(groups, d => d.kind);
    const groupEnter = groupRows.enter()
      .append('div')
      .attr('class', 'betterid-provider-group betterid-preference-subgroup');
    groupEnter.append('h4').call(d => d.each(function(item) {
      d3_select(this).call(t.append(item.label));
    }));
    groupEnter.append('ol').attr('class', 'betterid-order-list');
    groupRows = groupEnter.merge(groupRows);

    groupRows.each(function(group) {
      const order = getProviderOrder(group.kind);
      const list = d3_select(this).select('ol');
      const providers = list.selectAll('li').data(order, d => d);
      providers.exit().remove();
      const providersEnter = providers.enter().append('li');
      providersEnter.append('span').attr('class', 'betterid-order-name');
      const controls = providersEnter.append('span').attr('class', 'betterid-order-controls');
      controls.append('button')
        .attr('type', 'button')
        .attr('title', t('preferences.move_up'))
        .on('click', (event, provider) => moveProvider(event, group.kind, provider, -1))
        .call(svgIcon('#iD-icon-up'));
      controls.append('button')
        .attr('type', 'button')
        .attr('title', t('preferences.move_down'))
        .on('click', (event, provider) => moveProvider(event, group.kind, provider, 1))
        .call(svgIcon('#iD-icon-down'));
      providersEnter.merge(providers).select('.betterid-order-name')
        .call(d => d.each(function(provider) {
          d3_select(this).call(t.addOrUpdate(`preferences.ai.providers.${provider}`));
        }));
    });

    let support = selection.selectAll('.betterid-ai-support').data([0]);
    support = support.enter().append('p')
      .attr('class', 'betterid-ai-support')
      .merge(support);
    support.text('')
      .call(t.addOrUpdate('preferences.ai.free_notice', {
        donate: link => link.append('a')
          .attr('target', '_blank')
          .attr('rel', 'noopener noreferrer')
          .attr('href', 'https://blog.rainchan.com/pay/')
          .call(t.append('preferences.ai.donate')),
        qq: link => link.append('a')
          .attr('target', '_blank')
          .attr('rel', 'noopener noreferrer')
          .attr('href', 'https://qm.qq.com/q/O4npt9MhK')
          .call(t.append('preferences.ai.qq_group'))
      }));

    function moveProvider(event, kind, provider, offset) {
      event.preventDefault();
      const order = getProviderOrder(kind);
      const index = order.indexOf(provider);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      setProviderOrder(kind, order);
      section.reRender();
    }
  }
);


export const uiSectionBetteridExperimental = makeSimpleSection(
  'preferences-betterid-experimental',
  'preferences.experimental.title',
  (selection, section) => {
    const enabled = betteridBool(BETTERID_PREFS.experimental, false);
    renderCheckbox(selection, {
      className: 'preference-experimental-master',
      pref: BETTERID_PREFS.experimental,
      defaultValue: false,
      label: 'preferences.experimental.enabled',
      description: 'preferences.experimental.enabled_description',
      onChange: section.reRender
    });
    renderCheckbox(selection, {
      className: 'preference-dual-imagery',
      pref: BETTERID_PREFS.dualImagery,
      defaultValue: false,
      disabled: !enabled,
      label: 'preferences.experimental.dual_imagery',
      description: 'preferences.experimental.dual_imagery_description',
      onChange: section.reRender
    });
    renderCheckbox(selection, {
      className: 'preference-local-photo',
      pref: BETTERID_PREFS.localPhoto,
      defaultValue: false,
      disabled: !enabled,
      label: 'preferences.experimental.local_photo',
      description: 'preferences.experimental.local_photo_description',
      onChange: section.reRender
    });
    renderCheckbox(selection, {
      className: 'preference-indoor-focus',
      pref: BETTERID_PREFS.indoorFocus,
      defaultValue: false,
      disabled: !enabled,
      label: 'preferences.experimental.indoor_focus',
      description: 'preferences.experimental.indoor_focus_description',
      onChange: section.reRender
    });
    renderCheckbox(selection, {
      className: 'preference-wasd-navigation',
      pref: BETTERID_PREFS.wasdNavigation,
      defaultValue: false,
      disabled: !enabled,
      label: 'preferences.experimental.wasd_navigation',
      description: 'preferences.experimental.wasd_navigation_description',
      onChange: section.reRender
    });

    const wasdEnabled = enabled && betteridBool(BETTERID_PREFS.wasdNavigation, false);
    let navigationMode = selection.selectAll('.preference-navigation-mode')
      .data([prefs(BETTERID_PREFS.navigationMode) || 'walk']);
    const navigationModeEnter = navigationMode.enter()
      .append('label')
      .attr('class', 'preference-navigation-mode betterid-number-preference');
    navigationModeEnter.append('span').call(t.append('preferences.experimental.navigation_mode'));
    navigationModeEnter.append('select')
      .on('change', function() { prefs(BETTERID_PREFS.navigationMode, this.value); });
    navigationModeEnter.select('select').selectAll('option')
      .data(['walk', 'fly'])
      .enter()
      .append('option')
      .attr('value', d => d)
      .text(d => t(`preferences.experimental.navigation_${d}`));
    navigationMode = navigationModeEnter.merge(navigationMode);
    navigationMode.classed('disabled', !wasdEnabled);
    navigationMode.select('select')
      .property('disabled', !wasdEnabled)
      .property('value', prefs(BETTERID_PREFS.navigationMode) || 'walk');
  }
);
