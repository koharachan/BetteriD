import { select as d3_select } from 'd3-selection';

import {
    betteridTool, marqueeShape, brushSize, wandTolerance, wandContiguous,
    selectionMode, combineSelection, adobeShortcutsEnabled, BETTERID_TOOL_PREF
} from '../core/betterid_tools';
import { actionAddEntity } from '../actions/add_entity';
import { osmNode, osmWay } from '../osm';
import { prefs } from '../core/preferences';
import { t } from '../core/localizer';
import { modeSelect } from '../modes/select';
import { utilFastMouse } from '../util';
import { entitiesInRect, entitiesInEllipse } from '../util/betterid_selection';
import {
    captureImagery, floodSelect, brushSelect, pixelColor, pixelHex, maskOutline, maskPolygons
} from '../util/betterid_imagery';


var MIN_MARQUEE = 4;   // px before a drag counts as a marquee instead of a click
var PIXEL_TOOLS = ['quickselect', 'magicwand'];


/**
 * Marquee (rectangle / ellipse), quick selection (brush) and magic wand.
 *
 * The quick selection and magic wand tools work on the *base imagery*, the way
 * Photoshop works on pixels; the marquee selects OSM nodes. The pointerdown
 * listener lives on `window` in the capture phase, so a plain left-drag never
 * reaches the map's zoom/pan gestures.
 */
export function behaviorBetteridSelectTools(context) {
    var prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
    var _gesture = null;
    var _overlay = d3_select(null);
    var _shape = d3_select(null);
    var _brush = d3_select(null);
    var _liveMode = 'replace';
    var _ants = d3_select(null);
    var _menu = d3_select(null);
    var _pixels = null;      // the current imagery selection
    var _baseline = null;    // mask the next gesture combines with


    function activeTool() {
        var tool = betteridTool();
        return (tool === 'marquee' || tool === 'quickselect' || tool === 'magicwand') ? tool : null;
    }


    function pixelTool() {
        var tool = activeTool();
        return PIXEL_TOOLS.indexOf(tool) === -1 ? null : tool;
    }


    function mapNode() {
        return context.container().select('.main-map').node();
    }


    function mouseLoc(d3_event) {
        var node = mapNode();
        if (!node) return [0, 0];
        return utilFastMouse(node)(d3_event);
    }


    function ensureOverlay() {
        if (!_overlay.empty()) return;

        _overlay = context.surface()
            .selectAll('.betterid-selection-preview')
            .data([0])
            .enter()
            .append('g')
            .attr('class', 'betterid-selection-preview hide');

        _shape = _overlay.append('rect').attr('class', 'betterid-marquee');
        _brush = _overlay.append('circle').attr('class', 'betterid-brush');
    }


    function showOverlay() {
        ensureOverlay();
        _overlay
            .classed('hide', false)
            .classed('subtract', _liveMode === 'subtract')
            .classed('intersect', _liveMode === 'intersect');
    }


    function hideOverlay() {
        if (_overlay.empty()) return;
        _overlay.classed('hide', true);
        _shape.attr('width', 0).attr('height', 0).attr('rx', 0);
        _brush.attr('r', 0);
    }


    function drawMarquee(start, current) {
        var minX = Math.min(start[0], current[0]);
        var minY = Math.min(start[1], current[1]);
        var width = Math.abs(current[0] - start[0]);
        var height = Math.abs(current[1] - start[1]);

        if (marqueeShape() === 'ellipse') {
            _shape
                .attr('x', minX).attr('y', minY)
                .attr('width', width).attr('height', height)
                .attr('rx', width / 2).attr('ry', height / 2);
        } else {
            _shape
                .attr('x', minX).attr('y', minY)
                .attr('width', width).attr('height', height)
                .attr('rx', 0);
        }
    }


    function drawBrush(point) {
        _brush
            .attr('cx', point[0])
            .attr('cy', point[1])
            .attr('r', brushSize() / 2);
    }


    function marqueeResult(start, current) {
        // Only nodes: dragging a box used to grab whole ways that merely crossed
        // it, which is almost never what the box was drawn around.
        var nodesOnly = matches => matches
            .filter(entity => entity && entity.type === 'node')
            .map(entity => entity.id);

        if (marqueeShape() === 'ellipse') {
            var radiusX = Math.abs(current[0] - start[0]) / 2;
            var radiusY = Math.abs(current[1] - start[1]) / 2;
            if (radiusX < 1 || radiusY < 1) return [];
            return nodesOnly(entitiesInEllipse(context, {
                centerX: (start[0] + current[0]) / 2,
                centerY: (start[1] + current[1]) / 2,
                radiusX: radiusX,
                radiusY: radiusY
            }));
        }

        if (Math.abs(current[0] - start[0]) < 1 || Math.abs(current[1] - start[1]) < 1) return [];
        return nodesOnly(entitiesInRect(context, {
            minX: Math.min(start[0], current[0]),
            minY: Math.min(start[1], current[1]),
            maxX: Math.max(start[0], current[0]),
            maxY: Math.max(start[1], current[1])
        }));
    }


    function stopListeners() {
        d3_select(window)
            .on(prefix + 'move.betteridSelectTools', null)
            .on(prefix + 'up.betteridSelectTools', null)
            .on('pointercancel.betteridSelectTools', null);
    }


    /* ------------------------------------------- imagery pixel selection --- */

    /**
     * Where the captured mask sits on screen: the projection only scales and
     * translates, so one captured pixel maps to `k` screen pixels at `p0`.
     */
    function maskFrame() {
        if (!_pixels) return null;
        var p0 = context.projection(_pixels.originGeo);
        var step = [
            _pixels.originGeo[0] + _pixels.perPixel[0],
            _pixels.originGeo[1] + _pixels.perPixel[1]
        ];
        var p1 = context.projection(step);
        var k = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
        return { p0: p0, k: k };
    }


    function pixelOutlinePath() {
        if (!_pixels) return null;
        var frame = maskFrame();
        if (!frame) return null;

        var runs = maskOutline(_pixels.mask, _pixels.width, _pixels.height);
        if (!runs.length) return null;

        var p0 = frame.p0;
        var k = frame.k;
        var parts = [];
        for (var i = 0; i < runs.length; i++) {
            var r = runs[i];
            var x1 = p0[0] + r[0] * k;
            var y1 = p0[1] + r[1] * k;
            var x2 = p0[0] + r[2] * k;
            var y2 = p0[1] + r[3] * k;
            // a run is horizontal or vertical: two points are enough
            parts.push('M' + x1.toFixed(1) + ',' + y1.toFixed(1) + 'L' + x2.toFixed(1) + ',' + y2.toFixed(1));
        }
        return parts.join('');
    }


    function clearPixels() {
        _pixels = null;
        _baseline = null;
    }


    function combineMask(mask, mode) {
        if (!_baseline) return mask;
        var out = new Uint8Array(mask.length);
        for (var i = 0; i < mask.length; i++) {
            var had = _baseline[i];
            var add = mask[i];
            out[i] = mode === 'add' ? (had || add ? 1 : 0)
                : mode === 'subtract' ? (had && !add ? 1 : 0)
                : mode === 'intersect' ? (had && add ? 1 : 0)
                : add;
        }
        return out;
    }


    /** Capture the visible imagery once per gesture and run `work` on it. */
    function withImagery(work) {
        var tool = pixelTool();
        if (!tool) return;
        if (context.container().classed('betterid-imagery-busy')) return;
        context.container().classed('betterid-imagery-busy', true);

        captureSheet().then(function(sheet) {
            context.container().classed('betterid-imagery-busy', false);
            if (!sheet) {
                context.ui().flash
                    .duration(4000)
                    .iconName('#iD-icon-alert')
                    .iconClass('operation')
                    .label(t('betterid.tools.imagery_unreadable'))();
                return;
            }

            var ctx = sheet.canvas.getContext('2d', { willReadFrequently: true });
            var imageData = ctx.getImageData(0, 0, sheet.width, sheet.height);
            var originGeo = context.projection.invert([0, 0]);
            var edge = context.projection.invert([1, 1]);
            var perPixel = [edge[0] - originGeo[0], edge[1] - originGeo[1]];

            work(imageData, {
                width: sheet.width,
                height: sheet.height,
                originGeo: originGeo,
                perPixel: perPixel,
                imageData: imageData
            });
        }).catch(function() {
            context.container().classed('betterid-imagery-busy', false);
        });
    }


    /**
     * Tiles can still be arriving (or be re-fetched for CORS), so retry a few
     * times before giving up: the first wand click after a pan used to do
     * nothing because the sheet was not readable yet.
     */
    function captureSheet() {
        var attempts = 0;
        function attempt() {
            return captureImagery(context).then(function(sheet) {
                if (sheet) return sheet;
                attempts++;
                if (attempts >= 5) return null;
                return new Promise(function(resolve) {
                    setTimeout(function() { resolve(attempt()); }, 500);
                });
            });
        }
        return attempt();
    }


    function startWand(point, d3_event) {
        var mode = selectionMode(d3_event);
        withImagery(function(imageData, sheet) {
            var mask = floodSelect(imageData, {
                x: point[0],
                y: point[1],
                tolerance: wandTolerance(),
                contiguous: wandContiguous()
            });
            _pixels = {
                mask: combineMask(mask, mode),
                width: sheet.width,
                height: sheet.height,
                originGeo: sheet.originGeo,
                perPixel: sheet.perPixel
            };
            _baseline = _pixels.mask;
            drawAnts();
        });
    }


    function startBrush(gesture, mode) {
        var point = gesture.start;
        withImagery(function(imageData, sheet) {
            if (_gesture !== gesture) return;   // the gesture ended meanwhile

            var seed = pixelColor(imageData, point[0], point[1]) || [0, 0, 0];
            var mask = new Uint8Array(sheet.width * sheet.height);
            brushSelect(imageData, mask, {
                points: gesture.points.slice(),
                radius: brushSize() / 2,
                tolerance: wandTolerance(),
                seed: seed
            });

            _pixels = {
                mask: combineMask(mask, mode),
                width: sheet.width,
                height: sheet.height,
                originGeo: sheet.originGeo,
                perPixel: sheet.perPixel
            };
            _baseline = _pixels.mask;

            gesture.imageData = imageData;
            gesture.seed = seed;
            gesture.mask = _pixels.mask.slice();
            gesture.pending = false;
            drawAnts();
        });
    }


    /** Alt+click: pick the imagery colour under the pointer and copy its hex. */
    function eyedropper(point) {
        withImagery(function(imageData) {
            var hex = pixelHex(imageData, Math.round(point[0]), Math.round(point[1]));
            if (!hex) return;

            context.ui().flash
                .duration(3000)
                .iconName('#iD-icon-apply')
                .iconClass('operation')
                .label(t('betterid.tools.eyedropper_copied', { color: hex }))();

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(hex).catch(function() { /* ignore */ });
            }
        });
    }


    /* ------------------------------------------------- marching ants ------- */

    function ensureAnts() {
        if (!_ants.empty()) return;
        _ants = context.surface()
            .selectAll('.betterid-ants')
            .data([0])
            .enter()
            .append('g')
            .attr('class', 'betterid-ants');
    }


    /** Screen-space outlines of the current selection (nodes and ways). */
    function selectionOutlines() {
        var graph = context.graph();
        var projection = context.projection;
        var outlines = [];

        context.selectedIDs().forEach(function(id) {
            var entity = context.entity(id);
            if (!entity) return;

            if (entity.type === 'node') {
                var p = projection(entity.loc);
                var s = 4;
                outlines.push('M' + (p[0] - s) + ',' + (p[1] - s) +
                    'h' + (2 * s) + 'v' + (2 * s) + 'h' + (-2 * s) + 'Z');

            } else if (entity.type === 'way') {
                var points = entity.nodes
                    .map(function(nodeID) {
                        var node = graph.entity(nodeID);
                        return node ? projection(node.loc) : null;
                    })
                    .filter(Boolean);
                if (points.length < 2) return;
                outlines.push('M' + points.map(function(q) { return q[0] + ',' + q[1]; }).join(' L') +
                    (entity.isClosed() ? ' Z' : ''));
            }
        });

        return outlines;
    }


    /** Photoshop's marching ants around whatever the tools selected. */
    function drawAnts() {
        var outlines = activeTool() ? selectionOutlines() : [];
        var ants = pixelOutlinePath();
        if (ants) outlines.push(ants);

        if (!outlines.length) {
            if (!_ants.empty()) _ants.selectAll('*').remove();
            return;
        }

        ensureAnts();

        var halos = _ants.selectAll('.betterid-ants-halo').data(outlines);
        halos.exit().remove();
        halos.enter().append('path')
            .attr('class', 'betterid-ants-halo')
            .merge(halos)
            .attr('d', d => d);

        var lines = _ants.selectAll('.betterid-ants-line').data(outlines);
        lines.exit().remove();
        lines.enter().append('path')
            .attr('class', 'betterid-ants-line')
            .merge(lines)
            .attr('d', d => d);
    }


    /* ------------------------------------------------- selection actions --- */

    /** Ctrl+D / Cmd+D clears the selection, like Photoshop. */
    function keydown(d3_event) {
        if (!activeTool()) return;
        var target = d3_event.target;
        if (target && target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

        var key = (d3_event.key || '').toLowerCase();
        var command = (d3_event.ctrlKey || d3_event.metaKey) && !d3_event.altKey;

        if (command && key === 'd') {
            d3_event.preventDefault();
            d3_event.stopPropagation();
            clearPixels();
            context.enter(modeSelect(context, []));
            drawAnts();

        } else if (d3_event.altKey && (key === 'delete' || key === 'backspace')) {
            d3_event.preventDefault();
            d3_event.stopPropagation();
            convertSelectionToPath();
        }
    }


    /**
     * Photoshop's "convert selection to path": build a way through the selected
     * nodes (and the nodes of any selected way), ordered as a nearest-neighbour
     * chain starting from the westernmost point.
     */
    function convertSelectionToPath() {
        if (_pixels) {
            convertPixelsToPath();
            return;
        }

        var graph = context.graph();
        var candidates = [];
        var seen = {};

        context.selectedIDs().forEach(function(id) {
            var entity = context.entity(id);
            if (!entity) return;

            if (entity.type === 'node') {
                if (!seen[id]) { seen[id] = true; candidates.push(entity); }

            } else if (entity.type === 'way') {
                entity.nodes.forEach(function(nodeID) {
                    var node = graph.entity(nodeID);
                    if (node && !seen[nodeID]) { seen[nodeID] = true; candidates.push(node); }
                });
            }
        });

        if (candidates.length < 2) return;

        var remaining = candidates.slice();
        remaining.sort(function(a, b) { return a.loc[0] - b.loc[0]; });

        var chain = [remaining.shift()];
        while (remaining.length) {
            var last = chain[chain.length - 1].loc;
            var best = 0;
            var bestDistance = Infinity;
            for (var i = 0; i < remaining.length; i++) {
                var node = remaining[i];
                var distance = Math.pow(node.loc[0] - last[0], 2) + Math.pow(node.loc[1] - last[1], 2);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = i;
                }
            }
            chain.push(remaining.splice(best, 1)[0]);
        }

        var way = new osmWay({ nodes: chain.map(function(node) { return node.id; }), tags: {} });
        context.perform(actionAddEntity(way), t('betterid.tools.convert_to_path'));
        context.enter(modeSelect(context, [way.id]));
        drawAnts();
    }


    /**
     * Trace the imagery selection into real OSM geometry: each outline becomes a
     * closed way, which is how you digitise a lake or a building from imagery.
     */
    function convertPixelsToPath() {
        var polygons = maskPolygons(_pixels.mask, _pixels.width, _pixels.height)
            .filter(polygon => polygon.length >= 3);
        if (!polygons.length) return;

        var nodes = [];
        var ways = [];

        polygons.forEach(function(polygon) {
            var wayNodes = [];
            polygon.forEach(function(point) {
                var loc = [
                    _pixels.originGeo[0] + point[0] * _pixels.perPixel[0],
                    _pixels.originGeo[1] + point[1] * _pixels.perPixel[1]
                ];
                var node = new osmNode({ loc: loc, tags: {} });
                nodes.push(node);
                wayNodes.push(node.id);
            });
            if (wayNodes.length < 3) return;
            wayNodes.push(wayNodes[0]);
            ways.push(new osmWay({ nodes: wayNodes, tags: {} }));
        });

        if (!ways.length) return;

        var actions = nodes.map(node => actionAddEntity(node));
        ways.forEach(way => actions.push(actionAddEntity(way)));
        context.perform.apply(context, actions.concat([t('betterid.tools.convert_to_path')]));

        clearPixels();
        context.enter(modeSelect(context, [ways[0].id]));
        drawAnts();
    }


    /* ------------------------------------------------- right click menu ---- */

    function closeSelectionMenu() {
        if (!_menu.empty()) _menu.remove();
        _menu = d3_select(null);
        d3_select(window).on('pointerdown.betteridSelectionMenu', null);
    }


    function openSelectionMenu(d3_event) {
        closeSelectionMenu();
        if (!activeTool() || (!context.selectedIDs().length && !_pixels)) return;

        var point = mouseLoc(d3_event);
        var host = context.container().select('.main-map');
        if (host.empty()) return;

        _menu = host
            .append('div')
            .attr('class', 'betterid-selection-menu')
            .style('left', point[0] + 'px')
            .style('top', point[1] + 'px');

        var item = _menu
            .append('button')
            .attr('type', 'button')
            .attr('class', 'betterid-tool-menu-item')
            .on('click', function(click_event) {
                click_event.preventDefault();
                click_event.stopPropagation();
                convertSelectionToPath();
                closeSelectionMenu();
            });

        item.append('span').call(t.append('betterid.tools.convert_to_path'));
        item.append('kbd').text(t('betterid.tools.convert_to_path_key'));

        d3_select(window).on('pointerdown.betteridSelectionMenu', function(down_event) {
            var target = down_event.target;
            if (target && target.closest && target.closest('.betterid-selection-menu')) return;
            closeSelectionMenu();
        }, true);
    }


    function contextmenu(d3_event) {
        if (!activeTool()) return;
        var target = d3_event.target;
        if (!target || !target.closest || !target.closest('.main-map')) return;

        d3_event.preventDefault();
        d3_event.stopPropagation();
        openSelectionMenu(d3_event);
    }


    function finishGesture(d3_event) {
        var gesture = _gesture;
        _gesture = null;
        stopListeners();
        hideOverlay();
        context.container().classed('betterid-tool-dragging', false);

        if (!gesture) return;

        var mode = selectionMode(d3_event);

        // the imagery tools updated their mask during the gesture
        if (PIXEL_TOOLS.indexOf(gesture.tool) !== -1) {
            drawAnts();
            return;
        }

        var dragged = Math.hypot(gesture.current[0] - gesture.start[0],
            gesture.current[1] - gesture.start[1]) >= MIN_MARQUEE;

        var current = gesture.current;
        if (dragged && marqueeShape() === 'ellipse' && d3_event.shiftKey && !d3_event.altKey) {
            // Photoshop constrains the ellipse to a circle
            var size = Math.max(Math.abs(current[0] - gesture.start[0]),
                Math.abs(current[1] - gesture.start[1]));
            current = [
                gesture.start[0] + Math.sign(current[0] - gesture.start[0] || 1) * size,
                gesture.start[1] + Math.sign(current[1] - gesture.start[1] || 1) * size
            ];
        }
        var ids = dragged ? marqueeResult(gesture.start, current) : [];

        var combined = combineSelection(context.selectedIDs(), ids, mode);
        context.enter(modeSelect(context, combined));
    }


    function pointerdown(d3_event) {
        if (_gesture) return;

        var tool = activeTool();
        if (!tool || d3_event.button !== 0) return;
        if (d3_event.altKey && d3_event.ctrlKey) return;

        var target = d3_event.target;
        if (!target || !target.closest || !target.closest('.main-map')) return;
        if (context.container().classed('betterid-hand-tool')) return;
        if (!context.map().withinEditableZoom()) return;

        // the pixel tools work on the imagery, so they do not need the OSM layer
        if (PIXEL_TOOLS.indexOf(tool) === -1) {
            var osmLayer = context.layers().layer('osm');
            if (osmLayer && !osmLayer.enabled()) return;
        }

        var point = mouseLoc(d3_event);
        _liveMode = selectionMode(d3_event);

        // Alt+click is the eyedropper (the Adobe layer does it too, when it is on)
        if (d3_event.altKey && PIXEL_TOOLS.indexOf(tool) !== -1 && !adobeShortcutsEnabled()) {
            eyedropper(point);
            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }

        if (tool === 'magicwand') {
            // the wand is a pixel tool: it needs the imagery, not the OSM data
            _baseline = _pixels ? _pixels.mask : null;
            startWand(point, d3_event);
            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }

        if (tool === 'quickselect') {
            _baseline = _pixels ? _pixels.mask : null;
            _gesture = {
                tool: 'quickselect',
                start: point,
                current: point,
                points: [point],
                pending: true,
                seed: null,
                mask: null,
                imageData: null,
                currentIDs: null
            };
            showOverlay();
            drawBrush(point);
            context.container().classed('betterid-tool-dragging', true);

            d3_select(window)
                .on(prefix + 'move.betteridSelectTools', pointermove)
                .on(prefix + 'up.betteridSelectTools', finishGesture)
                .on('pointercancel.betteridSelectTools', finishGesture);

            startBrush(_gesture, selectionMode(d3_event));

            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }

        if (tool === 'marquee') {
            showOverlay();
            drawMarquee(point, point);
        } else {
            hideOverlay();
        }

        _gesture = {
            tool: tool,
            start: point,
            current: point,
            seed: null,
            currentIDs: null
        };

        context.container().classed('betterid-tool-dragging', true);

        d3_select(window)
            .on(prefix + 'move.betteridSelectTools', pointermove)
            .on(prefix + 'up.betteridSelectTools', finishGesture)
            .on('pointercancel.betteridSelectTools', finishGesture);

        d3_event.preventDefault();
        d3_event.stopPropagation();
    }


    function pointermove(d3_event) {
        if (!_gesture) return;

        var point = mouseLoc(d3_event);
        _gesture.current = point;
        _liveMode = selectionMode(d3_event);

        if (_gesture.tool === 'marquee') {
            showOverlay();
            drawMarquee(_gesture.start, point);

        } else if (_gesture.tool === 'quickselect') {
            showOverlay();
            drawBrush(point);
            _gesture.points.push(point);

            if (!_gesture.pending && _gesture.imageData && _pixels) {
                brushSelect(_gesture.imageData, _pixels.mask, {
                    points: [point],
                    radius: brushSize() / 2,
                    tolerance: wandTolerance(),
                    seed: _gesture.seed
                });
                drawAnts();
            }
        }

        d3_event.preventDefault();
        d3_event.stopPropagation();
    }


    function behavior() {
        d3_select(window)
            .on(prefix + 'down.betteridSelectTools', pointerdown, true)
            .on('contextmenu.betteridSelectTools', contextmenu, true)
            .on('keydown.betteridSelectTools', keydown, true);

        // the ants follow the map (pan/zoom re-projects them) and the selection
        context.map().on('drawn.betteridSelectTools', drawAnts);
        context.history().on('change.betteridSelectTools', drawAnts);
        prefs.onChange(BETTERID_TOOL_PREF, function() {
            if (PIXEL_TOOLS.indexOf(betteridTool()) === -1) clearPixels();
            drawAnts();
        });
        drawAnts();
    }


    behavior.off = function() {
        d3_select(window)
            .on(prefix + 'down.betteridSelectTools', null, true)
            .on('contextmenu.betteridSelectTools', null, true)
            .on('keydown.betteridSelectTools', null, true);

        context.map().on('drawn.betteridSelectTools', null);
        context.history().on('change.betteridSelectTools', null);
        closeSelectionMenu();
        if (!_ants.empty()) _ants.remove();
        _ants = d3_select(null);
        stopListeners();
        hideOverlay();
        _gesture = null;
        context.container().classed('betterid-tool-dragging', false);
    };


    return behavior;
}
