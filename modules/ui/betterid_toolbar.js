import { select as d3_select } from 'd3-selection';

import {
    BETTERID_TOOLS,
    adobeShortcutsEnabled, setAdobeShortcuts,
    betteridTool, setBetteridTool,
    marqueeShape, cycleMarqueeShape,
    brushSize, setBrushSize,
    wandTolerance, setWandTolerance,
    wandContiguous, setWandContiguous,
    BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_BRUSH_SIZE_PREF,
    BETTERID_WAND_TOLERANCE_PREF, BETTERID_WAND_CONTIGUOUS_PREF,
    BETTERID_ADOBE_SHORTCUTS_PREF
} from '../core/betterid_tools';
import { prefs } from '../core/preferences';
import { t } from '../core/localizer';
import { svgIcon } from '../svg';
import { uiTooltip } from './tooltip';


var TOOL_ICONS = {
    select: '#iD-icon-inspect',
    marquee: '#iD-icon-area',
    quickselect: '#iD-icon-point',
    magicwand: '#iD-icon-framed-dot',
    pen: '#iD-icon-line'
};


/** Left hand tool palette (Photoshop style). */
export function uiBetteridToolPalette(context) {
    var _container = d3_select(null);


    function chooseTool(tool) {
        setBetteridTool(betteridTool() === tool && tool !== 'select' ? 'select' : tool);
        context.ui().flash
            .duration(1500)
            .iconName(TOOL_ICONS[betteridTool()])
            .iconClass('operation')
            .label(t('betterid.tools.active', { tool: t('betterid.tools.' + betteridTool()) }))();
    }


    function optionRow(container, label, value, min, max, step, onInput) {
        var row = container.append('label').attr('class', 'betterid-tool-option');
        row.append('span').attr('class', 'betterid-tool-option-label').call(t.append(label));
        row.append('input')
            .attr('type', 'range')
            .attr('min', min)
            .attr('max', max)
            .attr('step', step)
            .property('value', value)
            .on('input', function() {
                onInput(Number(this.value));
            });
        row.append('output').text(value);
        return row;
    }


    function render(selection) {
        selection.selectAll('.betterid-tool-palette').remove();

        context.container().classed('betterid-tool-active', betteridTool() !== 'select');

        var palette = selection
            .append('div')
            .attr('class', 'betterid-tool-palette');

        var tools = palette
            .append('div')
            .attr('class', 'betterid-tool-buttons');

        BETTERID_TOOLS.forEach(function(tool) {
            var button = tools
                .append('button')
                .attr('type', 'button')
                .attr('class', 'betterid-tool-button betterid-tool-' + tool)
                .classed('active', betteridTool() === tool)
                .on('click', function(d3_event) {
                    d3_event.preventDefault();
                    chooseTool(tool);
                });

            button
                .call(svgIcon(TOOL_ICONS[tool]));

            button.call(uiTooltip()
                .placement('right')
                .title(() => t.append('betterid.tools.' + tool))
                .keys([t('betterid.tools.' + tool + '_key')])
                .scrollContainer(context.container().select('.over-map')));
        });

        var options = palette.append('div').attr('class', 'betterid-tool-options');
        var tool = betteridTool();

        if (tool === 'marquee') {
            var shapeButton = options
                .append('button')
                .attr('type', 'button')
                .attr('class', 'betterid-tool-shape')
                .on('click', function(d3_event) {
                    d3_event.preventDefault();
                    cycleMarqueeShape();
                })
                .call(svgIcon('#iD-icon-area'));

            shapeButton
                .append('span')
                .call(t.append(marqueeShape() === 'ellipse'
                    ? 'betterid.tools.marquee_ellipse'
                    : 'betterid.tools.marquee_rect'));

        } else if (tool === 'quickselect') {
            optionRow(options, 'betterid.tools.brush_size', brushSize(), 8, 200, 4, function(value) {
                setBrushSize(value);
            });

        } else if (tool === 'magicwand') {
            optionRow(options, 'betterid.tools.tolerance', wandTolerance(), 0, 10, 1, function(value) {
                setWandTolerance(value);
            });

            var contiguousLabel = options.append('label').attr('class', 'betterid-tool-check');
            contiguousLabel
                .append('input')
                .attr('type', 'checkbox')
                .property('checked', wandContiguous())
                .on('change', function() {
                    setWandContiguous(this.checked);
                });
            contiguousLabel
                .append('span')
                .call(t.append('betterid.tools.contiguous'));

        } else if (tool === 'pen') {
            options
                .append('p')
                .attr('class', 'betterid-tool-hint')
                .call(t.append('betterid.tools.pen_hint'));
        }

        var footer = palette.append('div').attr('class', 'betterid-tool-footer');
        var adobeLabel = footer.append('label').attr('class', 'betterid-tool-check');
        adobeLabel
            .append('input')
            .attr('type', 'checkbox')
            .property('checked', adobeShortcutsEnabled())
            .on('change', function() {
                setAdobeShortcuts(this.checked);
            });
        adobeLabel
            .append('span')
            .call(t.append('betterid.tools.adobe_shortcuts'));

        adobeLabel.call(uiTooltip()
            .placement('right')
            .title(() => t.append('betterid.tools.adobe_shortcuts_hint'))
            .scrollContainer(context.container().select('.over-map')));
    }


    function palette(selection) {
        _container = selection;
        render(selection);

        // re-render whenever a tool preference changes
        [
            BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_BRUSH_SIZE_PREF,
            BETTERID_WAND_TOLERANCE_PREF, BETTERID_WAND_CONTIGUOUS_PREF, BETTERID_ADOBE_SHORTCUTS_PREF
        ].forEach(function(key) {
            prefs.onChange(key, function() {
                if (!_container.empty()) render(_container);
            });
        });
    }


    return palette;
}
