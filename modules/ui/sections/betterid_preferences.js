import { select as d3_select } from 'd3-selection';

import {
  BETTERID_EDITABLE_ZOOMS,
  BETTERID_PREFS,
  betteridBool,
  getEditableZoom,
  getProviderOrder,
  getSnapTolerance,
  getTranslationLanguages,
  setBetteridBool,
  setProviderOrder,
  setTranslationLanguages
} from '../../core/betterid_preferences';
import { localizer, t } from '../../core/localizer';
import {
  BETTERID_AI_IMAGE_APIS,
  BETTERID_AI_PREFS,
  BETTERID_AI_PRESETS,
  directAiChat,
  setUserAiProvider,
  userAiProvider
} from '../../core/betterid_ai';
import {
  BETTERID_SHORTCUT_PRESET_PREF,
  BETTERID_SHORTCUT_PRESETS
} from '../../core/betterid_tools';
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


function renderSelect(selection, options) {
  const current = prefs(options.pref) || options.defaultValue;
  let row = selection.selectAll(`.${options.className}`)
    .data([current]);

  const rowEnter = row.enter()
    .append('label')
    .attr('class', `betterid-preference-row ${options.className}`);

  rowEnter.append('span')
    .attr('class', 'betterid-preference-label')
    .call(t.append(options.label));

  const select = rowEnter.append('select')
    .on('change', function() {
      prefs(options.pref, this.value);
      if (options.onChange) options.onChange(this.value);
    });

  select.selectAll('option')
    .data(options.options)
    .enter()
    .append('option')
    .attr('value', d => d.value)
    .each(function(d) {
      d3_select(this).call(t.append(d.label));
    });

  if (options.description) {
    rowEnter.append('small')
      .call(t.append(options.description));
  }

  row = rowEnter.merge(row);
  row.select('select').property('value', current);
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
    renderCheckbox(selection, {
      className: 'preference-indoor-focus',
      pref: BETTERID_PREFS.indoorFocus,
      defaultValue: false,
      label: 'preferences.general.indoor_focus',
      description: 'preferences.general.indoor_focus_description',
      onChange: section.reRender
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
    renderSelect(selection, {
      className: 'preference-shortcut-preset',
      pref: BETTERID_SHORTCUT_PRESET_PREF,
      defaultValue: 'off',
      label: 'preferences.editing.shortcut_preset',
      description: 'preferences.editing.shortcut_preset_description',
      options: BETTERID_SHORTCUT_PRESETS.map(value => ({
        value: value,
        label: 'preferences.editing.shortcut_preset_' + value
      })),
      onChange: section.reRender
    });

    renderSelect(selection, {
      className: 'preference-editable-zoom',
      pref: BETTERID_PREFS.editableZoom,
      defaultValue: String(getEditableZoom()),
      label: 'preferences.editing.editable_zoom',
      description: 'preferences.editing.editable_zoom_description',
      options: BETTERID_EDITABLE_ZOOMS.map(value => ({
        value: String(value),
        label: 'preferences.editing.editable_zoom_' + value
      })),
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


function renderTextRow(selection, options) {
  const current = prefs(options.pref) || '';
  let row = selection.selectAll(`.${options.className}`).data([0]);

  const rowEnter = row.enter()
    .append('label')
    .attr('class', `betterid-preference-row betterid-preference-text ${options.className}`);

  rowEnter.append('span')
    .attr('class', 'betterid-preference-label')
    .call(t.append(options.label));

  const wrap = rowEnter.append('span').attr('class', 'betterid-preference-input');
  wrap.append('input')
    .attr('type', options.type || 'text')
    .attr('autocomplete', 'off')
    .attr('spellcheck', 'false')
    .attr('placeholder', options.placeholder || null)
    .on('change', function() {
      options.onChange(this.value);
    });

  if (options.type === 'password') {
    // the key is pasted blind otherwise; a reveal toggle avoids typos
    wrap.append('button')
      .attr('type', 'button')
      .attr('class', 'betterid-reveal')
      .attr('title', t('preferences.ai.custom.reveal'))
      .on('click', function(d3_event) {
        d3_event.preventDefault();
        const input = d3_select(this.parentNode).select('input');
        input.attr('type', input.attr('type') === 'password' ? 'text' : 'password');
      })
      .call(svgIcon('#iD-icon-search'));
  }

  if (options.description) {
    rowEnter.append('small').call(t.append(options.description));
  }

  row = rowEnter.merge(row);
  row.classed('disabled', !!options.disabled);
  const input = row.select('input');
  if (input.node() !== document.activeElement) input.property('value', current);
  input.property('disabled', !!options.disabled);
}


export const uiSectionBetteridAI = makeSimpleSection(
  'preferences-betterid-ai',
  'preferences.ai.title',
  (selection, section) => {
    const provider = userAiProvider();
    const custom = betteridBool(BETTERID_AI_PREFS.enabled, false);

    /* --- the user's own provider ------------------------------------- */

    let own = selection.selectAll('.betterid-ai-custom').data([0]);
    own = own.enter().append('div')
      .attr('class', 'betterid-ai-custom betterid-preference-subgroup')
      .merge(own);

    renderCheckbox(own, {
      className: 'betterid-ai-custom-enabled',
      pref: BETTERID_AI_PREFS.enabled,
      defaultValue: false,
      label: 'preferences.ai.custom.enabled',
      description: 'preferences.ai.custom.enabled_description',
      onChange: section.reRender
    });

    let form = own.selectAll('.betterid-ai-custom-form').data(custom ? [0] : []);
    form.exit().remove();
    form = form.enter().append('div')
      .attr('class', 'betterid-ai-custom-form')
      .merge(form);

    if (custom) {
      // a preset only pre-fills the form
      const presetRow = form.selectAll('.betterid-ai-preset').data([0]);
      const presetEnter = presetRow.enter().append('label')
        .attr('class', 'betterid-preference-row betterid-ai-preset');
      presetEnter.append('span')
        .attr('class', 'betterid-preference-label')
        .call(t.append('preferences.ai.custom.preset'));
      const presetSelect = presetEnter.append('select')
        .on('change', function() {
          const preset = BETTERID_AI_PRESETS.find(p => p.id === this.value);
          if (!preset) return;
          setUserAiProvider({
            baseUrl: preset.baseUrl,
            textModel: preset.textModel,
            visionModel: preset.visionModel,
            imageModel: preset.imageModel,
            imageApi: preset.imageApi
          });
          this.value = '';
          section.reRender();
        });
      presetSelect.append('option').attr('value', '').call(t.append('preferences.ai.custom.preset_pick'));
      presetSelect.selectAll('option.preset')
        .data(BETTERID_AI_PRESETS)
        .enter()
        .append('option')
        .attr('class', 'preset')
        .attr('value', d => d.id)
        .each(function(d) {
          d3_select(this).call(t.append(`preferences.ai.custom.presets.${d.id}`));
        });

      renderTextRow(form, {
        className: 'betterid-ai-base-url',
        pref: BETTERID_AI_PREFS.baseUrl,
        label: 'preferences.ai.custom.base_url',
        placeholder: 'https://api.openai.com/v1',
        onChange: value => { setUserAiProvider({ baseUrl: value }); section.reRender(); }
      });
      renderTextRow(form, {
        className: 'betterid-ai-api-key',
        pref: BETTERID_AI_PREFS.apiKey,
        type: 'password',
        label: 'preferences.ai.custom.api_key',
        description: 'preferences.ai.custom.api_key_description',
        onChange: value => { setUserAiProvider({ apiKey: value }); section.reRender(); }
      });
      renderTextRow(form, {
        className: 'betterid-ai-text-model',
        pref: BETTERID_AI_PREFS.textModel,
        label: 'preferences.ai.custom.text_model',
        placeholder: 'gpt-5-mini',
        onChange: value => setUserAiProvider({ textModel: value })
      });
      renderTextRow(form, {
        className: 'betterid-ai-vision-model',
        pref: BETTERID_AI_PREFS.visionModel,
        label: 'preferences.ai.custom.vision_model',
        description: 'preferences.ai.custom.vision_model_description',
        onChange: value => setUserAiProvider({ visionModel: value })
      });
      renderTextRow(form, {
        className: 'betterid-ai-image-model',
        pref: BETTERID_AI_PREFS.imageModel,
        label: 'preferences.ai.custom.image_model',
        description: 'preferences.ai.custom.image_model_description',
        placeholder: 'gpt-image-1',
        onChange: value => setUserAiProvider({ imageModel: value })
      });
      renderSelect(form, {
        className: 'betterid-ai-image-api',
        pref: BETTERID_AI_PREFS.imageApi,
        defaultValue: 'images',
        label: 'preferences.ai.custom.image_api',
        options: BETTERID_AI_IMAGE_APIS.map(value => ({ value, label: `preferences.ai.custom.image_api_${value}` })),
        onChange: section.reRender
      });
      renderCheckbox(form, {
        className: 'betterid-ai-disable-thinking',
        pref: BETTERID_AI_PREFS.disableThinking,
        defaultValue: false,
        label: 'preferences.ai.custom.disable_thinking',
        description: 'preferences.ai.custom.disable_thinking_description'
      });

      // a round trip, so a wrong URL or key shows up here and not later
      let test = form.selectAll('.betterid-ai-test').data([0]);
      const testEnter = test.enter().append('div').attr('class', 'betterid-ai-test');
      testEnter.append('button')
        .attr('type', 'button')
        .attr('class', 'action')
        .call(t.append('preferences.ai.custom.test'))
        .on('click', function(d3_event) {
          d3_event.preventDefault();
          const button = d3_select(this);
          const result = d3_select(this.parentNode).select('.betterid-ai-test-result');
          if (!userAiProvider()) {
            result.attr('class', 'betterid-ai-test-result error').text(t('preferences.ai.custom.test_incomplete'));
            return;
          }
          button.property('disabled', true);
          result.attr('class', 'betterid-ai-test-result').text(t('preferences.ai.custom.testing'));
          directAiChat({ prompt: 'Reply with the single word OK.', maxTokens: 16 })
            .then(text => {
              result.attr('class', 'betterid-ai-test-result ok')
                .text(t('preferences.ai.custom.test_ok', { answer: text.trim().slice(0, 40) }));
            })
            .catch(error => {
              result.attr('class', 'betterid-ai-test-result error')
                .text(t('preferences.ai.custom.test_failed', { message: error.message }));
            })
            .finally(() => button.property('disabled', false));
        });
      testEnter.append('span').attr('class', 'betterid-ai-test-result');
      test = testEnter.merge(test);
      test.select('button').property('disabled', !provider);
    }

    /* --- the deployment's providers ---------------------------------- */

    const groups = [
      { kind: 'search', label: 'preferences.ai.search_order' },
      { kind: 'text', label: 'preferences.ai.text_order' },
      { kind: 'vision', label: 'preferences.ai.vision_order' }
    ];

    // the desktop app has no server, so there is nothing to order there
    let server = selection.selectAll('.betterid-ai-server').data(globalThis.BETTERID_DESKTOP ? [] : [0]);
    server.exit().remove();
    server = server.enter().append('div')
      .attr('class', 'betterid-ai-server')
      .merge(server);

    let groupRows = server.selectAll('.betterid-provider-group')
      .data(groups, d => d.kind);
    const groupEnter = groupRows.enter()
      .append('div')
      .attr('class', 'betterid-provider-group betterid-preference-subgroup');
    groupEnter.append('h4').call(d => d.each(function(item) {
      d3_select(this).call(t.append(item.label));
    }));
    groupEnter.append('ol').attr('class', 'betterid-order-list');
    groupRows = groupEnter.merge(groupRows);
    groupRows.classed('disabled', custom);

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

    let support = server.selectAll('.betterid-ai-support').data([0]);
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
