import { select as d3_select } from 'd3-selection';

import { actionDiscardTags } from '../actions/discard_tags';
import { fileFetcher } from '../core/file_fetcher';
import { coreImportEdits } from '../core/import_edits';
import { t } from '../core/localizer';
import { osmChangeset } from '../osm';
import { svgIcon } from '../svg';
import { JXON } from '../util/jxon';
import { uiTooltip } from './tooltip';


/**
 * File and edit actions that belong beside the BetteriD tools.
 *
 * The stock top toolbar still keeps Save and the normal iD navigation. This
 * compact group makes the useful local-edit workflow visible next to the
 * Photoshop-style tools: import an .osm/.osc file, export the current pending
 * changes, undo and redo. It also works when the changes panel is collapsed or
 * when the edit stack is empty.
 */
export function uiBetteridWorkflow(context) {
    let _container = d3_select(null);
    let _buttons = d3_select(null);
    let _discardTags = {};
    let _discardTagsPromise;


    function loadDiscardTags() {
        if (!_discardTagsPromise) {
            _discardTagsPromise = fileFetcher.get('discarded')
                .then(tags => {
                    _discardTags = tags || {};
                    return _discardTags;
                })
                .catch(() => _discardTags);
        }
        return _discardTagsPromise;
    }


    function flash(key, icon, iconClass, values) {
        context.ui().flash
            .duration(4500)
            .iconName(icon)
            .iconClass(iconClass)
            .label(t.append(key, values || {}))();
    }


    function importFile(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onerror = () => flash(
            'commit.import_failed', '#iD-icon-no', 'operation disabled',
            { message: t('betterid.import_edits.read_error') }
        );
        reader.onload = () => {
            try {
                const result = coreImportEdits(context, String(reader.result));
                flash('commit.import_success', '#iD-icon-load', 'operation', result);
                update();
            } catch (error) {
                flash('commit.import_failed', '#iD-icon-no', 'operation disabled', {
                    message: error.message
                });
            }
        };
        reader.readAsText(file);
    }


    function importFiles(files) {
        Array.from(files || []).forEach(importFile);
    }


    function exportChanges() {
        const history = context.history();
        if (!history.hasChanges()) {
            flash('betterid.tools.workflow.no_changes', '#iD-icon-no', 'operation disabled');
            return;
        }

        loadDiscardTags().then(discardTags => {
            const changeset = new osmChangeset().update({ id: undefined });
            const changes = history.changes(actionDiscardTags(history.difference(), discardTags));
            delete changeset.id;

            const data = JXON.stringify(changeset.osmChangeJXON(changes));
            const blob = new Blob([data], { type: 'text/xml;charset=utf-8' });
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'betterid-changes.osc';
            link.click();
            window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
            flash('betterid.tools.workflow.exported', '#iD-icon-betterid-export', 'operation');
        });
    }


    function edit(action) {
        const history = context.history();
        if (action === 'undo' && history.undoAnnotation()) context.undo();
        if (action === 'redo' && history.redoAnnotation()) context.redo();
        update();
    }


    function actionButton(parent, action, icon, label, onClick) {
        const button = parent.append('button')
            .attr('type', 'button')
            .attr('class', 'betterid-tool-action')
            .attr('data-action', action)
            .attr('aria-label', t(label))
            .on('click', function(event) {
                event.preventDefault();
                onClick();
            })
            .call(uiTooltip()
                .placement('right')
                .title(() => t.append(label))
                .scrollContainer(context.container().select('.over-map')));

        button.call(svgIcon(icon));
        button.append('span').call(t.append(label));
        return button;
    }


    function update() {
        if (_buttons.empty()) return;
        const history = context.history();
        const canUndo = Boolean(history.undoAnnotation());
        const canRedo = Boolean(history.redoAnnotation());
        const canExport = history.hasChanges();

        _buttons.select('[data-action="export"]')
            .classed('disabled', !canExport)
            .attr('aria-disabled', !canExport ? 'true' : null);
        _buttons.select('[data-action="undo"]')
            .classed('disabled', !canUndo)
            .attr('aria-disabled', !canUndo ? 'true' : null);
        _buttons.select('[data-action="redo"]')
            .classed('disabled', !canRedo)
            .attr('aria-disabled', !canRedo ? 'true' : null);
    }


    function workflow(selection) {
        _container = selection;
        _container.selectAll('.betterid-tool-actions').remove();

        const section = _container
            .append('div')
            .attr('class', 'betterid-tool-actions')
            .attr('aria-label', t('betterid.tools.workflow.title'));

        section.append('div')
            .attr('class', 'betterid-tool-actions-title')
            .call(t.append('betterid.tools.workflow.title'));

        _buttons = section.append('div').attr('class', 'betterid-tool-action-buttons');
        const fileInput = section.append('input')
            .attr('type', 'file')
            .attr('class', 'betterid-tool-import-input')
            .attr('accept', '.osc,.osm,.xml,text/xml,application/xml')
            .style('display', 'none')
            .on('change', function(event) {
                importFiles(event.target.files);
                event.target.value = '';
            });

        actionButton(_buttons, 'import', '#iD-icon-betterid-import', 'betterid.tools.workflow.import', () => {
            fileInput.node().click();
        });
        actionButton(_buttons, 'export', '#iD-icon-betterid-export', 'betterid.tools.workflow.export', exportChanges);
        actionButton(_buttons, 'undo', '#iD-icon-undo', 'betterid.tools.workflow.undo', () => edit('undo'));
        actionButton(_buttons, 'redo', '#iD-icon-redo', 'betterid.tools.workflow.redo', () => edit('redo'));

        if (!workflow._bound) {
            workflow._bound = true;
            context.history().on('change.betteridWorkflow', update);
            context.on('enter.betteridWorkflow', update);
            context.container()
                .on('dragover.betteridWorkflow', event => event.preventDefault())
                .on('drop.betteridWorkflow', event => {
                    event.preventDefault();
                    importFiles(event.dataTransfer && event.dataTransfer.files);
                });
        }
        update();
    }


    workflow.uninstall = function() {
        context.history().on('change.betteridWorkflow', null);
        context.on('enter.betteridWorkflow', null);
        context.container()
            .on('dragover.betteridWorkflow', null)
            .on('drop.betteridWorkflow', null);
        workflow._bound = false;
        _container = d3_select(null);
        _buttons = d3_select(null);
    };


    return workflow;
}
