import { select as d3_select } from 'd3-selection';

import {
    BETTERID_TOOL_GROUPS, BETTERID_MARQUEE_SHAPES,
    betteridTool, setBetteridTool, groupTool, setSelectionTool,
    marqueeShape, setMarqueeShape, cycleMarqueeShape,
    brushSize, setBrushSize,
    wandTolerance, setWandTolerance,
    wandContiguous, setWandContiguous,
    BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_BRUSH_SIZE_PREF,
    BETTERID_WAND_TOLERANCE_PREF, BETTERID_WAND_CONTIGUOUS_PREF,
    BETTERID_SELECTION_LAST_PREF
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


    function chooseTool(tool) {
        setBetteridTool(betteridTool() === tool && tool !== 'select' ? 'select' : tool);
        context.ui().flash
            .duration(1500)
            .iconName(toolIcon(betteridTool()))
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
        var tool = betteridTool();

        if (tool === 'quickselect') {
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
        }

        // tools without options keep the palette a compact icon strip
        if (!options.node().childNodes.length) options.remove();
    }


    function palette(selection) {
        _container = selection;
        render(selection);

        // re-render whenever a tool preference changes
        [
            BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_BRUSH_SIZE_PREF,
            BETTERID_WAND_TOLERANCE_PREF, BETTERID_WAND_CONTIGUOUS_PREF,
            BETTERID_SELECTION_LAST_PREF
        ].forEach(function(key) {
            prefs.onChange(key, function() {
                if (!_container.empty()) render(_container);
            });
        });

        d3_select(window).on('keydown.betteridToolKeys', keydown, true);
    }


    /**
     * Photoshop's tool keys: `V` select, `M` marquee, `W` quick selection,
     * `Shift+W` magic wand, `P` pen. Pressing the key of the active group again
     * cycles its members (`Shift+M` cycles the marquee shapes directly).
     */
    function keydown(d3_event) {
        if (d3_event.ctrlKey || d3_event.metaKey || d3_event.altKey) return;
        var target = d3_event.target;
        if (target && target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

        var key = (d3_event.key || '').toLowerCase();
        var tool;
        if (key === 'v') tool = 'select';
        else if (key === 'm') tool = 'marquee';
        else if (key === 'p') tool = 'pen';
        else if (key === 'w') tool = d3_event.shiftKey ? 'magicwand' : 'quickselect';
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
        } else {
            chooseTool(tool);
        }

        if (tool === 'marquee' && d3_event.shiftKey && betteridTool() === 'marquee') {
            cycleMarqueeShape();
        }
    }


    return palette;
}
