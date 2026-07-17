import { dispatch as d3_dispatch } from 'd3-dispatch';
import { select as d3_select } from 'd3-selection';

import { localizer, t } from '../../core/localizer';
import { getProviderOrder } from '../../core/betterid_preferences';
import { svgIcon } from '../../svg/icon';
import { utilArrayIdentical } from '../../util/array';
import { utilNoAuto, utilRebind } from '../../util';
import { uiSection } from '../section';
const BLOCKED_TAG_KEYS = new Set([
    'image', 'source', 'created_by', 'attribution', 'odbl', 'import',
    'timestamp', 'version', 'changeset', 'uid', 'user', 'visible'
]);
const BLOCKED_TAG_PREFIXES = ['source:', 'tiger:', 'odbl:', 'metadata:'];
const MAX_DESCRIPTION_CHARS = 1200;
const MAX_TAGS = 100;
const MAX_SUGGESTIONS = 8;
const MAX_SUGGESTION_CANDIDATES = 64;
const MAX_SOURCES = 4;
const MAX_SOURCE_CANDIDATES = 32;
const MAX_WARNINGS = 4;
const MAX_WARNING_CANDIDATES = 32;
const MAX_SUMMARY_CHARS = 300;
const MAX_REASON_CHARS = 240;
const MAX_WARNING_CHARS = 160;
const MAX_SOURCE_TITLE_CHARS = 160;
const MAX_SOURCE_URL_CHARS = 2048;
const MAX_SOURCE_SNIPPET_CHARS = 240;


function limitedText(value, maxChars) {
    if (typeof value !== 'string') return '';
    const chars = Array.from(value.trim());
    return chars.length > maxChars ? chars.slice(0, maxChars).join('') : chars.join('');
}


function blockedTagKey(key) {
    const normalized = key.toLowerCase();
    return BLOCKED_TAG_KEYS.has(normalized) ||
        BLOCKED_TAG_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

export function uiSectionAiTagAssistant(context) {
    const dispatch = d3_dispatch('change');
    let _entityIDs = [];
    let _tags = {};
    let _state;
    let _description = '';
    let _status = 'idle';
    let _error = '';
    let _summary = '';
    let _suggestions = [];
    let _sources = [];
    let _warnings = [];
    let _abortController;

    const section = uiSection('ai-tag-assistant', context)
        .classes('ai-tag-assistant-section')
        .label(() => t('ai_tags.title'))
        .shouldDisplay(() => _state !== 'hover' && _entityIDs.length === 1)
        .expandedByDefault(true)
        .disclosureContent(renderDisclosureContent);


    function renderDisclosureContent(wrap) {
        wrap.classed('ai-tag-assistant', true);

        let intro = wrap.selectAll('.ai-tag-intro')
            .data([0]);

        intro.enter()
            .append('p')
            .attr('class', 'ai-tag-intro')
            .merge(intro)
            .text(t('ai_tags.description'));

        let input = wrap.selectAll('.ai-tag-input')
            .data([0]);

        input.enter()
            .append('textarea')
            .attr('class', 'ai-tag-input')
            .attr('maxlength', MAX_DESCRIPTION_CHARS)
            .attr('rows', 4)
            .attr('spellcheck', 'true')
            .call(utilNoAuto)
            .on('input', function() {
                _description = this.value;
                updateRunButton(wrap);
            })
            .merge(input)
            .attr('placeholder', t('ai_tags.placeholder'))
            .property('value', _description);

        let actions = wrap.selectAll('.ai-tag-actions')
            .data([0]);

        actions = actions.enter()
            .append('div')
            .attr('class', 'ai-tag-actions')
            .merge(actions);

        let runButton = actions.selectAll('.ai-tag-run')
            .data([0]);

        runButton = runButton.enter()
            .append('button')
            .attr('type', 'button')
            .attr('class', 'ai-tag-run secondary-action')
            .on('click', requestSuggestions)
            .call(svgIcon('#iD-icon-search', 'pre-text'))
            .append('span')
            .merge(runButton.select('span'));

        runButton.text(_status === 'loading' ? t('ai_tags.searching') : t('ai_tags.search'));
        updateRunButton(wrap);

        let badge = actions.selectAll('.ai-tag-web-badge')
            .data([0]);

        badge.enter()
            .append('span')
            .attr('class', 'ai-tag-web-badge')
            .merge(badge)
            .classed('hide', shouldHideWebBadge())
            .text(t('ai_tags.web_badge'));

        renderStatus(wrap);
        renderSuggestions(wrap);
        renderSources(wrap);
    }


    function updateRunButton(wrap) {
        wrap.selectAll('.ai-tag-run')
            .classed('loading', _status === 'loading')
            .attr('disabled', _status === 'loading' || !_description.trim() ? true : null);
    }


    function shouldHideWebBadge() {
        if (!['ready', 'empty', 'applied'].includes(_status)) return false;
        return !_sources.length && !_suggestions.some(suggestion => suggestion.sources.length);
    }


    function requestSuggestions(d3_event) {
        d3_event.preventDefault();
        const description = limitedText(_description, MAX_DESCRIPTION_CHARS);
        if (_status === 'loading' || !description || _entityIDs.length !== 1) return;

        const graph = context.graph();
        const entity = context.hasEntity(_entityIDs[0]);
        if (!entity) return;

        if (_abortController) _abortController.abort();
        _abortController = new AbortController();
        const center = entity.extent(graph).center();
        const requestID = entity.id;

        _status = 'loading';
        _error = '';
        _summary = '';
        _suggestions = [];
        _sources = [];
        _warnings = [];
        section.reRender();

        fetch('/api/osm-ai/tag-suggestions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: _abortController.signal,
            body: JSON.stringify({
                description,
                tags: singleValueTags(_tags),
                geometry: graph.geometry(entity.id),
                location: { lon: center[0], lat: center[1] },
                locale: localizer.localeCode(),
                web_search: true,
                provider_order: getProviderOrder('search'),
                text_provider_order: getProviderOrder('text')
            })
        })
            .then(async response => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const error = new Error(data.error || 'Suggestion request failed');
                    error.status = response.status;
                    throw error;
                }
                return data;
            })
            .then(data => {
                if (_entityIDs[0] !== requestID) return;
                _summary = limitedText(data.summary, MAX_SUMMARY_CHARS);
                _suggestions = normalizeSuggestions(data.suggestions);
                _sources = normalizeSources(data.sources);
                _warnings = normalizeWarnings(data.warnings);
                _status = _suggestions.length ? 'ready' : 'empty';
                section.reRender();
            })
            .catch(err => {
                if (err.name === 'AbortError' || _entityIDs[0] !== requestID) return;
                _status = err.status === 503 ? 'unavailable' : 'error';
                _error = err.message;
                section.reRender();
            });
    }


    function singleValueTags(tags) {
        const result = {};
        let count = 0;
        for (const [key, value] of Object.entries(tags || {})) {
            if (count === MAX_TAGS) break;
            if (typeof value !== 'string' || !key || !value || key.length > 255 || value.length > 255) continue;
            result[key] = value;
            count++;
        }
        return result;
    }


    function normalizeSuggestions(suggestions) {
        if (!Array.isArray(suggestions)) return [];

        const result = [];
        const candidates = suggestions.slice(0, MAX_SUGGESTION_CANDIDATES);
        for (let index = 0; index < candidates.length && result.length < MAX_SUGGESTIONS; index++) {
            const suggestion = candidates[index];
            if (!suggestion || typeof suggestion !== 'object') continue;

            const key = context.cleanTagKey(String(suggestion.key || '').trim());
            if (blockedTagKey(key)) continue;
            const action = suggestion.action === 'remove' ? 'remove' : 'set';
            const value = action === 'remove' ? '' : context.cleanTagValue(String(suggestion.value || '').trim());
            if (!key || key.length > 255 || (action === 'set' && (!value || value.length > 255))) continue;

            const current = typeof _tags[key] === 'string' ? _tags[key] : undefined;
            if ((action === 'set' && current === value) || (action === 'remove' && current === undefined)) continue;

            const confidenceScore = Number(suggestion.confidence);
            const hasNumericConfidence = Number.isFinite(confidenceScore);
            const confidence = hasNumericConfidence ?
                (confidenceScore >= 0.8 ? 'high' : confidenceScore >= 0.5 ? 'medium' : 'low') :
                (['high', 'medium', 'low'].includes(suggestion.confidence) ? suggestion.confidence : 'low');
            const shouldSelect = hasNumericConfidence ? confidenceScore >= 0.6 : confidence !== 'low';
            result.push({
                id: `${index}-${key}-${value}`,
                key,
                value,
                action,
                current,
                confidence,
                reason: limitedText(suggestion.reason, MAX_REASON_CHARS),
                sources: normalizeSources(suggestion.sources),
                selected: suggestion.selected !== false && shouldSelect && action !== 'remove'
            });
        }
        return result;
    }


    function normalizeSources(sources) {
        if (!Array.isArray(sources)) return [];

        const seen = new Set();
        const result = [];
        const candidates = sources.slice(0, MAX_SOURCE_CANDIDATES);
        for (const candidate of candidates) {
            if (result.length >= MAX_SOURCES) break;
            const source = typeof candidate === 'string' ?
                { title: candidate, url: candidate } : candidate;
            if (!source || typeof source !== 'object') continue;

            const rawURL = limitedText(source.url, MAX_SOURCE_URL_CHARS);
            let url;
            try {
                url = new URL(rawURL);
            } catch {
                continue;
            }
            if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href)) continue;

            seen.add(url.href);
            result.push({
                title: limitedText(source.title, MAX_SOURCE_TITLE_CHARS),
                url: url.href,
                snippet: limitedText(source.snippet, MAX_SOURCE_SNIPPET_CHARS)
            });
        }
        return result;
    }


    function normalizeWarnings(warnings) {
        if (!Array.isArray(warnings)) return [];

        const result = [];
        for (const warning of warnings.slice(0, MAX_WARNING_CANDIDATES)) {
            const text = limitedText(warning, MAX_WARNING_CHARS);
            if (text) result.push(text);
            if (result.length >= MAX_WARNINGS) break;
        }
        return result;
    }


    function renderStatus(wrap) {
        const statusData = [];
        if (_status === 'error') statusData.push({ kind: 'error', text: t('ai_tags.error') });
        if (_status === 'unavailable') statusData.push({ kind: 'error', text: t('ai_tags.unavailable') });
        if (_status === 'empty') statusData.push({ kind: 'empty', text: t('ai_tags.no_results') });
        if (_status === 'applied') statusData.push({ kind: 'success', text: t('ai_tags.applied') });
        if (_summary) statusData.push({ kind: 'summary', text: _summary });
        for (const warning of _warnings) statusData.push({ kind: 'warning', text: warning });

        let status = wrap.selectAll('.ai-tag-status')
            .data(statusData, d => `${d.kind}-${d.text}`);

        status.exit().remove();
        status.enter()
            .append('p')
            .attr('class', d => `ai-tag-status ai-tag-status-${d.kind}`)
            .merge(status)
            .text(d => d.text)
            .attr('title', d => d.kind === 'error' ? _error : null);
    }


    function renderSuggestions(wrap) {
        let list = wrap.selectAll('.ai-tag-suggestions')
            .data(_suggestions.length ? [0] : []);

        list.exit().remove();
        list = list.enter()
            .append('ul')
            .attr('class', 'ai-tag-suggestions')
            .merge(list);

        let items = list.selectAll('.ai-tag-suggestion')
            .data(_suggestions, d => d.id);

        items.exit().remove();
        const itemsEnter = items.enter()
            .append('li')
            .attr('class', 'ai-tag-suggestion');

        const labelEnter = itemsEnter.append('label');
        labelEnter.append('input')
            .attr('type', 'checkbox')
            .on('change', function(d3_event, d) {
                d.selected = this.checked;
                updateApplyButton(wrap);
            });

        const contentEnter = labelEnter.append('span')
            .attr('class', 'ai-tag-suggestion-content');

        const headingEnter = contentEnter.append('span')
            .attr('class', 'ai-tag-suggestion-heading');
        headingEnter.append('code').attr('class', 'ai-tag-proposed');
        headingEnter.append('span').attr('class', 'ai-tag-confidence');
        contentEnter.append('span').attr('class', 'ai-tag-current');
        contentEnter.append('span').attr('class', 'ai-tag-reason');
        contentEnter.append('span').attr('class', 'ai-tag-item-sources');

        items = itemsEnter.merge(items);
        items.select('input').property('checked', d => d.selected);
        items.select('.ai-tag-proposed')
            .text(d => d.action === 'remove' ? `${d.key} — ${t('ai_tags.remove')}` : `${d.key}=${d.value}`);
        items.select('.ai-tag-confidence')
            .attr('class', d => `ai-tag-confidence confidence-${d.confidence}`)
            .text(d => t(`ai_tags.confidence_${d.confidence}`));
        items.select('.ai-tag-current')
            .classed('hide', d => d.current === undefined)
            .text(d => d.current === undefined ? '' : t('ai_tags.current_value', { value: d.current }));
        items.select('.ai-tag-reason')
            .classed('hide', d => !d.reason)
            .text(d => d.reason);
        items.select('.ai-tag-item-sources')
            .each(function(d) { renderSourceLinks(d3_select(this), d.sources); });

        let footer = wrap.selectAll('.ai-tag-footer')
            .data(_suggestions.length ? [0] : []);

        footer.exit().remove();
        const footerEnter = footer.enter()
            .append('div')
            .attr('class', 'ai-tag-footer');

        footerEnter.append('p')
            .attr('class', 'ai-tag-disclaimer')
            .text(t('ai_tags.disclaimer'));

        footerEnter.append('button')
            .attr('type', 'button')
            .attr('class', 'ai-tag-apply action')
            .on('click', applySuggestions)
            .call(svgIcon('#iD-icon-apply', 'pre-text'))
            .append('span')
            .text(t('ai_tags.apply'));

        updateApplyButton(wrap);
    }


    function updateApplyButton(wrap) {
        wrap.selectAll('.ai-tag-apply')
            .attr('disabled', _suggestions.some(d => d.selected) ? null : true);
    }


    function applySuggestions(d3_event) {
        d3_event.preventDefault();
        const changes = {};
        for (const suggestion of _suggestions) {
            if (!suggestion.selected) continue;
            changes[suggestion.key] = suggestion.action === 'remove' ? undefined : suggestion.value;
        }
        if (!Object.keys(changes).length) return;

        dispatch.call('change', this, _entityIDs, changes);
        _status = 'applied';
        section.reRender();
    }


    function renderSources(wrap) {
        let sources = wrap.selectAll('.ai-tag-sources')
            .data(_sources.length ? [0] : []);

        sources.exit().remove();
        const sourcesEnter = sources.enter()
            .append('div')
            .attr('class', 'ai-tag-sources');

        sourcesEnter.append('h4').text(t('ai_tags.source_title'));
        sourcesEnter.append('div').attr('class', 'ai-tag-source-links');
        sources = sourcesEnter.merge(sources);
        sources.select('.ai-tag-source-links')
            .each(function() { renderSourceLinks(d3_select(this), _sources, true); });
    }


    function renderSourceLinks(selection, sources, showSnippet = false) {
        let links = selection.selectAll('a')
            .data(sources, d => d.url);

        links.exit().remove();
        links.enter()
            .append('a')
            .attr('target', '_blank')
            .attr('rel', 'noopener noreferrer')
            .merge(links)
            .attr('href', d => d.url)
            .attr('title', d => showSnippet ? d.snippet : null)
            .text(d => d.title || d.url);
    }


    section.state = function(val) {
        if (!arguments.length) return _state;
        _state = val;
        return section;
    };


    section.tags = function(val) {
        if (!arguments.length) return _tags;
        _tags = val || {};
        return section;
    };


    section.entityIDs = function(val) {
        if (!arguments.length) return _entityIDs;
        if (!utilArrayIdentical(_entityIDs, val || [])) {
            if (_abortController) _abortController.abort();
            _entityIDs = val || [];
            _description = '';
            _status = 'idle';
            _error = '';
            _summary = '';
            _suggestions = [];
            _sources = [];
            _warnings = [];
        }
        return section;
    };


    return utilRebind(section, dispatch, 'on');
}
