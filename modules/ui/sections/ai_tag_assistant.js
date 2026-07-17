import { dispatch as d3_dispatch } from 'd3-dispatch';
import { select as d3_select } from 'd3-selection';

import { localizer, t } from '../../core/localizer';
import { getProviderOrder } from '../../core/betterid_preferences';
import { svgIcon } from '../../svg/icon';
import { utilArrayIdentical } from '../../util/array';
import { utilNoAuto, utilRebind } from '../../util';
import { uiSection } from '../section';
const BLOCKED_TAG_KEYS = new Set(['source', 'created_by', 'attribution', 'odbl', 'import']);



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
            .attr('maxlength', 1200)
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


    function requestSuggestions(d3_event) {
        d3_event.preventDefault();
        if (_status === 'loading' || !_description.trim() || _entityIDs.length !== 1) return;

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
                description: _description.trim(),
                tags: singleValueTags(_tags),
                geometry: graph.geometry(entity.id),
                location: { lon: center[0], lat: center[1] },
                locale: localizer.localeCode(),
                web_search: true,
                provider_order: getProviderOrder('search')
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
                _summary = typeof data.summary === 'string' ? data.summary.trim() : '';
                _suggestions = normalizeSuggestions(data.suggestions);
                _sources = normalizeSources(data.sources);
                _warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean).slice(0, 5) : [];
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
        for (const [key, value] of Object.entries(tags || {})) {
            if (typeof value === 'string' && key && value) result[key] = value;
        }
        return result;
    }


    function normalizeSuggestions(suggestions) {
        if (!Array.isArray(suggestions)) return [];

        return suggestions.slice(0, 20).map((suggestion, index) => {
            if (!suggestion || typeof suggestion !== 'object') return null;

            const key = context.cleanTagKey(String(suggestion.key || '').trim());
            if (BLOCKED_TAG_KEYS.has(key) || key.startsWith('tiger:')) return null;
            const action = suggestion.action === 'remove' ? 'remove' : 'set';
            const value = action === 'remove' ? '' : context.cleanTagValue(String(suggestion.value || '').trim());
            if (!key || key.length > 255 || (action === 'set' && (!value || value.length > 255))) return null;

            const current = typeof _tags[key] === 'string' ? _tags[key] : undefined;
            if ((action === 'set' && current === value) || (action === 'remove' && current === undefined)) return null;

            const confidenceScore = Number(suggestion.confidence);
            const hasNumericConfidence = Number.isFinite(confidenceScore);
            const confidence = hasNumericConfidence ?
                (confidenceScore >= 0.8 ? 'high' : confidenceScore >= 0.5 ? 'medium' : 'low') :
                (['high', 'medium', 'low'].includes(suggestion.confidence) ? suggestion.confidence : 'low');
            const shouldSelect = hasNumericConfidence ? confidenceScore >= 0.6 : confidence !== 'low';
            return {
                id: `${index}-${key}-${value}`,
                key,
                value,
                action,
                current,
                confidence,
                reason: typeof suggestion.reason === 'string' ? suggestion.reason.trim() : '',
                sources: normalizeSources(suggestion.sources),
                selected: suggestion.selected !== false && shouldSelect && action !== 'remove'
            };
        }).filter(Boolean);
    }


    function normalizeSources(sources) {
        if (!Array.isArray(sources)) return [];

        const seen = new Set();
        return sources.map(source => {
            if (typeof source === 'string') return { title: source, url: source };
            if (!source || typeof source !== 'object') return null;
            return {
                title: String(source.title || source.url || '').trim(),
                url: String(source.url || '').trim(),
                snippet: String(source.snippet || '').trim()
            };
        }).filter(source => {
            if (!source || !/^https?:\/\//i.test(source.url) || seen.has(source.url)) return false;
            seen.add(source.url);
            return true;
        }).slice(0, 10);
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
