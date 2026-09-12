import { select as d3_select } from 'd3-selection';

import { betteridTool } from '../core/betterid_tools';
import { actionAddEntity } from '../actions/add_entity';
import { geoVecSubtract, geoVecAdd, geoVecLength } from '../geo';
import { modeSelect } from '../modes/select';
import { osmNode, osmWay } from '../osm';
import { utilFastMouse } from '../util';


var NODE_SPACING_PX = 12;      // target spacing when flattening curves
var HANDLE_THRESHOLD_PX = 3;   // drag distance that turns a corner into a smooth point
var CLOSE_RADIUS_PX = 10;      // click radius that closes the path on the first anchor


/**
 * Pen tool: click for corner points, click-drag for smooth (bezier) points.
 *
 * The path is previewed in SVG while drawing and flattened into real OSM way
 * nodes when the path is finished (Enter / double-click / clicking the first
 * anchor closes it). `Backspace` removes the last point, `Escape` discards.
 */
export function behaviorBetteridPen(context) {
    var prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
    var _anchors = [];
    var _draft = null;
    var _direct = null;      // direct-selection gesture (Alt / Ctrl held)
    var _closed = false;
    var _cursor = null;          // last pointer position, in screen space
    var _overlay = d3_select(null);
    var _preview = d3_select(null);
    var _rubber = d3_select(null);
    var _handles = d3_select(null);
    var _points = d3_select(null);


    function active() {
        return betteridTool() === 'pen';
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
            .selectAll('.betterid-pen-preview')
            .data([0])
            .enter()
            .append('g')
            .attr('class', 'betterid-pen-preview');

        _handles = _overlay.append('g').attr('class', 'betterid-pen-handles');
        _preview = _overlay.append('path').attr('class', 'betterid-pen-path');
        // the segment that is still following the pointer is drawn as a light
        // rubber band, so it is obvious which part is already committed
        _rubber = _overlay.append('path').attr('class', 'betterid-pen-rubber');
        _points = _overlay.append('g').attr('class', 'betterid-pen-points');
    }


    function clearOverlay() {
        if (_overlay.empty()) return;
        _overlay.classed('hide', true);
        _preview.attr('d', null);
        _rubber.attr('d', null);
        _handles.selectAll('*').remove();
        _points.selectAll('*').remove();
    }


    function anchorScreen(anchor) {
        return context.projection(anchor.loc);
    }


    function handleScreen(anchor, which) {
        var offset = anchor[which];
        if (!offset) return null;
        return context.projection(geoVecAdd(anchor.loc, offset));
    }


    function curvePoints(anchors, closed, tail) {
        var list = anchors.slice();
        if (!closed && tail) list.push(tail);
        if (!list.length) return [];
        if (list.length < 2) return list.map(anchorScreen);

        // a closed path also bends the segment from the last anchor back to the
        // first one (its end point *is* the first anchor, so it is not repeated)
        var segments = closed ? list.length : list.length - 1;
        var sampled = [anchorScreen(list[0])];

        for (var i = 0; i < segments; i++) {
            var a = list[i];
            var b = list[(i + 1) % list.length];
            var p0 = anchorScreen(a);
            var p3 = anchorScreen(b);
            var c1 = handleScreen(a, 'handleOut') || p0;
            var c2 = handleScreen(b, 'handleIn') || p3;

            var chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
            var steps = Math.max(1, Math.round(chord / NODE_SPACING_PX));
            if (closed && i === segments - 1) steps = Math.max(1, steps - 1);

            for (var step = 1; step <= steps; step++) {
                var t = step / steps;
                var mt = 1 - t;
                var x = (mt * mt * mt * p0[0]) + (3 * mt * mt * t * c1[0]) + (3 * mt * t * t * c2[0]) + (t * t * t * p3[0]);
                var y = (mt * mt * mt * p0[1]) + (3 * mt * mt * t * c1[1]) + (3 * mt * t * t * c2[1]) + (t * t * t * p3[1]);
                sampled.push([x, y]);
            }
        }

        return sampled;
    }


    /** Anchors that will end up in the way, including the one being dragged. */
    function committedAnchors() {
        var list = _anchors.slice();
        if (_draft) list.push(_draft.anchor);
        return list;
    }


    function toPathD(points, close) {
        if (!points || points.length < 2) return null;
        return 'M' + points.map(p => `${p[0]},${p[1]}`).join(' L') + (close ? ' Z' : '');
    }


    function draw(cursorScreen) {
        ensureOverlay();
        _overlay.classed('hide', false);

        if (cursorScreen) _cursor = cursorScreen;
        var anchors = committedAnchors();

        // Committed geometry: exactly what `finishPath()` will flatten, which is
        // why the dragged anchor contributes its real handles instead of the
        // pointer position (that mismatch used to change the curve on release).
        _preview.attr('d', toPathD(curvePoints(anchors, _closed, null), _closed));

        // Rubber band: the segment that still follows the pointer.
        var rubber = null;
        if (!_closed && _cursor && anchors.length) {
            rubber = toPathD(curvePoints([anchors[anchors.length - 1]], false,
                { loc: context.projection.invert(_cursor) }), false);
        }
        _rubber.attr('d', rubber);

        // anchors and their direction handles
        var points = _points.selectAll('circle').data(anchors, (d, i) => i);
        points.exit().remove();
        points.enter().append('circle')
            .attr('class', 'betterid-pen-point')
            .attr('r', 4)
            .merge(points)
            .attr('cx', d => anchorScreen(d)[0])
            .attr('cy', d => anchorScreen(d)[1]);

        var handleLines = [];
        anchors.forEach(anchor => {
            var center = anchorScreen(anchor);
            ['handleIn', 'handleOut'].forEach(which => {
                var point = handleScreen(anchor, which);
                if (point) handleLines.push({ center, point });
            });
        });

        var lines = _handles.selectAll('line').data(handleLines);
        lines.exit().remove();
        lines.enter().append('line')
            .attr('class', 'betterid-pen-handle')
            .merge(lines)
            .attr('x1', d => d.center[0]).attr('y1', d => d.center[1])
            .attr('x2', d => d.point[0]).attr('y2', d => d.point[1]);
    }


    function screenToGeoOffset(fromLoc, toScreen) {
        var toLoc = context.projection.invert(toScreen);
        return geoVecSubtract(toLoc, fromLoc);
    }


    function finishPath() {
        // Enter, a double click or a click on the first anchor can arrive while
        // the pointer is still down on the anchor being dragged: commit it first,
        // otherwise the last segment is silently dropped.
        if (_draft) {
            _anchors.push(_draft.anchor);
            _draft = null;
        }

        var anchors = _anchors.slice();
        var closed = _closed;
        _anchors = [];
        _cursor = null;
        _closed = false;
        _direct = null;
        context.container().classed('betterid-pen-direct', false);
        clearOverlay();

        if (anchors.length < 1) return;

        var sampled = curvePoints(anchors, closed, null);
        if (sampled.length < 2) return;

        var nodes = [];
        var previous = null;

        sampled.forEach(point => {
            var loc = context.projection.invert(point);
            if (previous && geoVecLength(previous, loc) < 1e-9) return;
            previous = loc;
            nodes.push(new osmNode({ loc: loc, tags: {} }));
        });

        if (nodes.length < 2) return;

        // A closed path reuses its first node as the last one, so the way is
        // really closed (`isClosed()`), which is also what makes it an area.
        var wayNodes = nodes.map(node => node.id);
        if (closed) wayNodes.push(nodes[0].id);

        var way = new osmWay({ nodes: wayNodes, tags: {} });

        var actions = nodes.map(node => actionAddEntity(node));
        actions.push(actionAddEntity(way));
        context.perform.apply(context, actions);

        if (context.hasEntity(way.id)) {
            context.enter(modeSelect(context, [way.id]));
        }
    }


    function cancelPath() {
        _anchors = [];
        _draft = null;
        _direct = null;
        _cursor = null;
        _closed = false;
        context.container().classed('betterid-pen-direct', false);
        clearOverlay();
    }


    /**
     * The preview is drawn in screen space, so panning or zooming the map has to
     * re-project it: without this the path stayed glued to the viewport.
     */
    function redraw() {
        if (!_anchors.length && !_draft && !_direct) return;
        draw(_cursor || context.map().mouse());
    }


    function pointerdown(d3_event) {
        if (!active()) return;
        if (d3_event.button !== 0) return;

        var target = d3_event.target;
        if (!target || !target.closest || !target.closest('.main-map')) return;
        if (context.container().classed('betterid-hand-tool')) return;
        if (!context.map().withinEditableZoom()) return;
        if (d3_event.shiftKey) return;

        var point = mouseLoc(d3_event);
        var direct = d3_event.altKey || d3_event.ctrlKey || d3_event.metaKey;

        // Alt / Ctrl turn the pen into the direct selection tool for this gesture:
        // grab a direction handle to reshape one side only, or grab an anchor to
        // move it. (Ctrl is Photoshop's "temporarily use the direct selection
        // tool" while the pen is active.)
        if (direct) {
            var handle = findHandleNear(point);
            if (handle) {
                _direct = { anchor: handle.anchor, which: handle.which, moved: false, start: point };
            } else {
                var index = findAnchorNear(point);
                if (index === -1) return;
                _direct = {
                    anchor: _anchors[index],
                    index: index,
                    moved: false,
                    start: point,
                    trimOnClick: d3_event.altKey
                };
            }

            context.container().classed('betterid-pen-direct', true);
            d3_select(window)
                .on(prefix + 'move.betteridPen', pointermove)
                .on(prefix + 'up.betteridPen', pointerup);

            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }

        // click on the first anchor closes the path
        if (_anchors.length > 1) {
            var first = anchorScreen(_anchors[0]);
            if (Math.hypot(first[0] - point[0], first[1] - point[1]) <= CLOSE_RADIUS_PX) {
                _closed = true;
                finishPath();
                d3_event.preventDefault();
                d3_event.stopPropagation();
                return;
            }
        }

        _draft = {
            start: point,
            moved: false,
            anchor: { loc: context.projection.invert(point), handleIn: null, handleOut: null }
        };

        d3_select(window)
            .on(prefix + 'move.betteridPen', pointermove)
            .on(prefix + 'up.betteridPen', pointerup);

        draw(point);
        d3_event.preventDefault();
        d3_event.stopPropagation();
    }


    function findAnchorNear(point) {
        for (var i = 0; i < _anchors.length; i++) {
            var screen = anchorScreen(_anchors[i]);
            if (Math.hypot(screen[0] - point[0], screen[1] - point[1]) <= CLOSE_RADIUS_PX) return i;
        }
        return -1;
    }


    /** The direction handle under the pointer, if any. */
    function findHandleNear(point) {
        for (var i = 0; i < _anchors.length; i++) {
            var anchor = _anchors[i];
            var which = ['handleIn', 'handleOut'];
            for (var h = 0; h < which.length; h++) {
                var screen = handleScreen(anchor, which[h]);
                if (!screen) continue;
                if (Math.hypot(screen[0] - point[0], screen[1] - point[1]) <= CLOSE_RADIUS_PX) {
                    return { anchor: anchor, which: which[h] };
                }
            }
        }
        return null;
    }


    /**
     * Photoshop's convert-point click: an end anchor only loses its outgoing
     * handle (its incoming curve stays), a middle anchor becomes a corner.
     */
    function trimAnchor(index) {
        var anchor = _anchors[index];
        if (!anchor) return;
        if (index === _anchors.length - 1) {
            anchor.handleOut = null;
        } else {
            anchor.handleIn = null;
            anchor.handleOut = null;
        }
    }


    function pointermove(d3_event) {
        if (!_draft && !_direct) return;

        var point = mouseLoc(d3_event);

        if (_direct) {
            var from = _direct.start;
            if (Math.hypot(point[0] - from[0], point[1] - from[1]) > HANDLE_THRESHOLD_PX) {
                _direct.moved = true;
            }

            if (_direct.which) {
                // one side only: no mirrored handle while dragging a handle
                _direct.anchor[_direct.which] = screenToGeoOffset(_direct.anchor.loc, point);
            } else if (_direct.moved) {
                // handles are stored relative to the anchor, so moving the anchor
                // carries its curve along
                _direct.anchor.loc = context.projection.invert(point);
            }

            draw(point);
            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }

        var distance = Math.hypot(point[0] - _draft.start[0], point[1] - _draft.start[1]);
        if (distance > HANDLE_THRESHOLD_PX) {
            _draft.moved = true;
            var offset = screenToGeoOffset(_draft.anchor.loc, point);
            _draft.anchor.handleOut = offset;
            _draft.anchor.handleIn = [-offset[0], -offset[1]];
        }

        draw(point);
        d3_event.preventDefault();
        d3_event.stopPropagation();
    }


    function pointerup(d3_event) {
        if (!_draft && !_direct) return;

        d3_select(window)
            .on(prefix + 'move.betteridPen', null)
            .on(prefix + 'up.betteridPen', null);

        if (_direct) {
            // an Alt *click* (no drag) trims the anchor's forward handle
            if (_direct.trimOnClick && !_direct.moved && _direct.index !== undefined) {
                trimAnchor(_direct.index);
            }
            _direct = null;
            context.container().classed('betterid-pen-direct', false);
            draw(context.map().mouse());
            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }

        // dragging the last anchor also tweaks the incoming handle of the new
        // point, so the curve into it stays smooth
        _anchors.push(_draft.anchor);
        _draft = null;
        draw();

        d3_event.preventDefault();
        d3_event.stopPropagation();
    }


    function dblclick(d3_event) {
        if (!active() || (!_anchors.length && !_draft)) return;
        d3_event.preventDefault();
        d3_event.stopPropagation();
        finishPath();
    }


    function keydown(d3_event) {
        if (!active()) return;
        var isTextEntry = d3_event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(d3_event.target.tagName);
        if (isTextEntry) return;

        var undoKey = (d3_event.ctrlKey || d3_event.metaKey) &&
            !d3_event.altKey && (d3_event.key === 'z' || d3_event.key === 'Z');
        var redoKey = undoKey && d3_event.shiftKey;

        if (undoKey && !redoKey && (_anchors.length || _draft)) {
            // While a path is being drawn, Ctrl+Z is the pen's own undo: it drops
            // the last anchor (Photoshop does the same). With no path in progress
            // the event falls through to iD's normal undo.
            d3_event.preventDefault();
            d3_event.stopPropagation();
            if (_draft) {
                _draft = null;
            } else {
                _anchors.pop();
            }
            if (!_anchors.length && !_draft) {
                clearOverlay();
            } else {
                draw(_cursor || context.map().mouse());
            }
            return;
        }

        if (d3_event.key === 'Enter') {
            if (!_anchors.length && !_draft && !_direct) return;
            d3_event.preventDefault();
            d3_event.stopPropagation();
            finishPath();

        } else if (d3_event.key === 'Escape') {
            if (!_anchors.length && !_draft && !_direct) return;
            d3_event.preventDefault();
            d3_event.stopPropagation();
            cancelPath();

        } else if (d3_event.key === 'Backspace') {
            if (!_anchors.length && !_draft && !_direct) return;
            d3_event.preventDefault();
            d3_event.stopPropagation();
            if (_draft) {
                _draft = null;
            } else {
                _anchors.pop();
            }
            draw(context.map().mouse());
        }
    }


    function behavior() {
        d3_select(window)
            .on(prefix + 'down.betteridPen', pointerdown, true)
            .on('dblclick.betteridPen', dblclick, true)
            .on('keydown.betteridPen', keydown, true);

        // keep the preview projected onto the map while it moves or zooms
        context.map().on('drawn.betteridPen', redraw);
    }


    behavior.off = function() {
        d3_select(window)
            .on(prefix + 'down.betteridPen', null, true)
            .on('dblclick.betteridPen', null, true)
            .on('keydown.betteridPen', null, true)
            .on(prefix + 'move.betteridPen', null)
            .on(prefix + 'up.betteridPen', null);
        context.map().on('drawn.betteridPen', null);
        cancelPath();
    };


    return behavior;
}
