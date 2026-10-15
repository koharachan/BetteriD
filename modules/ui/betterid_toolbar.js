import { select as d3_select } from 'd3-selection';

import {
    BETTERID_TOOL_GROUPS, BETTERID_MARQUEE_SHAPES, BETTERID_PEN_TOLERANCE_RANGE,
    betteridTool, setBetteridTool, groupTool, setSelectionTool, shortcutPreset,
    marqueeShape, setMarqueeShape, cycleMarqueeShape,
    brushSize, setBrushSize,
    wandTolerance, setWandTolerance,
    wandContiguous, setWandContiguous,
    penTolerance, setPenTolerance,
    penSnapping, setPenSnapping,
    penRubberBand, setPenRubberBand,
    BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_SELECTION_LAST_PREF
} from '../core/betterid_tools';
import { BETTERID_PREFS, experimentalFeatureEnabled } from '../core/betterid_preferences';
import { prefs } from '../core/preferences';
import { t } from '../core/localizer';
import { svgIcon } from '../svg';
import { uiTooltip } from './tooltip';


var TOOL_ICONS = {
    select: '#iD-icon-betterid-select',
    marquee: '#iD-icon-betterid-marquee-rect',
    quickselect: '#iD-icon-betterid-quickselect',
    magicwand: '#iD-icon-betterid-magicwand',
    pen: '#iD-icon-betterid-pen'
};

var MARQUEE_ICONS = {
    rect: '#iD-icon-betterid-marquee-rect',
    ellipse: '#iD-icon-betterid-marquee-ellipse'
};

// preferences whose change alters which buttons / options are shown; the
// option values themselves are updated in place, so dragging a slider never
// destroys the slider under the pointer
var STRUCTURAL_PREFS = [BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_SELECTION_LAST_PREF];


/** The marquee button shows the shape it will draw. */
function toolIcon(tool) {
    if (tool === 'marquee') return MARQUEE_ICONS[marqueeShape()];
    return TOOL_ICONS[tool];
}


/**
 * The entries of a group's context menu: the marquee offers its two shapes,
 * the selection group its two tools, single-tool groups offer nothing.
 */
function groupEntries(group) {
    if (group.id === 'marquee') {
        return BETTERID_MARQUEE_SHAPES.map(shape => ({
            id: shape,
            icon: MARQUEE_ICONS[shape],
            label: 'betterid.tools.marquee_' + shape,
            selected: marqueeShape() === shape,
            apply: () => {
                setMarqueeShape(shape);
                setBetteridTool('marquee');
            }
        }));
    }

    if (group.id === 'selection') {
        return group.tools.map(tool => ({
            id: tool,
            icon: TOOL_ICONS[tool],
            label: 'betterid.tools.' + tool,
            key: 'betterid.tools.' + tool + '_key',
            selected: groupTool('selection') === tool,
            apply: () => {
                setSelectionTool(tool);
                setBetteridTool(tool);
            }
        }));
    }

    return [];
}


/** Left hand tool palette (Photoshop style). */
export function uiBetteridToolPalette(context) {
    var _container = d3_select(null);


    function flashTool() {
        context.ui().flash
            .duration(1500)
            .iconName(toolIcon(betteridTool()))
            .iconClass('operation')
            .label(t('betterid.tools.active', { tool: t('betterid.tools.' + betteridTool()) }))();
    }


    /** Like Photoshop, clicking the active tool keeps it active. */
    function chooseTool(tool) {
        setBetteridTool(tool);
        flashTool();
    }


    function sliderRow(container, label, value, min, max, step, format, onInput) {
        var row = container.append('label').attr('class', 'betterid-tool-option');
        row.append('span').attr('class', 'betterid-tool-option-label').call(t.append(label));
        var output;
        row.append('input')
            .attr('type', 'range')
            .attr('min', min)
            .attr('max', max)
            .attr('step', step)
            .property('value', value)
            .on('input', function() {
                var next = Number(this.value);
                output.text(format(next));
                onInput(next);
            });
        output = row.append('output').text(format(value));
        return row;
    }


    function checkRow(container, label, checked, onChange) {
        var row = container.append('label').attr('class', 'betterid-tool-check');
        row.append('input')
            .attr('type', 'checkbox')
            .property('checked', checked)
            .on('change', function() {
                onChange(this.checked);
            });
        row.append('span').call(t.append(label));
        return row;
    }


    /** Photoshop's fly-out: right-click picks another member of the group. */
    function openGroupMenu(d3_event, group) {
        closeGroupMenu();

        var entries = groupEntries(group);
        if (!entries.length) return;

        var palette = _container.select('.betterid-tool-palette');
        if (palette.empty()) return;

        var button = d3_select(d3_event.currentTarget);
        var buttonNode = button.node();
        var menu = palette
            .append('div')
            .attr('class', 'betterid-tool-menu')
            .attr('role', 'menu');

        entries.forEach(function(entry) {
            var item = menu
                .append('button')
                .attr('type', 'button')
                .attr('class', 'betterid-tool-menu-item')
                .attr('role', 'menuitem')
                .classed('active', entry.selected)
                .on('click', function(click_event) {
                    click_event.preventDefault();
                    click_event.stopPropagation();
                    entry.apply();
                    closeGroupMenu();
                });

            item.call(svgIcon(entry.icon));
            item.append('span').call(t.append(entry.label));
            if (entry.key) item.append('kbd').text(t(entry.key));
        });

        // align the menu with its button, clamped to the viewport
        var top = buttonNode ? buttonNode.offsetTop : 0;
        var rect = buttonNode ? buttonNode.getBoundingClientRect() : null;
        if (rect && rect.top > window.innerHeight - 140) {
            top = Math.max(0, top - 110);
        }
        menu.style('top', top + 'px');

        d3_select(window).on('keydown.betteridToolMenu', function(key_event) {
            if (key_event.key === 'Escape') {
                key_event.preventDefault();
                closeGroupMenu();
            }
        });
        d3_select(window).on('pointerdown.betteridToolMenu', function(down_event) {
            var target = down_event.target;
            if (target && target.closest && target.closest('.betterid-tool-menu')) return;
            closeGroupMenu();
        }, true);
    }


    function closeGroupMenu() {
        _container.selectAll('.betterid-tool-menu').remove();
        d3_select(window)
            .on('keydown.betteridToolMenu', null)
            .on('pointerdown.betteridToolMenu', null);
    }


    function renderOptions(options, tool) {
        if (tool === 'quickselect') {
            sliderRow(options, 'betterid.tools.brush_size', brushSize(), 8, 200, 4,
                v => String(v), setBrushSize);

        } else if (tool === 'magicwand') {
            sliderRow(options, 'betterid.tools.tolerance', wandTolerance(), 0, 10, 1,
                v => String(v), setWandTolerance);
            checkRow(options, 'betterid.tools.contiguous', wandContiguous(), setWandContiguous);

        } else if (tool === 'pen') {
            // the slider reads as "detail": left = more nodes / smoother
            var range = BETTERID_PEN_TOLERANCE_RANGE;
            sliderRow(options, 'betterid.tools.pen_detail', penTolerance(), range[0], range[1], 0.05,
                v => v.toFixed(2) + 'px', setPenTolerance);
            checkRow(options, 'betterid.tools.pen_snapping', penSnapping(), setPenSnapping);
            checkRow(options, 'betterid.tools.pen_rubber_band', penRubberBand(), setPenRubberBand);
            options.append('p')
                .attr('class', 'betterid-tool-hint')
                .call(t.append('betterid.tools.pen_help'));
        }
    }


    function render(selection) {
        closeGroupMenu();
        selection.selectAll('.betterid-tool-palette').remove();

        context.container().classed('betterid-tool-active', betteridTool() !== 'select');

        var palette = selection
            .append('div')
            .attr('class', 'betterid-tool-palette');

        var tools = palette
            .append('div')
            .attr('class', 'betterid-tool-buttons');

        BETTERID_TOOL_GROUPS.forEach(function(group) {
            var shown = groupTool(group.id);
            var entries = groupEntries(group);

            var button = tools
                .append('button')
                .attr('type', 'button')
                .attr('class', 'betterid-tool-button betterid-tool-group betterid-tool-' + shown)
                .attr('data-group', group.id)
                .attr('data-tools', group.tools.join(' '))
                .classed('active', group.tools.indexOf(betteridTool()) !== -1)
                .classed('has-variants', entries.length > 1)
                .on('click', function(d3_event) {
                    d3_event.preventDefault();
                    closeGroupMenu();
                    chooseTool(shown);
                })
                .on('contextmenu', function(d3_event) {
                    if (entries.length < 2) return;
                    d3_event.preventDefault();
                    d3_event.stopPropagation();
                    openGroupMenu(d3_event, group);
                });

            button.call(svgIcon(toolIcon(shown)));

            var keys = group.tools.map(tool => t('betterid.tools.' + tool + '_key')).filter(Boolean);
            button.call(uiTooltip()
                .placement('right')
                .title(() => t.append('betterid.tools.' + shown))
                .keys(keys)
                .scrollContainer(context.container().select('.over-map')));
        });

        var options = palette.append('div').attr('class', 'betterid-tool-options');
        renderOptions(options, betteridTool());

        // tools without options keep the palette a compact icon strip
        if (!options.node().childNodes.length) options.remove();
    }


    function palette(selection) {
        _container = selection;
        render(selection);

        STRUCTURAL_PREFS.forEach(function(key) {
            prefs.onChange(key, function() {
                if (!_container.empty()) render(_container);
            });
        });

        d3_select(window).on('keydown.betteridToolKeys', keydown, true);
    }


    /**
     * Photoshop's tool keys: `V` select, `M` marquee, `P` pen, and `Shift+W`
     * for the selection group (quick selection / magic wand, press again to
     * swap). Plain `W` stays iD's wireframe toggle, which the map handles
     * before anyone else sees the key. Pressing the key of the active group
     * again cycles its members (`Shift+M` cycles the marquee shapes directly).
     */
    function keydown(d3_event) {
        if (d3_event.ctrlKey || d3_event.metaKey || d3_event.altKey) return;
        var target = d3_event.target;
        if (target && target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

        var key = (d3_event.key || '').toLowerCase();

        // Illustrator gives the marquee shapes their own keys (M rectangle,
        // L ellipse); Photoshop keeps the single cycling key.
        if (shortcutPreset() === 'illustrator' && !d3_event.shiftKey && (key === 'm' || key === 'l')) {
            d3_event.preventDefault();
            d3_event.stopPropagation();
            setMarqueeShape(key === 'm' ? 'rect' : 'ellipse');
            setBetteridTool('marquee');
            flashTool();
            return;
        }

        var tool;
        if (key === 'v') tool = 'select';
        else if (key === 'm') tool = 'marquee';
        else if (key === 'p') tool = 'pen';
        else if (key === 'w' && d3_event.shiftKey) tool = groupTool('selection');
        else return;

        // WASD navigation owns its keys when it is switched on
        if (key === 'w' && experimentalFeatureEnabled(BETTERID_PREFS.wasdNavigation)) return;

        d3_event.preventDefault();
        d3_event.stopPropagation();

        var cycle = betteridTool() === tool;
        if (!cycle) {
            setBetteridTool(tool);
        } else if (tool === 'marquee') {
            cycleMarqueeShape();
        } else if (tool === 'quickselect') {
            setSelectionTool('magicwand');
            setBetteridTool('magicwand');
        } else if (tool === 'magicwand') {
            setSelectionTool('quickselect');
            setBetteridTool('quickselect');
        }

        if (tool === 'marquee' && d3_event.shiftKey && !cycle) {
            cycleMarqueeShape();
        }
        flashTool();
    }


    return palette;
}
