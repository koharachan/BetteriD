import { t } from '../../core/localizer';
import { coreImportEdits } from '../../core/import_edits';
import { svgIcon } from '../../svg';
import { uiCmd } from '../cmd';
import { uiTooltip } from '../tooltip';


/**
 * Toolbar entry that imports an `osmChange` (`.osc`) or OSM XML (`.osm`) file as
 * pending edits. It works with an empty edit stack, which is the only way to
 * import when there is nothing to upload yet — the commit panel is not
 * reachable until there is at least one change.
 *
 * `@param {iD.Context} context`
 */
export function uiToolImport(context) {
    var tool = {
        id: 'import',
        label: t.append('commit.import_changes')
    };

    var key = uiCmd('⌘I');
    var _fileInput = null;
    var _installed = false;

    function flash(message, icon, iconClass) {
        context.ui().flash
            .duration(5000)
            .iconName(icon)
            .iconClass(iconClass)
            .label(message)();
    }

    function importFile(file) {
        if (!file) return;

        var reader = new FileReader();
        reader.onerror = function() {
            flash(t('commit.import_failed', { message: t('betterid.import_edits.read_error') }),
                '#iD-icon-no', 'operation disabled');
        };
        reader.onload = function() {
            try {
                var result = coreImportEdits(context, String(reader.result));
                flash(t('commit.import_success', {
                    imported: result.imported,
                    deleted: result.deleted,
                    skipped: result.skipped
                }), '#iD-icon-load', 'operation');
            } catch (err) {
                flash(t('commit.import_failed', { message: err.message }),
                    '#iD-icon-no', 'operation disabled');
            }
        };
        reader.readAsText(file);
    }

    function importFromFiles(files) {
        var list = Array.prototype.slice.call(files || []);
        if (!list.length) return;

        // Import one file per flush so each edit lands in its own undo step.
        list.forEach(importFile);
    }

    tool.render = function(selection) {
        _fileInput = selection
            .append('input')
            .attr('type', 'file')
            .attr('class', 'import-file-input')
            .attr('accept', '.osc,.osm,.xml,text/xml,application/xml')
            .style('display', 'none')
            .on('change', function(d3_event) {
                var input = d3_event.target;
                var files = input.files;
                input.value = null;   // allow importing the same file again
                importFromFiles(files);
            });

        selection
            .append('button')
            .attr('class', 'import bar-button')
            .attr('aria-label', t('commit.import_changes'))
            .on('click', function(d3_event) {
                d3_event.preventDefault();
                _fileInput.node().click();
            })
            .call(uiTooltip()
                .placement('bottom')
                .title(() => t.append('betterid.import_edits.help'))
                .keys([key])
                .scrollContainer(context.container().select('.top-toolbar')))
            .call(svgIcon('#iD-icon-load'));

        context.keybinding().on(key, function(d3_event) {
            d3_event.preventDefault();
            _fileInput.node().click();
        }, true);

        if (!_installed) {
            _installed = true;
            // dropping a file anywhere on the editor imports it
            context.container()
                .on('dragover.betterid-import', function(d3_event) {
                    d3_event.preventDefault();
                })
                .on('drop.betterid-import', function(d3_event) {
                    d3_event.preventDefault();
                    importFromFiles(d3_event.dataTransfer && d3_event.dataTransfer.files);
                });
        }
    };

    tool.uninstall = function() {
        context.keybinding().off(key, true);
        context.container()
            .on('dragover.betterid-import', null)
            .on('drop.betterid-import', null);
        _installed = false;
        _fileInput = null;
    };

    return tool;
}
