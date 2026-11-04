import { select as d3_select } from 'd3-selection';

import { actionDiscardTags } from '../actions/discard_tags';
import { fileFetcher } from '../core/file_fetcher';
import { coreImportEdits } from '../core/import_edits';
import { t } from '../core/localizer';
import { modeSelect } from '../modes/select';
import { osmChangeset } from '../osm';
import { svgIcon } from '../svg';
import { captureImagery } from '../util/betterid_imagery';
import {
    GEOREF_KEYWORD,
    buildGeoref,
    commitAnnotatedFeatures,
    cropWindow,
    dataUrlToBytes,
    downloadBytes,
    embedPngText,
    featuresFromAnnotation,
    georefForImage,
    readPngText,
    rememberGeoref,
    rememberedGeoref
} from '../util/betterid_imagery_exchange';
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


    function isImageFile(file) {
        if (!file) return false;
        return /^image\//.test(file.type || '') || /\.(png|jpe?g|webp)$/i.test(file.name || '');
    }


    function importFiles(files) {
        Array.from(files || []).forEach(file => {
            if (isImageFile(file)) importAnnotation(file);
            else importFile(file);
        });
    }


    function selectionPixels() {
        const projection = context.projection;
        if (typeof projection !== 'function' || typeof context.selectedIDs !== 'function') return [];
        const graph = context.graph();
        const points = [];
        context.selectedIDs().forEach(id => {
            const entity = context.hasEntity(id);
            if (!entity || typeof entity.extent !== 'function') return;
            const extent = entity.extent(graph);
            if (!extent || !extent[0] || !extent[1]) return;
            [
                [extent[0][0], extent[0][1]],
                [extent[1][0], extent[0][1]],
                [extent[0][0], extent[1][1]],
                [extent[1][0], extent[1][1]]
            ].forEach(loc => {
                const pixel = projection(loc);
                if (pixel && Number.isFinite(pixel[0]) && Number.isFinite(pixel[1])) points.push(pixel);
            });
        });
        return points;
    }


    function exportImagery() {
        const projection = context.projection;
        if (!projection || typeof projection.transform !== 'function') {
            flash('betterid.tools.workflow.imagery_failed', '#iD-icon-no', 'operation disabled', {
                message: t('betterid.tools.imagery_unreadable')
            });
            return;
        }
        captureImagery(context).then(sheet => {
            if (!sheet) {
                flash('betterid.tools.imagery_unreadable', '#iD-icon-no', 'operation disabled');
                return;
            }
            const crop = cropWindow(sheet.width, sheet.height, selectionPixels());
            const piece = document.createElement('canvas');
            piece.width = crop.width;
            piece.height = crop.height;
            piece.getContext('2d').drawImage(
                sheet.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height
            );
            const transform = projection.transform();
            const georef = buildGeoref(transform, crop);
            rememberGeoref(georef);
            const bytes = embedPngText(
                dataUrlToBytes(piece.toDataURL('image/png')),
                GEOREF_KEYWORD,
                JSON.stringify(georef)
            );
            downloadBytes(bytes, 'betterid-imagery.png', 'image/png');
            flash('betterid.tools.workflow.imagery_exported', '#iD-icon-betterid-export', 'operation');
        }).catch(error => {
            flash('betterid.tools.workflow.imagery_failed', '#iD-icon-no', 'operation disabled', {
                message: error.message
            });
        });
    }


    function importAnnotation(file) {
        const reader = new FileReader();
        reader.onerror = () => flash(
            'betterid.tools.workflow.imagery_failed', '#iD-icon-no', 'operation disabled',
            { message: t('betterid.import_edits.read_error') }
        );
        reader.onload = () => {
            try {
                const bytes = new Uint8Array(reader.result);
                let georef = null;
                const embedded = readPngText(bytes, GEOREF_KEYWORD);
                if (embedded) georef = JSON.parse(embedded);
                if (!georef || !georef.transform) georef = rememberedGeoref();
                if (!georef) {
                    flash('betterid.tools.workflow.imagery_no_georef', '#iD-icon-no', 'operation disabled');
                    return;
                }
                const url = URL.createObjectURL(new Blob([bytes], { type: file.type || 'image/png' }));
                const image = new Image();
                image.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(image, 0, 0);
                    const placed = georefForImage(georef, canvas.width, canvas.height);
                    const features = featuresFromAnnotation(ctx.getImageData(0, 0, canvas.width, canvas.height), placed);
                    const ids = commitAnnotatedFeatures(context, features);
                    URL.revokeObjectURL(url);
                    if (!ids.length) {
                        flash('betterid.tools.workflow.imagery_nothing', '#iD-icon-no', 'operation disabled');
                        return;
                    }
                    context.enter(modeSelect(context, ids));
                    flash('betterid.tools.workflow.imagery_imported', '#iD-icon-apply', 'operation', { count: ids.length });
                };
                image.onerror = () => {
                    URL.revokeObjectURL(url);
                    flash('betterid.tools.workflow.imagery_failed', '#iD-icon-no', 'operation disabled', {
                        message: t('betterid.trace.error_image')
                    });
                };
                image.src = url;
            } catch (error) {
                flash('betterid.tools.workflow.imagery_failed', '#iD-icon-no', 'operation disabled', {
                    message: error.message
                });
            }
        };
        reader.readAsArrayBuffer(file);
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
        const imageInput = section.append('input')
            .attr('type', 'file')
            .attr('class', 'betterid-tool-imagery-input')
            .attr('accept', 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp')
            .style('display', 'none')
            .on('change', function(event) {
                const file = event.target.files && event.target.files[0];
                if (file) importAnnotation(file);
                event.target.value = '';
            });

        actionButton(_buttons, 'import', '#iD-icon-betterid-import', 'betterid.tools.workflow.import', () => {
            fileInput.node().click();
        });
        actionButton(_buttons, 'export', '#iD-icon-betterid-export', 'betterid.tools.workflow.export', exportChanges);
        actionButton(_buttons, 'export-imagery', '#iD-icon-betterid-export', 'betterid.tools.workflow.export_imagery', exportImagery);
        actionButton(_buttons, 'import-imagery', '#iD-icon-betterid-import', 'betterid.tools.workflow.import_imagery', () => {
            imageInput.node().click();
        });
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
