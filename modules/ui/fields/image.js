import { dispatch as d3_dispatch } from 'd3-dispatch';
import { select as d3_select } from 'd3-selection';

import { actionChangeTags } from '../../actions/change_tags';
import { getProviderOrder } from '../../core/betterid_preferences';
import { t } from '../../core/localizer';
import { svgIcon } from '../../svg/icon';
import { utilRebind } from '../../util';
import { uiFieldText } from './input';


const BLOCKED_TAG_KEYS = new Set([
  'image', 'source', 'created_by', 'attribution', 'odbl', 'import'
]);


export function uiFieldImage(field, context) {
  const dispatch = d3_dispatch('change');
  const baseField = uiFieldText(field, context)
    .on('change.image-upload', baseFieldChanged);
  let _selection = d3_select(null);
  let _entityIDs = [];
  let _tags = {};
  let _upload = null;
  let _status = 'idle';
  let _message = '';
  let _analysis = null;
  let _analysisSnapshot = null;
  let _fileReader = null;
  let _uploadController = null;
  let _analysisController = null;
  let _uploadGeneration = 0;
  let _analysisGeneration = 0;
  let _disposed = false;


  function imageField(selection) {
    _selection = selection;
    selection.call(baseField);
    renderTools(selection);
  }


  function baseFieldChanged(tags, onInput) {
    if (_disposed) return;
    if (tags && Object.prototype.hasOwnProperty.call(tags, field.key) &&
        tags[field.key] !== selectedTags()[field.key]) {
      invalidateForImageChange(tags[field.key]);
      renderTools(_selection);
    }
    dispatch.call('change', imageField, tags, onInput);
  }


  function renderTools(selection) {
    let wrap = selection.selectAll('.image-upload-tools')
      .data(_entityIDs.length === 1 ? [0] : []);
    wrap.exit().remove();
    const enter = wrap.enter()
      .append('div')
      .attr('class', 'image-upload-tools');
    enter.append('p')
      .attr('class', 'image-upload-description')
      .call(t.append('inspector.image_upload.description'));

    const picker = enter.append('div').attr('class', 'image-upload-picker');
    picker.append('input')
      .attr('type', 'file')
      .attr('accept', 'image/jpeg,image/png,image/webp')
      .attr('id', `${field.domId}-upload`)
      .on('change', chooseImage);
    picker.append('label')
      .attr('for', `${field.domId}-upload`)
      .attr('class', 'button secondary-action')
      .call(svgIcon('#iD-icon-load', 'pre-text'))
      .append('span')
      .call(t.append('inspector.image_upload.choose'));

    enter.append('p').attr('class', 'image-upload-status');
    const preview = enter.append('div').attr('class', 'image-upload-preview');
    preview.append('img').attr('alt', t('inspector.image_upload.preview_alt'));
    preview.append('a')
      .attr('target', '_blank')
      .attr('rel', 'noopener noreferrer')
      .call(t.append('inspector.image_upload.open'));

    enter.append('button')
      .attr('type', 'button')
      .attr('class', 'image-analyze secondary-action')
      .on('click', analyzeImage)
      .call(svgIcon('#iD-icon-search', 'pre-text'))
      .append('span')
      .call(t.append('inspector.image_upload.analyze'));
    enter.append('div').attr('class', 'image-upload-analysis');
    wrap = enter.merge(wrap);

    wrap.classed('has-upload', !!_upload);
    wrap.select('.image-upload-status')
      .attr('class', `image-upload-status status-${_status}`)
      .text(statusText());
    wrap.select('.image-upload-preview img').attr('src', _upload?.publicURL || null);
    wrap.select('.image-upload-preview a').attr('href', _upload?.publicURL || null);
    wrap.select('.image-analyze')
      .property('disabled', !_upload || _status === 'uploading' || _status === 'analyzing');
    renderAnalysis(wrap.select('.image-upload-analysis'));
  }


  function chooseImage(event) {
    if (_disposed) return;
    const file = event.target.files?.[0];
    event.target.value = null;
    if (!file) return;

    clearPhotoState();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
      _status = 'error';
      _message = t('inspector.image_upload.invalid');
      renderTools(_selection);
      return;
    }

    _status = 'uploading';
    _message = '';
    renderTools(_selection);

    const snapshot = captureEntitySnapshot();
    if (!snapshot) {
      failUpload(t('inspector.image_upload.upload_error'));
      return;
    }

    const controller = new AbortController();
    const request = { generation: _uploadGeneration, snapshot, controller };
    _uploadController = controller;
    const reader = new FileReader();
    _fileReader = reader;
    reader.onerror = () => {
      if (!isCurrentUpload(request)) return;
      _fileReader = null;
      failUpload(t('inspector.image_upload.invalid'));
    };
    reader.onload = () => {
      if (!isCurrentUpload(request)) return;
      _fileReader = null;
      uploadImage(String(reader.result), file.type, request);
    };
    reader.readAsDataURL(file);
  }


  async function uploadImage(image, mimeType, request) {
    try {
      const response = await fetch('/api/osm-ai/photo-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: request.controller.signal,
        body: JSON.stringify({
          image,
          mime_type: mimeType,
          provider_order: getProviderOrder('vision')
        })
      });
      if (!isCurrentUpload(request)) return;
      const data = await response.json().catch(() => ({}));
      if (!isCurrentUpload(request)) return;
      if (!response.ok || !data.approved || !data.id || !data.url) {
        const reason = data.moderation?.reason_zh || data.moderation?.reason_en || data.error;
        throw new Error(reason || t('inspector.image_upload.rejected'));
      }
      const publicURL = new URL(String(data.url), window.location.origin);
      if (publicURL.origin !== window.location.origin ||
          !/^\/api\/osm-ai\/photos\/[a-f0-9]{64}\.jpg$/.test(publicURL.pathname)) {
        throw new Error(t('inspector.image_upload.upload_error'));
      }
      if (!isCurrentUpload(request)) return;
      _upload = {
        id: String(data.id),
        apiURL: String(data.url),
        publicURL: publicURL.href
      };
      _uploadController = null;
      _status = 'approved';
      _message = '';
      dispatch.call('change', imageField, { [field.key]: _upload.publicURL });
    } catch (error) {
      if (!isCurrentUpload(request)) return;
      failUpload(error.message);
      return;
    }
    renderTools(_selection);
  }


  function failUpload(message) {
    _uploadController = null;
    _fileReader = null;
    _status = 'error';
    _message = message || t('inspector.image_upload.upload_error');
    _upload = null;
    _analysis = null;
    renderTools(_selection);
  }


  function statusText() {
    if (_message) return _message;
    if (_status === 'uploading') return t('inspector.image_upload.uploading');
    if (_status === 'approved') return t('inspector.image_upload.approved');
    if (_status === 'analyzing') return t('inspector.image_upload.analyzing');
    return '';
  }


  /* eslint-disable require-atomic-updates */
  async function analyzeImage(event) {
    event.preventDefault();
    if (_disposed || !_upload || _status === 'analyzing') return;

    const snapshot = captureAnalysisSnapshot();
    if (!snapshot) return;
    invalidateAnalysis();
    const controller = new AbortController();
    const request = { generation: _analysisGeneration, snapshot, controller };
    _analysisController = controller;
    _status = 'analyzing';
    _message = '';
    renderTools(_selection);
    try {
      const response = await fetch('/api/osm-ai/photo-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: request.controller.signal,
        body: JSON.stringify({
          photo_id: snapshot.uploadID,
          url: snapshot.apiURL,
          context: {
            location: context.map().center(),
            selected_tags: selectedTags()
          },
          provider_order: getProviderOrder('vision')
        })
      });
      if (!isCurrentAnalysis(request)) return;
      const data = await response.json().catch(() => ({}));
      if (!isCurrentAnalysis(request)) return;
      if (!response.ok) throw new Error(data.error || t('inspector.image_upload.analysis_error'));
      _analysis = normalizeAnalysis(data);
      _analysisSnapshot = snapshot;
      _analysisController = null;
      _status = 'approved';
    } catch (error) {
      if (!isCurrentAnalysis(request)) return;
      _analysisController = null;
      _status = 'approved';
      _message = error.message;
    }
    renderTools(_selection);
  }
  /* eslint-enable require-atomic-updates */


  function selectedTags() {
    const entity = context.hasEntity(_entityIDs[0]);
    return entity?.tags || _tags || {};
  }


  function captureEntitySnapshot() {
    if (_entityIDs.length !== 1) return null;
    const entity = context.hasEntity(_entityIDs[0]);
    if (!entity) return null;
    return { entityID: entity.id, image: entity.tags[field.key] };
  }


  function entitySnapshotMatches(snapshot) {
    if (!snapshot || _entityIDs.length !== 1 || _entityIDs[0] !== snapshot.entityID) return false;
    const entity = context.hasEntity(snapshot.entityID);
    return !!entity && entity.tags[field.key] === snapshot.image;
  }


  function captureAnalysisSnapshot() {
    const entitySnapshot = captureEntitySnapshot();
    if (!entitySnapshot || !_upload) return null;
    return {
      ...entitySnapshot,
      uploadID: _upload.id,
      apiURL: _upload.apiURL,
      publicURL: _upload.publicURL
    };
  }


  function analysisSnapshotMatches(snapshot) {
    return entitySnapshotMatches(snapshot) &&
      _upload?.id === snapshot.uploadID &&
      _upload.apiURL === snapshot.apiURL &&
      _upload.publicURL === snapshot.publicURL;
  }


  function isCurrentUpload(request) {
    return !_disposed &&
      _uploadGeneration === request.generation &&
      _uploadController === request.controller &&
      !request.controller.signal.aborted &&
      entitySnapshotMatches(request.snapshot);
  }


  function isCurrentAnalysis(request) {
    return !_disposed &&
      _analysisGeneration === request.generation &&
      _analysisController === request.controller &&
      !request.controller.signal.aborted &&
      analysisSnapshotMatches(request.snapshot);
  }


  function invalidateUpload() {
    _uploadGeneration++;
    _uploadController?.abort();
    _uploadController = null;
    if (_fileReader?.readyState === 1) _fileReader.abort();
    _fileReader = null;
  }


  function invalidateAnalysis() {
    _analysisGeneration++;
    _analysisController?.abort();
    _analysisController = null;
    _analysis = null;
    _analysisSnapshot = null;
  }


  function clearPhotoState() {
    invalidateUpload();
    invalidateAnalysis();
    _upload = null;
    _status = 'idle';
    _message = '';
  }


  function invalidateForImageChange(image) {
    if (_upload?.publicURL === image) {
      invalidateAnalysis();
      _status = 'approved';
      _message = '';
    } else {
      clearPhotoState();
    }
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
    const data = _analysis && analysisSnapshotMatches(_analysisSnapshot) ? [_analysis] : [];
    let wrap = selection.selectAll('.photo-analysis-result').data(data);
    wrap.exit().remove();
    const enter = wrap.enter().append('div').attr('class', 'photo-analysis-result');
    enter.append('p').attr('class', 'photo-summary-zh');
    enter.append('p').attr('class', 'photo-summary-en');
    enter.append('ul');
    enter.append('button')
      .attr('type', 'button')
      .attr('class', 'photo-apply-tags action')
      .on('click', applyImageTags)
      .call(svgIcon('#iD-icon-apply', 'pre-text'))
      .append('span')
      .call(t.append('inspector.image_upload.apply_tags'));
    wrap = enter.merge(wrap);
    wrap.select('.photo-summary-zh').text(d => d.summary.zh || '');
    wrap.select('.photo-summary-en').text(d => d.summary.en || '');
    const items = wrap.select('ul').selectAll('li').data(d => d.suggestions, d => d.id);
    items.exit().remove();
    const itemEnter = items.enter().append('li');
    const label = itemEnter.append('label');
    label.append('input')
      .attr('type', 'checkbox')
      .on('change', function(event, item) {
        item.selected = this.checked;
        renderTools(_selection);
      });
    const content = label.append('span');
    content.append('code');
    content.append('small').attr('class', 'reason-zh');
    content.append('small').attr('class', 'reason-en');
    const merged = itemEnter.merge(items);
    merged.select('input').property('checked', d => d.selected);
    merged.select('code').text(d => `${d.key}=${d.value}`);
    merged.select('.reason-zh').text(d => d.reason.zh || '');
    merged.select('.reason-en').text(d => d.reason.en || '');
    wrap.select('.photo-apply-tags')
      .property('disabled', !analysisSnapshotMatches(_analysisSnapshot) ||
        !_analysis?.suggestions.some(item => item.selected));
  }


  function applyImageTags(event) {
    event.preventDefault();
    if (!_analysis || !analysisSnapshotMatches(_analysisSnapshot)) return;
    const entity = context.hasEntity(_analysisSnapshot.entityID);
    if (!entity) return;
    const tags = { ...entity.tags };
    for (const suggestion of _analysis.suggestions) {
      if (suggestion.selected) tags[suggestion.key] = suggestion.value;
    }
    context.perform(actionChangeTags(entity.id, tags), t('operations.change_tags.annotation'));
    context.validator().validate();
  }


  imageField.entityIDs = function(entityIDs) {
    if (!arguments.length) return _entityIDs;
    const nextEntityIDs = entityIDs || [];
    const changed = nextEntityIDs.length !== _entityIDs.length ||
      nextEntityIDs.some((entityID, index) => entityID !== _entityIDs[index]);
    if (changed) clearPhotoState();
    _entityIDs = nextEntityIDs;
    baseField.entityIDs(_entityIDs);
    if (!_selection.empty()) renderTools(_selection);
    return imageField;
  };


  imageField.tags = function(tags) {
    const nextTags = tags || {};
    if (_tags[field.key] !== nextTags[field.key]) {
      invalidateForImageChange(nextTags[field.key]);
    }
    _tags = nextTags;
    baseField.tags(_tags);
    if (!_selection.empty()) renderTools(_selection);
    return imageField;
  };


  imageField.focus = function() {
    baseField.focus();
  };


  imageField.dispose = function() {
    if (_disposed) return;
    _disposed = true;
    clearPhotoState();
    baseField.on('change.image-upload', null);
    _selection = d3_select(null);
  };


  return utilRebind(imageField, dispatch, 'on');
}


uiFieldImage.supportsMultiselection = false;
