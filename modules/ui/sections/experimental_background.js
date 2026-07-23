import { select as d3_select } from 'd3-selection';

import {
  BETTERID_PREFS,
  experimentalFeatureEnabled,
  getSecondaryBackgroundOpacity,
  setSecondaryBackgroundOpacity
} from '../../core/betterid_preferences';
import { t } from '../../core/localizer';
import { prefs } from '../../core/preferences';
import { svgIcon } from '../../svg/icon';
import { uiSection } from '../section';

const LOCAL_PHOTO_FILE_INPUT_ID = 'betterid-background-photo';
const LOCAL_PHOTO_FILE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const LOCAL_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
const PHOTO_TRANSFORM_CONTROLS = Object.freeze([
  Object.freeze({ key: 'opacity', min: 0.05, max: 1, step: 0.01, label: 'background.experimental.photo_opacity' }),
  Object.freeze({ key: 'scale', min: 0.1, max: 3, step: 0.01, label: 'background.experimental.photo_scale' }),
  Object.freeze({ key: 'rotation', min: -180, max: 180, step: 1, label: 'background.experimental.photo_rotation' })
]);


export function uiSectionExperimentalBackground(context) {
  let _photo = null;
  let _photoStatus = 'idle';
  let _photoMessage = '';

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
        setSecondaryBackgroundOpacity(value);
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
      const selectedID = prefs(BETTERID_PREFS.backgroundSecondarySource) || '';
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
      const opacity = getSecondaryBackgroundOpacity();
      background.secondaryOpacity(opacity);
      wrap.select('input[type="range"]').property('value', opacity);
      wrap.select('output').text(`${Math.round(opacity * 100)}%`);
    } else if (context.background().secondaryLayerSource()) {
      context.background().secondaryLayerSource(null);
    }
  }


  function changeSecondarySource() {
    const id = this.value;
    prefs(BETTERID_PREFS.backgroundSecondarySource, id || null);
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
      .attr('accept', LOCAL_PHOTO_FILE_TYPES.join(','))
      .attr('id', LOCAL_PHOTO_FILE_INPUT_ID)
      .on('change', choosePhoto);
    picker.append('label')
      .attr('for', LOCAL_PHOTO_FILE_INPUT_ID)
      .attr('class', 'button secondary-action')
      .call(svgIcon('#iD-icon-load', 'pre-text'))
      .append('span')
      .call(t.append('background.experimental.choose_photo'));

    wrapEnter.append('p').attr('class', 'local-photo-status');
    const preview = wrapEnter.append('div').attr('class', 'local-photo-preview');
    preview.append('img').attr('alt', t('background.experimental.photo_preview_alt'));

    const controls = wrapEnter.append('div').attr('class', 'local-photo-transform-controls');
    for (const control of PHOTO_TRANSFORM_CONTROLS) {
      addRange(controls, control);
    }

    const actions = wrapEnter.append('div').attr('class', 'local-photo-actions');
    actions.append('button')
      .attr('type', 'button')
      .attr('class', 'photo-adjust secondary-action')
      .on('click', togglePhotoAdjustment)
      .call(svgIcon('#iD-icon-edit', 'pre-text'))
      .append('span');
    actions.append('button')
      .attr('type', 'button')
      .attr('class', 'photo-remove secondary-action')
      .on('click', removePhoto)
      .call(svgIcon('#iD-operation-delete', 'pre-text'))
      .append('span')
      .call(t.append('background.experimental.remove_photo'));

    wrap = wrapEnter.merge(wrap);

    wrap.classed('has-photo', !!_photo);
    wrap.select('.local-photo-status')
      .attr('class', `local-photo-status status-${_photoStatus}`)
      .text(statusText());
    wrap.select('.local-photo-preview img').attr('src', _photo?.url || null);
    wrap.select('.photo-adjust span')
      .text(t(_photo?.adjust ? 'background.experimental.finish_adjusting' : 'background.experimental.adjust_photo'));
    wrap.selectAll('.photo-adjust,.photo-remove').property('disabled', !_photo);

    if (_photo) {
      for (const key of ['opacity', 'scale', 'rotation']) {
        wrap.select(`.photo-control-${key} input`).property('value', _photo[key]);
        updateRangeOutput(wrap.select(`.photo-control-${key}`), key, _photo[key]);
      }
    }
    if (!photoEnabled() && context.background().localPhoto()) {
      context.background().localPhoto(null);
    }
  }


  function addRange(container, control) {
    const row = container.append('label').attr('class', `photo-control-${control.key}`);
    row.append('span').call(t.append(control.label));
    row.append('input')
      .attr('type', 'range')
      .attr('min', control.min)
      .attr('max', control.max)
      .attr('step', control.step)
      .on('input', function() {
        if (!_photo) return;
        _photo[control.key] = Number(this.value);
        context.background().localPhoto(_photo);
        updateRangeOutput(d3_select(this.parentNode), control.key, _photo[control.key]);
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
    if (!LOCAL_PHOTO_FILE_TYPES.includes(file.type) || file.size > LOCAL_PHOTO_MAX_BYTES) {
      _photoStatus = 'error';
      _photoMessage = t('background.experimental.invalid_photo');
      section.reRender();
      return;
    }

    _photoStatus = 'loading';
    _photoMessage = '';
    section.reRender();
    const reader = new FileReader();
    reader.onerror = () => failPhoto(t('background.experimental.invalid_photo'));
    reader.onload = () => useLocalPhoto(String(reader.result));
    reader.readAsDataURL(file);
  }


  function useLocalPhoto(image) {
    _photo = {
      id: `local-${Date.now()}`,
      url: image,
      anchor: context.map().center(),
      zoom: context.map().zoom(),
      width: 640,
      height: 480,
      opacity: 0.7,
      scale: 1,
      rotation: 0,
      adjust: true
    };
    _photoStatus = 'ready';
    context.background().localPhoto(_photo);
    section.reRender();
  }


  function failPhoto(message) {
    _photoStatus = 'error';
    _photoMessage = message || t('background.experimental.photo_load_error');
    _photo = null;
    context.background().localPhoto(null);
    section.reRender();
  }


  function statusText() {
    if (_photoMessage) return _photoMessage;
    if (_photoStatus === 'loading') return t('background.experimental.photo_loading');
    if (_photoStatus === 'ready') return t('background.experimental.photo_ready');
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
    _photoStatus = 'idle';
    _photoMessage = '';
    context.background().localPhoto(null);
    section.reRender();
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
