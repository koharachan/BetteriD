import { select as d3_select } from 'd3-selection';

import {
    betteridTool, marqueeShape, brushSize, wandTolerance, wandContiguous,
    selectionMode, combineSelection
} from '../core/betterid_tools';
import { modeSelect } from '../modes/select';
import { utilFastMouse } from '../util';
import {
    entitiesInRect, entitiesInEllipse, entitiesInBrush, expandBySimilarity
} from '../util/betterid_selection';


var MIN_MARQUEE = 4;   // px before a drag counts as a marquee instead of a click


/**
 * Marquee (rectangle / ellipse), quick selection (brush) and magic wand.
 *
 * The pointerdown listener lives on `window` in the capture phase: a plain
 * left-drag must never reach the map's zoom/pan gestures, and while one of
 * these tools is active the editor stays in browse mode so the mode behaviors
 * never compete for the same gesture.
 */
export function behaviorBetteridSelectTools(context) {
    var prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
    var _gesture = null;
    var _overlay = d3_select(null);
    var _shape = d3_select(null);
    var _brush = d3_select(null);
    var _liveMode = 'replace';


    function activeTool() {
        var tool = betteridTool();
        return (tool === 'marquee' || tool === 'quickselect' || tool === 'magicwand') ? tool : null;
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


    function datumEntity(target) {
        var element = target;
        while (element && element !== document.body) {
            var datum = element.__data__;
            if (datum) {
                if (datum.properties && datum.properties.entity) return datum.properties.entity;
                if (datum.entity) return datum.entity;
                if (datum.id && datum.type) return datum;
            }
            element = element.parentNode;
        }
        return null;
    }


    function wandSeed(point, d3_event) {
        var entity = datumEntity(d3_event.target);
        if (entity && context.hasEntity(entity.id)) return entity.id;

        // nothing rendered right under the pointer: fall back to the closest
        // feature inside a small brush
        var ids = entitiesInBrush(context, {
            centerX: point[0],
            centerY: point[1],
            radius: Math.max(8, brushSize() / 2)
        });
        return ids.length ? ids[0] : null;
    }


    function marqueeResult(start, current) {
        if (marqueeShape() === 'ellipse') {
            var radiusX = Math.abs(current[0] - start[0]) / 2;
            var radiusY = Math.abs(current[1] - start[1]) / 2;
            if (radiusX < 1 || radiusY < 1) return [];
            return entitiesInEllipse(context, {
                centerX: (start[0] + current[0]) / 2,
                centerY: (start[1] + current[1]) / 2,
                radiusX: radiusX,
                radiusY: radiusY
            }).map(entity => entity.id);
        }

        if (Math.abs(current[0] - start[0]) < 1 || Math.abs(current[1] - start[1]) < 1) return [];
        return entitiesInRect(context, {
            minX: Math.min(start[0], current[0]),
            minY: Math.min(start[1], current[1]),
            maxX: Math.max(start[0], current[0]),
            maxY: Math.max(start[1], current[1])
        }).map(entity => entity.id);
    }


    function quickSelectResult(start, current) {
        var radius = brushSize() / 2;
        var points = [start];

        if (current) {
            var distance = Math.hypot(current[0] - start[0], current[1] - start[1]);
            var steps = Math.max(1, Math.ceil(distance / Math.max(1, radius / 2)));
            for (var i = 1; i <= steps; i++) {
                points.push([
                    start[0] + ((current[0] - start[0]) * i / steps),
                    start[1] + ((current[1] - start[1]) * i / steps)
                ]);
            }
        }

        var ids = new Set();
        points.forEach(point => {
            entitiesInBrush(context, {
                centerX: point[0],
                centerY: point[1],
                radius: radius
            }).forEach(id => ids.add(id));
        });

        if (!ids.size) return [];

        // grow one hop towards tag-similar neighbours, like Photoshop's brush
        // snapping onto the edge of the region under it
        return expandBySimilarity(context.graph(), Array.from(ids), {
            tolerance: wandTolerance(),
            contiguous: true,
            sameGeometry: true
        });
    }


    function wandResult(seedID) {
        if (!seedID) return [];
        return expandBySimilarity(context.graph(), [seedID], {
            tolerance: wandTolerance(),
            contiguous: wandContiguous(),
            sameGeometry: true
        });
    }


    function stopListeners() {
        d3_select(window)
            .on(prefix + 'move.betteridSelectTools', null)
            .on(prefix + 'up.betteridSelectTools', null)
            .on('pointercancel.betteridSelectTools', null);
    }


    function finishGesture(d3_event) {
        var gesture = _gesture;
        _gesture = null;
        stopListeners();
        hideOverlay();
        context.container().classed('betterid-tool-dragging', false);

        if (!gesture) return;

        var mode = selectionMode(d3_event);
        var ids = [];

        if (gesture.tool === 'marquee') {
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
            ids = dragged ? marqueeResult(gesture.start, current) : [];

        } else if (gesture.tool === 'quickselect') {
            ids = gesture.currentIDs || quickSelectResult(gesture.start, null);

        } else if (gesture.tool === 'magicwand') {
            ids = wandResult(gesture.seed);
        }

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

        var osmLayer = context.layers().layer('osm');
        if (osmLayer && !osmLayer.enabled()) return;

        var point = mouseLoc(d3_event);
        _liveMode = selectionMode(d3_event);

        _gesture = {
            tool: tool,
            start: point,
            current: point,
            seed: tool === 'magicwand' ? wandSeed(point, d3_event) : null,
            currentIDs: null
        };

        if (tool === 'marquee') {
            showOverlay();
            drawMarquee(point, point);
        } else if (tool === 'quickselect') {
            showOverlay();
            drawBrush(point);
        } else {
            hideOverlay();
        }

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
            _gesture.currentIDs = quickSelectResult(_gesture.start, point);
        }

        d3_event.preventDefault();
        d3_event.stopPropagation();
    }


    function behavior() {
        d3_select(window).on(prefix + 'down.betteridSelectTools', pointerdown, true);
    }


    behavior.off = function() {
        d3_select(window).on(prefix + 'down.betteridSelectTools', null, true);
        stopListeners();
        hideOverlay();
        _gesture = null;
        context.container().classed('betterid-tool-dragging', false);
    };


    return behavior;
}
