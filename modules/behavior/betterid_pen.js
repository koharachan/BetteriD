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
    var _closed = false;
    var _overlay = d3_select(null);
    var _preview = d3_select(null);
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
        _points = _overlay.append('g').attr('class', 'betterid-pen-points');
    }


    function clearOverlay() {
        if (_overlay.empty()) return;
        _overlay.classed('hide', true);
        _preview.attr('d', null);
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


    function curvePoints(anchors, closed, cursorScreen) {
        var list = anchors.slice();
        if (!closed && cursorScreen) {
            list = list.concat([{ loc: context.projection.invert(cursorScreen) }]);
        }
        if (list.length < 2) return list.map(anchorScreen);

        var segments = list.length - 1;
        var sampled = [anchorScreen(list[0])];

        for (var i = 0; i < segments; i++) {
            var a = list[i];
            var b = list[i + 1];
            var p0 = anchorScreen(a);
            var p3 = anchorScreen(b);
            var c1 = handleScreen(a, 'handleOut') || p0;
            var c2 = handleScreen(b, 'handleIn') || p3;

            var chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
            var steps = Math.max(1, Math.round(chord / NODE_SPACING_PX));

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


    function draw(cursorScreen) {
        ensureOverlay();
        _overlay.classed('hide', false);

        // the anchor being dragged is not committed yet, but its handle should
        // be visible while the pointer moves
        var visible = _anchors.slice();
        if (_draft && _draft.moved) visible.push(_draft.anchor);

        var sampled = curvePoints(_anchors, _closed || !cursorScreen, _closed ? null : cursorScreen);
        if (sampled.length) {
            _preview.attr('d', 'M' + sampled.map(p => `${p[0]},${p[1]}`).join(' L') + (_closed ? ' Z' : ''));
        } else {
            _preview.attr('d', null);
        }

        // anchors and their direction handles
        var points = _points.selectAll('circle').data(visible, (d, i) => i);
        points.exit().remove();
        points.enter().append('circle')
            .attr('class', 'betterid-pen-point')
            .attr('r', 4)
            .merge(points)
            .attr('cx', d => anchorScreen(d)[0])
            .attr('cy', d => anchorScreen(d)[1]);

        var handleLines = [];
        visible.forEach(anchor => {
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
        var anchors = _anchors.slice();
        var closed = _closed;
        _anchors = [];
        _draft = null;
        _closed = false;
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

        var way = new osmWay({ nodes: nodes.map(node => node.id), tags: {} });

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
        _closed = false;
        clearOverlay();
    }


    function pointerdown(d3_event) {
        if (!active()) return;
        if (d3_event.button !== 0) return;

        var target = d3_event.target;
        if (!target || !target.closest || !target.closest('.main-map')) return;
        if (context.container().classed('betterid-hand-tool')) return;
        if (!context.map().withinEditableZoom()) return;
        if (d3_event.ctrlKey || d3_event.metaKey || d3_event.shiftKey) return;

        var point = mouseLoc(d3_event);

        // Alt+click on an existing anchor breaks its handles (Photoshop's
        // convert-point behaviour)
        if (d3_event.altKey) {
            var existing = findAnchorNear(point);
            if (existing !== -1) {
                _anchors[existing].handleIn = null;
                _anchors[existing].handleOut = null;
                draw(point);
                d3_event.preventDefault();
                d3_event.stopPropagation();
                return;
            }
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


    function pointermove(d3_event) {
        if (!_draft) return;

        var point = mouseLoc(d3_event);
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
        if (!_draft) return;

        d3_select(window)
            .on(prefix + 'move.betteridPen', null)
            .on(prefix + 'up.betteridPen', null);

        // dragging the last anchor also tweaks the incoming handle of the new
        // point, so the curve into it stays smooth
        _anchors.push(_draft.anchor);
        _draft = null;
        draw();

        d3_event.preventDefault();
        d3_event.stopPropagation();
    }


    function dblclick(d3_event) {
        if (!active() || !_anchors.length) return;
        d3_event.preventDefault();
        d3_event.stopPropagation();
        finishPath();
    }


    function keydown(d3_event) {
        if (!active()) return;
        var isTextEntry = d3_event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(d3_event.target.tagName);
        if (isTextEntry) return;

        if (d3_event.key === 'Enter') {
            if (!_anchors.length) return;
            d3_event.preventDefault();
            d3_event.stopPropagation();
            finishPath();

        } else if (d3_event.key === 'Escape') {
            if (!_anchors.length) return;
            d3_event.preventDefault();
            d3_event.stopPropagation();
            cancelPath();

        } else if (d3_event.key === 'Backspace') {
            if (!_anchors.length) return;
            d3_event.preventDefault();
            d3_event.stopPropagation();
            _anchors.pop();
            draw(context.map().mouse());
        }
    }


    function behavior() {
        d3_select(window)
            .on(prefix + 'down.betteridPen', pointerdown, true)
            .on('dblclick.betteridPen', dblclick, true)
            .on('keydown.betteridPen', keydown, true);
    }


    behavior.off = function() {
        d3_select(window)
            .on(prefix + 'down.betteridPen', null, true)
            .on('dblclick.betteridPen', null, true)
            .on('keydown.betteridPen', null, true)
            .on(prefix + 'move.betteridPen', null)
            .on(prefix + 'up.betteridPen', null);
        cancelPath();
    };


    return behavior;
}
