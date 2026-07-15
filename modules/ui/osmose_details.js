import {
  select as d3_select
} from 'd3-selection';

import { presetManager } from '../presets';
import { modeSelect } from '../modes/select';
import { t } from '../core/localizer';
import { services } from '../services';
import { svgIcon } from '../svg';
import { utilDisplayName, utilHighlightEntities } from '../util';


export function uiOsmoseDetails(context) {
  let _qaItem;


  function translateText(text) {
    const chars = Array.from(text.trim());
    const chunks = [];
    for (let i = 0; i < chars.length; i += 450) {
      chunks.push(chars.slice(i, i + 450).join(''));
    }

    return Promise.all(chunks.map(chunk => fetch('/api/osm-ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk, target_langs: ['zh'] })
    })
      .then(response => {
        if (!response.ok) throw new Error('Translation failed');
        return response.json();
      })
      .then(result => {
        const translation = (result.translations || []).find(item => item.lang === 'zh');
        if (!translation?.text) throw new Error('Translation result is empty');
        return translation.text.trim();
      })
    )).then(parts => parts.join(' '));
  }


  function translateDetails(d3_event) {
    d3_event.preventDefault();

    const button = d3_select(this);
    if (button.classed('loading')) return;

    const container = d3_select(this.parentNode.parentNode);
    const entries = [];
    container.selectAll('.qa-translatable').each(function() {
      const text = this.textContent.trim();
      if (text) entries.push({ source: d3_select(this), text });
    });
    if (!entries.length) return;

    button
      .classed('loading', true)
      .attr('disabled', true);
    button.select('span').call(t.append('QA.osmose.translating'));

    Promise.all(entries.map(entry => translateText(entry.text)
      .then(text => ({ ...entry, translation: text }))
      .catch(() => null)
    ))
      .then(results => {
        const translated = results.filter(Boolean);
        if (!translated.length) throw new Error('Translation failed');

        for (const result of translated) {
          const subsection = d3_select(result.source.node().parentNode);
          const translation = subsection.selectAll('.qa-details-translation')
            .data([result.translation]);

          translation.enter()
            .append('p')
              .attr('class', 'qa-details-translation')
              .attr('lang', 'zh-CN')
            .merge(translation)
              .text(d => d);
        }

        button.select('span').call(t.append('QA.osmose.translated'));
      })
      .catch(() => {
        button.select('span').call(t.append('QA.osmose.translate_error'));
      })
      .finally(() => {
        button
          .classed('loading', false)
          .attr('disabled', null);
      });
  }

  function issueString(d, type) {
    if (!d) return '';

    // Issue strings are cached from Osmose API
    const s = services.osmose.getStrings(d.itemType);
    return (type in s) ? s[type] : '';
  }


  function osmoseDetails(selection) {
    const details = selection.selectAll('.error-details')
      .data(
        _qaItem ? [_qaItem] : [],
        d => `${d.id}-${d.status || 0}`
      );

    details.exit()
      .remove();

    const detailsEnter = details.enter()
      .append('div')
        .attr('class', 'error-details qa-details-container');

    const translateActions = detailsEnter
      .append('div')
        .attr('class', 'qa-translate-actions');

    const translateButton = translateActions
      .append('button')
        .attr('class', 'qa-translate-button secondary-action')
        .attr('type', 'button')
        .attr('aria-label', t('QA.osmose.translate'))
        .on('click', translateDetails)
        .call(svgIcon('#iD-icon-translate', 'pre-text'));

    translateButton
      .append('span')
        .call(t.append('QA.osmose.translate'));


    // Description
    if (issueString(_qaItem, 'detail')) {
      const div = detailsEnter
        .append('div')
          .attr('class', 'qa-details-subsection');

      div
        .append('h4')
          .call(t.append('QA.keepRight.detail_description'));

      div
        .append('p')
          .attr('class', 'qa-details-description-text qa-translatable')
          .html(d => issueString(d, 'detail'))
        .selectAll('a')
          .attr('rel', 'noopener')
          .attr('target', '_blank');
    }

    // Elements (populated later as data is requested)
    const detailsDiv = detailsEnter
      .append('div')
        .attr('class', 'qa-details-subsection');

    const elemsDiv = detailsEnter
      .append('div')
        .attr('class', 'qa-details-subsection');

    // Suggested Fix (mustn't exist for every issue type)
    if (issueString(_qaItem, 'fix')) {
      const div = detailsEnter
        .append('div')
          .attr('class', 'qa-details-subsection');

      div
        .append('h4')
          .call(t.append('QA.osmose.fix_title'));

      div
        .append('p')
          .attr('class', 'qa-translatable')
          .html(d => issueString(d, 'fix'))
        .selectAll('a')
          .attr('rel', 'noopener')
          .attr('target', '_blank');
    }

    // Common Pitfalls (mustn't exist for every issue type)
    if (issueString(_qaItem, 'trap')) {
      const div = detailsEnter
        .append('div')
          .attr('class', 'qa-details-subsection');

      div
        .append('h4')
          .call(t.append('QA.osmose.trap_title'));

      div
        .append('p')
          .attr('class', 'qa-translatable')
          .html(d => issueString(d, 'trap'))
        .selectAll('a')
          .attr('rel', 'noopener')
          .attr('target', '_blank');
    }

    // Save current item to check if UI changed by time request resolves
    const thisItem = _qaItem;
    services.osmose.loadIssueDetail(_qaItem)
      .then(d => {
        // No details to add if there are no associated issue elements
        if (!d.elems || d.elems.length === 0) return;

        // Do nothing if UI has moved on by the time this resolves
        if (
          context.selectedErrorID() !== thisItem.id
          && context.container().selectAll(`.qaItem.osmose.hover.itemId-${thisItem.id}`).empty()
        ) return;

        // Things like keys and values are dynamically added to a subtitle string
        if (d.detail) {
          detailsDiv
            .append('h4')
              .call(t.append('QA.osmose.detail_title'));

          detailsDiv
            .append('p')
              .attr('class', 'qa-translatable')
              .html(d => d.detail)
            .selectAll('a')
              .attr('rel', 'noopener')
              .attr('target', '_blank');
        }

        // Create list of linked issue elements
        elemsDiv
          .append('h4')
            .call(t.append('QA.osmose.elems_title'));

        elemsDiv
          .append('ul').selectAll('li')
          .data(d.elems)
          .enter()
          .append('li')
          .append('a')
            .attr('href', '#')
            .attr('class', 'error_entity_link')
            .text(d => d)
            .each(function() {
              const link = d3_select(this);
              const entityID = this.textContent;
              const entity = context.hasEntity(entityID);

              // Add click handler
              link
                .on('mouseenter', () => {
                  utilHighlightEntities([entityID], true, context);
                })
                .on('mouseleave', () => {
                  utilHighlightEntities([entityID], false, context);
                })
                .on('click', (d3_event) => {
                  d3_event.preventDefault();

                  utilHighlightEntities([entityID], false, context);

                  const osmlayer = context.layers().layer('osm');
                  if (!osmlayer.enabled()) {
                    osmlayer.enabled(true);
                  }

                  context.map().centerZoom(d.loc, 20);

                  if (entity) {
                    context.enter(modeSelect(context, [entityID]));
                  } else {
                    context.loadEntity(entityID, (err, result) => {
                      if (err) return;
                      const entity = result.data.find(e => e.id === entityID);
                      if (entity) context.enter(modeSelect(context, [entityID]));
                    });
                  }
                });

              // Replace with friendly name if possible
              // (The entity may not yet be loaded into the graph)
              if (entity) {
                let name = utilDisplayName(entity);  // try to use common name

                if (!name) {
                  const preset = presetManager.match(entity, context.graph());
                  name = preset && !preset.isFallback() && preset.name();  // fallback to preset name
                }

                if (name) {
                  this.innerText = name;
                }
              }
            });

        // Don't hide entities related to this issue - #5880
        context.features().forceVisible(d.elems);
        context.map().pan([0,0]);  // trigger a redraw
      })
      .catch(err => {
        console.log(err); // eslint-disable-line no-console
      });
  }


  osmoseDetails.issue = function(val) {
    if (!arguments.length) return _qaItem;
    _qaItem = val;
    return osmoseDetails;
  };


  return osmoseDetails;
}
