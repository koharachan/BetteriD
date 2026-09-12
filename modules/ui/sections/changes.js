import { select as d3_select } from 'd3-selection';

import { presetManager } from '../../presets';
import { fileFetcher } from '../../core/file_fetcher';
import { coreImportEdits } from '../../core/import_edits';
import { t } from '../../core/localizer';
import { JXON } from '../../util/jxon';
import { actionDiscardTags } from '../../actions/discard_tags';
import { osmChangeset } from '../../osm';
import { svgIcon } from '../../svg/icon';
import { uiSection } from '../section';

import {
    utilDisplayName,
    utilDisplayType,
    utilEntityOrMemberSelector
} from '../../util';


export function uiSectionChanges(context) {
    var _discardTags = {};
    fileFetcher.get('discarded')
        .then(function(d) { _discardTags = d; })
        .catch(function() { /* ignore */ });

    var section = uiSection('changes-list', context)
        .label(function() {
            var history = context.history();
            var summary = history.difference().summary();
            return t.append('inspector.title_count', { title: t.append('commit.changes'), count: summary.length });
        })
        .disclosureContent(renderDisclosureContent);

    function renderDisclosureContent(selection) {
        var history = context.history();
        var summary = history.difference().summary();

        var container = selection.selectAll('.commit-section')
            .data([0]);

        var containerEnter = container.enter()
            .append('div')
            .attr('class', 'commit-section');

        containerEnter
            .append('ul')
            .attr('class', 'changeset-list');

        container = containerEnter
            .merge(container);


        var items = container.select('ul').selectAll('li')
            .data(summary);

        var itemsEnter = items.enter()
            .append('li')
            .attr('class', 'change-item');

        var buttons = itemsEnter
            .append('button')
            .on('mouseover', mouseover)
            .on('mouseout', mouseout)
            .on('click', click);

        buttons
            .each(function(d) {
                d3_select(this)
                    .call(svgIcon('#iD-icon-' + d.entity.geometry(d.graph), 'pre-text ' + d.changeType));
            });

        buttons
            .append('span')
            .attr('class', 'change-type')
            .each(function(d) {
                d3_select(this).call(
                    t.append('commit.' + d.changeType, { suffix: ' ' }));
                });

        buttons
            .append('strong')
            .attr('class', 'entity-type')
            .text(function(d) {
                var matched = presetManager.match(d.entity, d.graph);
                return (matched && matched.name()) || utilDisplayType(d.entity.id);
            });

        buttons
            .append('span')
            .attr('class', 'entity-name')
            .text(function(d) {
                var name = utilDisplayName(d.entity) || '',
                    string = '';
                if (name !== '') {
                    string += ':';
                }
                return string + ' ' + name;
            });


        // Download changeset link
        var changeset = new osmChangeset().update({ id: undefined });
        var changes = history.changes(actionDiscardTags(history.difference(), _discardTags));

        delete changeset.id;  // Export without chnageset_id

        var data = JXON.stringify(changeset.osmChangeJXON(changes));
        var blob = new Blob([data], {type: 'text/xml;charset=utf-8;'});
        var fileName = 'changes.osc';

        var linkEnter = container.selectAll('.download-changes')
            .data([0])
            .enter()
            .append('a')
            .attr('class', 'download-changes');

        linkEnter
            .attr('href', window.URL.createObjectURL(blob))
            .attr('download', fileName);

        linkEnter
            .call(svgIcon('#iD-icon-load', 'inline'))
            .append('span')
            .call(t.append('commit.download_changes'));


        // Import changes link (osmChange / OSM XML -> pending edits)
        var fileInput = container.selectAll('.import-changes-input')
            .data([0])
            .enter()
            .append('input')
            .attr('class', 'import-changes-input')
            .attr('type', 'file')
            .attr('accept', '.osc,.osm,.xml,text/xml,application/xml')
            .style('display', 'none')
            .on('change', function(d3_event) {
                var input = d3_event.target;
                var file = input.files && input.files[0];
                if (!file) return;

                var reader = new FileReader();
                reader.onload = function() {
                    try {
                        var result = coreImportEdits(context, String(reader.result));
                        context.ui().flash
                            .duration(4000)
                            .iconName('#iD-icon-load')
                            .iconClass('operation')
                            .label(t('commit.import_success', {
                                imported: result.imported,
                                deleted: result.deleted,
                                skipped: result.skipped
                            }))();
                        context.ui().sidebar.hover.cancel();
                    } catch (err) {
                        context.ui().flash
                            .duration(5000)
                            .iconName('#iD-icon-no')
                            .iconClass('operation disabled')
                            .label(t('commit.import_failed', { message: err.message }))();
                    }
                };
                reader.readAsText(file);
                input.value = '';   // allow importing the same file again
            });

        var importButton = container.selectAll('.import-changes')
            .data([0])
            .enter()
            .append('button')
            .attr('class', 'import-changes')
            .attr('type', 'button')
            .on('click', function() {
                fileInput.node().click();
            });

        importButton
            .call(svgIcon('#iD-icon-data', 'inline'))
            .append('span')
            .call(t.append('commit.import_changes'));


        function mouseover(d3_event, d) {
            if (d.entity) {
                context.surface().selectAll(
                    utilEntityOrMemberSelector([d.entity.id], context.graph())
                ).classed('hover', true);
            }
        }


        function mouseout() {
            context.surface().selectAll('.hover')
                .classed('hover', false);
        }


        function click(d3_event, change) {
            if (change.changeType !== 'deleted') {
                var entity = change.entity;
                context.map().zoomToEase(entity);
                context.surface().selectAll(utilEntityOrMemberSelector([entity.id], context.graph()))
                    .classed('hover', true);
            }
        }
    }

    return section;
}
