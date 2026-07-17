import { select as d3_select } from 'd3-selection';

import { actionChangeTags } from '../../actions/change_tags';
import {
  BETTERID_PREFS,
  experimentalFeatureEnabled,
  getProviderOrder
} from '../../core/betterid_preferences';
import { t } from '../../core/localizer';
import { prefs } from '../../core/preferences';
import { svgIcon } from '../../svg/icon';
import { uiSection } from '../section';


const BLOCKED_TAG_KEYS = new Set(['source', 'created_by', 'attribution', 'odbl', 'import']);


export function uiSectionExperimentalBackground(context) {
  let _photo = null;
  let _photoStatus = 'idle';
  let _photoMessage = '';
  let _analysis = null;

  const section = uiSection('background-experimental', context)
    .label(() => t.append('background.experimental.title'))
    .shouldDisplay(() => dualEnabled() || photoEnabled())
    .disclosureContent(render);


  function dualEnabled() {
    return experimentalFeatureEnabled(BETTERID_PREFS.dualImagery);
  }


  function photoEnabled() {
    return experimentalFeatureEnabled(BETTERID_PREFS.localPhoto);
  }


  function render(selection) {
    renderDualImagery(selection);
    renderPhoto(selection);
  }


  function renderDualImagery(selection) {
    let wrap = selection.selectAll('.dual-imagery-controls')
      .data(dualEnabled() ? [0] : []);
    wrap.exit().remove();
    const wrapEnter = wrap.enter()
      .append('div')
      .attr('class', 'dual-imagery-controls experimental-background-group');
    wrapEnter.append('h4').call(t.append('background.experimental.dual_title'));
    const sourceLabel = wrapEnter.append('label');
    sourceLabel.append('span').call(t.append('background.experimental.second_source'));
    sourceLabel.append('select').on('change', changeSecondarySource);
    const opacityLabel = wrapEnter.append('label');
    opacityLabel.append('span').call(t.append('background.experimental.second_opacity'));
    opacityLabel.append('input')
      .attr('type', 'range')
      .attr('min', 0)
      .attr('max', 1)
      .attr('step', 0.01)
      .on('input', function() {
        const value = Number(this.value);
        prefs('betterid.background.secondary_opacity', String(value));
        context.background().secondaryOpacity(value);
        d3_select(this.parentNode).select('output').text(`${Math.round(value * 100)}%`);
      });
    opacityLabel.append('output');
    wrap = wrapEnter.merge(wrap);

    if (dualEnabled()) {
      const background = context.background();
      const current = background.baseLayerSource();
      const sources = background.sources(context.map().extent(), context.map().zoom(), true)
        .filter(source => !source.overlay && !source.isHidden() && source.id !== current?.id && source.id !== 'none')
        .sort((a, b) => a.name().localeCompare(b.name()));
      const selectedID = prefs('betterid.background.secondary_source') || '';
      const options = wrap.select('select').selectAll('option')
        .data([{ id: '', name: () => t('background.none') }, ...sources], d => d.id);
      options.exit().remove();
      options.enter().append('option')
        .merge(options)
        .attr('value', d => d.id)
        .text(d => d.name());
      wrap.select('select').property('value', selectedID);

      const selected = sources.find(source => source.id === selectedID) || null;
      if (background.secondaryLayerSource() !== selected) background.secondaryLayerSource(selected);
      const storedOpacity = Number.parseFloat(prefs('betterid.background.secondary_opacity'));
      const opacity = Number.isFinite(storedOpacity) ?
        Math.max(0, Math.min(1, storedOpacity)) : 0.5;
      background.secondaryOpacity(opacity);
      wrap.select('input[type="range"]').property('value', opacity);
      wrap.select('output').text(`${Math.round(opacity * 100)}%`);
    } else if (context.background().secondaryLayerSource()) {
      context.background().secondaryLayerSource(null);
    }
  }


  function changeSecondarySource() {
    const id = this.value;
    prefs('betterid.background.secondary_source', id || null);
    context.background().secondaryLayerSource(id ? context.background().findSource(id) : null);
    section.reRender();
  }


  function renderPhoto(selection) {
    let wrap = selection.selectAll('.local-photo-background-controls')
      .data(photoEnabled() ? [0] : []);
    wrap.exit().remove();
    const wrapEnter = wrap.enter()
      .append('div')
      .attr('class', 'local-photo-background-controls experimental-background-group');
    wrapEnter.append('h4').call(t.append('background.experimental.photo_title'));
    wrapEnter.append('p')
      .attr('class', 'local-photo-instructions')
      .call(t.append('background.experimental.photo_instructions'));

    const picker = wrapEnter.append('div').attr('class', 'local-photo-picker');
    picker.append('input')
      .attr('type', 'file')
      .attr('accept', 'image/jpeg,image/png,image/webp')
      .attr('id', 'betterid-background-photo')
      .on('change', choosePhoto);
    picker.append('label')
      .attr('for', 'betterid-background-photo')
      .attr('class', 'button secondary-action')
      .call(svgIcon('#iD-icon-load', 'pre-text'))
      .append('span')
      .call(t.append('background.experimental.choose_photo'));

    wrapEnter.append('p').attr('class', 'local-photo-status');
    const preview = wrapEnter.append('div').attr('class', 'local-photo-preview');
    preview.append('img').attr('alt', t('background.experimental.photo_preview_alt'));
    preview.append('a')
      .attr('target', '_blank')
      .attr('rel', 'noopener noreferrer')
      .call(t.append('background.experimental.open_public_photo'));

    const controls = wrapEnter.append('div').attr('class', 'local-photo-transform-controls');
    addRange(controls, 'opacity', 0.05, 1, 0.01, 'background.experimental.photo_opacity');
    addRange(controls, 'scale', 0.1, 3, 0.01, 'background.experimental.photo_scale');
    addRange(controls, 'rotation', -180, 180, 1, 'background.experimental.photo_rotation');

    const actions = wrapEnter.append('div').attr('class', 'local-photo-actions');
    actions.append('button')
      .attr('type', 'button')
      .attr('class', 'photo-adjust secondary-action')
      .on('click', togglePhotoAdjustment)
      .call(svgIcon('#iD-icon-edit', 'pre-text'))
      .append('span');
    actions.append('button')
      .attr('type', 'button')
      .attr('class', 'photo-analyze secondary-action')
      .on('click', analyzePhoto)
      .call(svgIcon('#iD-icon-search', 'pre-text'))
      .append('span')
      .call(t.append('background.experimental.analyze_photo'));
    actions.append('button')
      .attr('type', 'button')
      .attr('class', 'photo-remove secondary-action')
      .on('click', removePhoto)
      .call(svgIcon('#iD-operation-delete', 'pre-text'))
      .append('span')
      .call(t.append('background.experimental.remove_photo'));

    wrapEnter.append('div').attr('class', 'local-photo-analysis');
    wrap = wrapEnter.merge(wrap);

    wrap.classed('has-photo', !!_photo);
    wrap.select('.local-photo-status')
      .attr('class', `local-photo-status status-${_photoStatus}`)
      .text(statusText());
    wrap.select('.local-photo-preview img').attr('src', _photo?.url || null);
    wrap.select('.local-photo-preview a')
      .attr('href', _photo?.url || null);
    wrap.select('.photo-adjust span')
      .text(t(_photo?.adjust ? 'background.experimental.finish_adjusting' : 'background.experimental.adjust_photo'));
    wrap.selectAll('.photo-adjust,.photo-analyze,.photo-remove').property('disabled', !_photo || _photoStatus === 'analyzing');

    if (_photo) {
      for (const key of ['opacity', 'scale', 'rotation']) {
        wrap.select(`.photo-control-${key} input`).property('value', _photo[key]);
        updateRangeOutput(wrap.select(`.photo-control-${key}`), key, _photo[key]);
      }
    }
    renderAnalysis(wrap.select('.local-photo-analysis'));

    if (!photoEnabled() && context.background().localPhoto()) {
      context.background().localPhoto(null);
    }
  }


  function addRange(container, key, min, max, step, label) {
    const row = container.append('label').attr('class', `photo-control-${key}`);
    row.append('span').call(t.append(label));
    row.append('input')
      .attr('type', 'range')
      .attr('min', min)
      .attr('max', max)
      .attr('step', step)
      .on('input', function() {
        if (!_photo) return;
        _photo[key] = Number(this.value);
        context.background().localPhoto(_photo);
        updateRangeOutput(d3_select(this.parentNode), key, _photo[key]);
      });
    row.append('output');
  }


  function updateRangeOutput(row, key, value) {
    const text = key === 'opacity' ? `${Math.round(value * 100)}%` :
      key === 'rotation' ? `${Math.round(value)} deg` : `${Number(value).toFixed(2)}x`;
    row.select('output').text(text);
  }


  function choosePhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = null;
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
      _photoStatus = 'error';
      _photoMessage = t('background.experimental.invalid_photo');
      section.reRender();
      return;
    }

    _photoStatus = 'uploading';
    _photoMessage = '';
    _analysis = null;
    section.reRender();
    const reader = new FileReader();
    reader.onerror = () => failPhoto(t('background.experimental.invalid_photo'));
    reader.onload = () => uploadPhoto(String(reader.result), file.type);
    reader.readAsDataURL(file);
  }


  async function uploadPhoto(image, mimeType) {
    try {
      const response = await fetch('/api/osm-ai/photo-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image,
          mime_type: mimeType,
          provider_order: getProviderOrder('vision')
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.approved || !data.url) {
        const reason = data.moderation?.reason_zh || data.moderation?.reason?.zh || data.moderation?.zh || data.error;
        throw new Error(reason || t('background.experimental.photo_rejected'));
      }
      _photo = {
        id: data.id,
        url: data.url,
        anchor: context.map().center(),
        zoom: context.map().zoom(),
        width: Math.min(720, Math.max(160, Number(data.width) || 640)),
        height: Number(data.height) || 480,
        opacity: 0.7,
        scale: 1,
        rotation: 0,
        adjust: true
      };
      _photoStatus = 'approved';
      context.background().localPhoto(_photo);
      section.reRender();
    } catch (error) {
      failPhoto(error.message);
    }
  }


  function failPhoto(message) {
    _photoStatus = 'error';
    _photoMessage = message || t('background.experimental.photo_upload_error');
    _photo = null;
    context.background().localPhoto(null);
    section.reRender();
  }


  function statusText() {
    if (_photoMessage) return _photoMessage;
    if (_photoStatus === 'uploading') return t('background.experimental.photo_uploading');
    if (_photoStatus === 'approved') return t('background.experimental.photo_approved');
    if (_photoStatus === 'analyzing') return t('background.experimental.photo_analyzing');
    return '';
  }


  function togglePhotoAdjustment(event) {
    event.preventDefault();
    if (!_photo) return;
    _photo.adjust = !_photo.adjust;
    context.background().localPhoto(_photo);
    section.reRender();
  }


  function removePhoto(event) {
    event.preventDefault();
    _photo = null;
    _analysis = null;
    _photoStatus = 'idle';
    _photoMessage = '';
    context.background().localPhoto(null);
    section.reRender();
  }


  /* eslint-disable require-atomic-updates */
  async function analyzePhoto(event) {
    event.preventDefault();
    if (!_photo || _photoStatus === 'analyzing') return;
    _photoStatus = 'analyzing';
    _photoMessage = '';
    section.reRender();
    try {
      const response = await fetch('/api/osm-ai/photo-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photo_id: _photo.id,
          url: _photo.url,
          context: {
            location: context.map().center(),
            selected_tags: selectedTags()
          },
          provider_order: getProviderOrder('vision')
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || t('background.experimental.photo_analysis_error'));
      _analysis = normalizeAnalysis(data);
      _photoStatus = 'approved';
    } catch (error) {
      _photoStatus = 'approved';
      _photoMessage = error.message;
    }
    section.reRender();
  }
  /* eslint-enable require-atomic-updates */


  function selectedTags() {
    if (context.selectedIDs().length !== 1) return {};
    return context.hasEntity(context.selectedIDs()[0])?.tags || {};
  }


  function normalizeAnalysis(data) {
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.map((item, index) => {
      const key = context.cleanTagKey(String(item.key || '').trim());
      const value = context.cleanTagValue(String(item.value || '').trim());
      if (!key || !value || BLOCKED_TAG_KEYS.has(key) || key.startsWith('source:') || key.startsWith('tiger:')) return null;
      return {
        id: `${index}-${key}`,
        key,
        value,
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        reason: item.reason || {},
        selected: Number(item.confidence) >= 0.6
      };
    }).filter(Boolean).slice(0, 20) : [];
    return { summary: data.summary || {}, reasons: data.reasons || {}, suggestions };
  }


  function renderAnalysis(selection) {
    const data = _analysis ? [_analysis] : [];
    let wrap = selection.selectAll('.photo-analysis-result').data(data);
    wrap.exit().remove();
    const enter = wrap.enter().append('div').attr('class', 'photo-analysis-result');
    enter.append('p').attr('class', 'photo-summary-zh');
    enter.append('p').attr('class', 'photo-summary-en');
    enter.append('ul');
    enter.append('button')
      .attr('type', 'button')
      .attr('class', 'photo-apply-tags action')
      .on('click', applyPhotoTags)
      .call(svgIcon('#iD-icon-apply', 'pre-text'))
      .append('span')
      .call(t.append('background.experimental.apply_photo_tags'));
    wrap = enter.merge(wrap);
    wrap.select('.photo-summary-zh').text(d => d.summary.zh || '');
    wrap.select('.photo-summary-en').text(d => d.summary.en || '');
    const items = wrap.select('ul').selectAll('li').data(d => d.suggestions, d => d.id);
    items.exit().remove();
    const itemEnter = items.enter().append('li');
    const label = itemEnter.append('label');
    label.append('input')
      .attr('type', 'checkbox')
      .on('change', function(event, item) { item.selected = this.checked; section.reRender(); });
    const content = label.append('span');
    content.append('code');
    content.append('small').attr('class', 'reason-zh');
    content.append('small').attr('class', 'reason-en');
    const merged = itemEnter.merge(items);
    merged.select('input').property('checked', d => d.selected);
    merged.select('code').text(d => `${d.key}=${d.value}`);
    merged.select('.reason-zh').text(d => d.reason.zh || '');
    merged.select('.reason-en').text(d => d.reason.en || '');
    wrap.select('.photo-apply-tags').property('disabled', context.selectedIDs().length !== 1 || !_analysis?.suggestions.some(item => item.selected));
  }


  function applyPhotoTags(event) {
    event.preventDefault();
    if (!_analysis || context.selectedIDs().length !== 1) return;
    const entity = context.hasEntity(context.selectedIDs()[0]);
    if (!entity) return;
    const tags = { ...entity.tags };
    for (const suggestion of _analysis.suggestions) {
      if (suggestion.selected) tags[suggestion.key] = suggestion.value;
    }
    context.perform(actionChangeTags(entity.id, tags), t('operations.change_tags.annotation'));
    context.validator().validate();
  }


  function experimentalPreferencesChanged() {
    if (!dualEnabled()) context.background().secondaryLayerSource(null);
    if (!photoEnabled()) context.background().localPhoto(null);
    section.reRender();
  }

  prefs.onChange(BETTERID_PREFS.experimental, experimentalPreferencesChanged);
  prefs.onChange(BETTERID_PREFS.dualImagery, experimentalPreferencesChanged);
  prefs.onChange(BETTERID_PREFS.localPhoto, experimentalPreferencesChanged);
  context.background().on('change.experimental-background', section.reRender);

  return section;
}
