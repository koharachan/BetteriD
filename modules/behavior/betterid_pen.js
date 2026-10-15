import { select as d3_select } from 'd3-selection';

import { actionAddEntity } from '../actions/add_entity';
import { actionAddMidpoint } from '../actions/add_midpoint';
import {
    betteridTool, penSnapping, penRubberBand, penTolerance, BETTERID_TOOL_PREF
} from '../core/betterid_tools';
import { prefs } from '../core/preferences';
import { t } from '../core/localizer';
import { geoChooseEdge, geoSphericalDistance } from '../geo';
import { modeSelect } from '../modes/select';
import { osmNode, osmWay } from '../osm';
import { presetManager } from '../presets';
import { utilFastMouse } from '../util';
import {
    alignOpposite, bezierSplit, constrainAngle, flattenPath, nearestOnPath, pathTables,
    segmentControls, vecAdd, vecDistance, vecSub
} from '../util/betterid_path';


const DRAG_THRESHOLD_PX = 3;    // movement that turns a click into a drag
const HIT_RADIUS_PX = 7;        // anchors and handles
const SEGMENT_RADIUS_PX = 5;    // hovering the committed path (auto add)
const DBLCLICK_RADIUS_PX = 8;   // the second click of a double click
const MIN_NODE_SPACING_M = 0.3; // never place way nodes closer than this
const TOLERANCE_RANGE_M = [0.1, 1.0];

const HOVER_KINDS = ['close', 'add', 'delete', 'convert', 'handle', 'direct', 'connect-node', 'connect-way'];


/**
 * Pen tool, following Photoshop / Illustrator:
 *
 *   click            corner anchor          click + drag        smooth anchor
 *   Shift            constrain to 45°       Alt while dragging  break the handle (cusp)
 *   click 1st anchor close the path         drag 1st anchor     shape the join, then close
 *   click an anchor  delete it (auto-delete) click the path      insert an anchor (auto-add)
 *   click last anchor / Alt+click anchor    convert: drop the forward handle / make a corner
 *   Alt+drag corner  pull out new handles   Alt+drag handle     move that handle alone
 *   drag a handle    move it (the other side stays aligned)
 *   Ctrl (⌘)         direct selection: drag anchors; Ctrl+click empty space ends the path
 *   Enter / Esc / double click   finish     Backspace / Ctrl+Z  remove the last anchor
 *
 * On top of that the pen is a map editor: clicking an existing node reuses it
 * and clicking an existing way inserts the new node into that way (Alt
 * disables snapping, like iD's own drawing tools).
 *
 * The path is previewed in screen space on the map surface and flattened into
 * real OSM nodes only when it is finished (see `util/betterid_path.js`).
 */
export function behaviorBetteridPen(context) {
    const prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';

    let _anchors = [];          // { loc, handleIn, handleOut, smooth, nodeID, edge }
    let _gesture = null;        // the pointer gesture in progress
    let _hover = null;          // { kind, index?, which?, hit? }
    let _cursor = null;         // last pointer position (screen)
    let _lastTapTime = 0;

    let _overlay = d3_select(null);
    let _layers = {};
    let _flatCache = { key: null, value: null };
    let _hitCache = { key: null, tables: null, anchors: null };
    const _segmentCache = new Map();   // flattened segments, see flattenPath()


    /* ----------------------------------------------------------- helpers -- */

    function active() {
        return betteridTool() === 'pen';
    }

    function container() {
        return context.container();
    }

    function mapNode() {
        return container().select('.main-map').node();
    }

    function mouseLoc(d3_event) {
        const node = mapNode();
        if (!node) return [0, 0];
        return utilFastMouse(node)(d3_event);
    }

    function overMap(d3_event) {
        const target = d3_event.target;
        return Boolean(target && target.closest && target.closest('.main-map'));
    }

    function isTextEntry(d3_event) {
        const target = d3_event.target;
        return Boolean(target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    }

    function screen(loc) {
        return context.projection(loc);
    }

    function geo(point) {
        return context.projection.invert(point);
    }

    /** A handle stored as a geo offset, as an absolute screen point. */
    function handlePoint(anchor, which) {
        const offset = anchor[which];
        if (!offset) return null;
        return screen([anchor.loc[0] + offset[0], anchor.loc[1] + offset[1]]);
    }

    /** Screen point -> geo offset from the anchor. */
    function handleOffset(anchor, point) {
        const loc = geo(point);
        return [loc[0] - anchor.loc[0], loc[1] - anchor.loc[1]];
    }

    function metersPerPixel() {
        const center = context.map().center();
        const p = screen(center);
        return geoSphericalDistance(center, geo([p[0] + 1, p[1]])) || 1;
    }

    /** Flattening options for the current view (tolerance clamped in metres). */
    function flattenOptions() {
        const mpp = metersPerPixel();
        const wantedM = penTolerance() * mpp;
        const toleranceM = Math.max(TOLERANCE_RANGE_M[0], Math.min(TOLERANCE_RANGE_M[1], wantedM));
        return {
            tolerance: toleranceM / mpp,
            minSpacing: MIN_NODE_SPACING_M / mpp,
            maxNodes: 96,
            cache: _segmentCache
        };
    }

    /**
     * Flattening the whole path on every pointer move is wasteful while only
     * the hover changes, so the result is kept until an anchor or the view
     * changes.
     */
    function flattenCached(anchors, closing, options) {
        const transform = context.projection.transform();
        const key = [transform.k, transform.x, transform.y, closing, options.tolerance.toFixed(4)]
            .concat(anchors.map(a => [a.loc, a.handleIn, a.handleOut].join(',')))
            .join(';');
        if (_flatCache.key !== key) {
            _flatCache = { key, value: flattenPath(screenAnchors(anchors), closing, options) };
        }
        return _flatCache.value;
    }

    /** Anchors in screen space, as `util/betterid_path.js` wants them. */
    function screenAnchors(list) {
        return list.map(anchor => ({
            p: screen(anchor.loc),
            handleIn: handlePoint(anchor, 'handleIn'),
            handleOut: handlePoint(anchor, 'handleOut'),
            source: anchor
        }));
    }

    /** The anchors the finished way will be built from (including a pending drag). */
    function committedAnchors() {
        if (_gesture && _gesture.kind === 'place') return _anchors.concat([_gesture.anchor]);
        return _anchors;
    }

    function hasPath() {
        return _anchors.length > 0 || Boolean(_gesture);
    }


    /* ---------------------------------------------------------- snapping -- */

    /**
     * The OSM feature under the pointer that the pen may connect to, following
     * `behaviorDraw.datum()`: only rendered touch targets count, and Alt turns
     * snapping off.
     */
    function snapTarget(d3_event, point) {
        if (!penSnapping() || d3_event.altKey) return null;
        const element = d3_event.target;
        const d = element && element.__data__;
        if (!d || !d.properties || !d.properties.target || d.properties.nope) return null;

        const entity = d.properties.entity;
        if (!entity) return null;
        const graph = context.graph();

        if (entity.type === 'node') {
            if (!graph.hasEntity(entity.id)) return null;
            const allows = entity.geometry(graph) === 'vertex' || presetManager.allowsVertex(entity, graph);
            if (!allows) return null;
            return { kind: 'node', nodeID: entity.id, loc: entity.loc };
        }

        if (entity.type === 'way' && graph.hasEntity(entity.id)) {
            const choice = geoChooseEdge(graph.childNodes(entity), point, context.projection);
            if (!choice) return null;
            return {
                kind: 'way',
                loc: choice.loc,
                edge: [entity.nodes[choice.index - 1], entity.nodes[choice.index]]
            };
        }
        return null;
    }


    /* ------------------------------------------------------- hit testing -- */

    function anchorIndexAt(point) {
        for (let i = _anchors.length - 1; i >= 0; i--) {
            if (vecDistance(screen(_anchors[i].loc), point) <= HIT_RADIUS_PX) return i;
        }
        return -1;
    }

    /** Indices whose handles are drawn (and therefore grabbable). */
    function visibleHandleIndices() {
        const shown = new Set();
        if (_anchors.length) shown.add(_anchors.length - 1);
        if (_anchors.length > 1) shown.add(_anchors.length - 2);
        if (_gesture && _gesture.index !== undefined) shown.add(_gesture.index);
        if (_hover && _hover.index !== undefined) shown.add(_hover.index);
        return shown;
    }

    function handleAt(point) {
        const indices = Array.from(visibleHandleIndices()).sort((a, b) => b - a);
        for (const i of indices) {
            const anchor = _anchors[i];
            if (!anchor) continue;
            for (const which of ['handleOut', 'handleIn']) {
                const p = handlePoint(anchor, which);
                if (p && vecDistance(p, point) <= HIT_RADIUS_PX) return { index: i, which };
            }
        }
        return null;
    }

    /** Path hit testing; the sampled segments survive between pointer moves. */
    function segmentAt(point) {
        if (_anchors.length < 2) return null;
        const transform = context.projection.transform();
        const key = [transform.k, transform.x, transform.y]
            .concat(_anchors.map(a => [a.loc, a.handleIn, a.handleOut].join(',')))
            .join(';');
        if (_hitCache.key !== key) {
            const anchors = screenAnchors(_anchors);
            _hitCache = { key, anchors, tables: pathTables(anchors, false) };
        }
        return nearestOnPath(_hitCache.anchors, false, point, SEGMENT_RADIUS_PX, _hitCache.tables);
    }


    /* ----------------------------------------------------------- hover ---- */

    function setHover(hover) {
        const before = _hover && _hover.kind;
        const after = hover && hover.kind;
        _hover = hover;
        if (before !== after) {
            HOVER_KINDS.forEach(kind => container().classed('betterid-pen-hover-' + kind, kind === after));
        }
    }

    /** What a press at `point` would do, for the cursor and the highlight. */
    function hoverAt(d3_event, point) {
        const direct = d3_event.ctrlKey || d3_event.metaKey;
        const handle = handleAt(point);
        if (handle) return { kind: d3_event.altKey ? 'convert' : 'handle', index: handle.index, which: handle.which };

        const index = anchorIndexAt(point);
        if (index !== -1) {
            if (direct) return { kind: 'direct', index };
            if (d3_event.altKey) return { kind: 'convert', index };
            if (index === 0 && _anchors.length > 1) return { kind: 'close', index };
            if (index === _anchors.length - 1) return { kind: 'convert', index };
            return { kind: 'delete', index };
        }

        if (direct) return null;

        const target = snapTarget(d3_event, point);
        if (target) return { kind: target.kind === 'node' ? 'connect-node' : 'connect-way', target };

        const onSegment = segmentAt(point);
        if (onSegment) return { kind: 'add', hit: onSegment };

        return null;
    }


    /* --------------------------------------------------------- rendering -- */

    function ensureOverlay() {
        if (!_overlay.empty() && document.contains(_overlay.node())) return;

        _overlay = context.surface()
            .selectAll('.betterid-pen-preview')
            .data([0]);
        _overlay = _overlay.enter()
            .append('g')
            .attr('class', 'betterid-pen-preview')
            .merge(_overlay);
        _overlay.selectAll('*').remove();

        _layers = {
            halo: _overlay.append('path').attr('class', 'betterid-pen-halo'),
            path: _overlay.append('path').attr('class', 'betterid-pen-path'),
            rubber: _overlay.append('path').attr('class', 'betterid-pen-rubber'),
            nodes: _overlay.append('g').attr('class', 'betterid-pen-nodes'),
            handles: _overlay.append('g').attr('class', 'betterid-pen-handles'),
            anchors: _overlay.append('g').attr('class', 'betterid-pen-anchors'),
            hover: _overlay.append('g').attr('class', 'betterid-pen-hover')
        };
    }

    function clearOverlay() {
        if (_overlay.empty()) return;
        _overlay.classed('hide', true);
        Object.values(_layers).forEach(layer => {
            if (layer.node() && layer.node().tagName === 'path') layer.attr('d', null);
            else layer.selectAll('*').remove();
        });
    }

    function pathD(points, close) {
        if (!points || points.length < 2) return null;
        return 'M' + points.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + (close ? 'Z' : '');
    }

    function draw(cursorScreen) {
        ensureOverlay();
        _overlay.classed('hide', false);
        if (cursorScreen) _cursor = cursorScreen;

        const anchors = committedAnchors();
        const closing = Boolean(_gesture && _gesture.kind === 'close');
        const options = flattenOptions();
        const flattened = flattenCached(anchors, closing, options);
        const points = flattened.map(item => item.p);

        // committed geometry: exactly what finishing the path will create
        const d = pathD(points, closing);
        _layers.halo.attr('d', d);
        _layers.path.attr('d', d);

        // where the way nodes will land (the point optimisation, made visible)
        const nodeDots = _layers.nodes.selectAll('circle').data(flattened.filter(item => !item.anchor));
        nodeDots.exit().remove();
        nodeDots.enter().append('circle')
            .attr('class', 'betterid-pen-node')
            .attr('r', 1.5)
            .merge(nodeDots)
            .attr('cx', item => item.p[0])
            .attr('cy', item => item.p[1]);

        // rubber band: the segment that still follows the pointer
        let rubber = null;
        const showRubber = penRubberBand() && !closing && _cursor && anchors.length &&
            (!_gesture || _gesture.kind === 'place');
        if (showRubber) {
            const last = screenAnchors([anchors[anchors.length - 1]])[0];
            const tail = { p: _cursor, handleIn: null, handleOut: null };
            rubber = pathD(flattenPath([last, tail], false, options).map(item => item.p), false);
        }
        _layers.rubber.attr('d', rubber);

        drawHandles(anchors);
        drawAnchors(anchors);
        drawHover();
    }

    function drawHandles(anchors) {
        const shown = visibleHandleIndices();
        if (_gesture && _gesture.kind === 'place') shown.add(anchors.length - 1);

        const lines = [];
        anchors.forEach((anchor, i) => {
            if (!shown.has(i)) return;
            const center = screen(anchor.loc);
            ['handleIn', 'handleOut'].forEach(which => {
                const p = handlePoint(anchor, which);
                if (p) lines.push({ center, p, key: i + which });
            });
        });

        const handleLines = _layers.handles.selectAll('line').data(lines, d => d.key);
        handleLines.exit().remove();
        handleLines.enter().append('line')
            .attr('class', 'betterid-pen-handle')
            .merge(handleLines)
            .attr('x1', d => d.center[0]).attr('y1', d => d.center[1])
            .attr('x2', d => d.p[0]).attr('y2', d => d.p[1]);

        const handleEnds = _layers.handles.selectAll('circle').data(lines, d => d.key);
        handleEnds.exit().remove();
        handleEnds.enter().append('circle')
            .attr('class', 'betterid-pen-handle-end')
            .attr('r', 3.5)
            .merge(handleEnds)
            .attr('cx', d => d.p[0])
            .attr('cy', d => d.p[1]);
    }

    function drawAnchors(anchors) {
        const current = anchors.length - 1;
        const items = anchors.map((anchor, i) => ({ anchor, i }));

        // existing OSM nodes show as circles (like the map's vertices), new
        // anchors as Photoshop's squares; the current anchor is filled
        const marks = _layers.anchors.selectAll('.betterid-pen-anchor').data(items, d => d.i);
        marks.exit().remove();
        const entered = marks.enter().append('g').attr('class', 'betterid-pen-anchor');
        entered.append('rect').attr('x', -3.5).attr('y', -3.5).attr('width', 7).attr('height', 7);
        entered.append('circle').attr('r', 4);

        const merged = entered.merge(marks)
            .classed('current', d => d.i === current)
            .classed('bound', d => Boolean(d.anchor.nodeID || d.anchor.edge))
            .classed('corner', d => !d.anchor.handleIn && !d.anchor.handleOut)
            .attr('transform', d => {
                const p = screen(d.anchor.loc);
                return 'translate(' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ')';
            });
        merged.select('rect').attr('display', d => d.anchor.nodeID ? 'none' : null);
        merged.select('circle').attr('display', d => d.anchor.nodeID ? null : 'none');
    }

    function drawHover() {
        _layers.hover.selectAll('*').remove();
        if (!_hover || _gesture) return;

        let p = null;
        if (_hover.kind === 'add') p = _hover.hit.p;
        else if (_hover.target) p = screen(_hover.target.loc);
        else if (_hover.which !== undefined) p = handlePoint(_anchors[_hover.index], _hover.which);
        else if (_hover.index !== undefined && _anchors[_hover.index]) p = screen(_anchors[_hover.index].loc);
        if (!p) return;

        _layers.hover.append('circle')
            .attr('class', 'betterid-pen-hover-ring ' + _hover.kind)
            .attr('cx', p[0]).attr('cy', p[1])
            .attr('r', _hover.kind === 'add' ? 4.5 : 8);
    }

    /** Pan / zoom re-projects the screen-space preview. */
    function redraw() {
        if (!hasPath()) return;
        draw();
    }


    /* ----------------------------------------------------------- editing -- */

    function newAnchor(point, target) {
        return {
            loc: target ? target.loc.slice() : geo(point),
            handleIn: null,
            handleOut: null,
            smooth: false,
            nodeID: target && target.kind === 'node' ? target.nodeID : null,
            edge: target && target.kind === 'way' ? target.edge : null
        };
    }

    /** Pull symmetric handles out of an anchor towards `point`. */
    function pullHandles(anchor, point, d3_event) {
        let p = point;
        if (d3_event.shiftKey) p = constrainAngle(screen(anchor.loc), point, 45);
        const out = handleOffset(anchor, p);
        anchor.handleOut = out;
        if (!d3_event.altKey) {
            // Alt freezes the incoming side (Photoshop's cusp while placing)
            anchor.handleIn = [-out[0], -out[1]];
            anchor.smooth = true;
        } else {
            anchor.smooth = false;
        }
    }

    /** Move one handle of an anchor; a smooth anchor keeps the other aligned. */
    function moveHandle(anchor, which, point, d3_event) {
        let p = point;
        if (d3_event.shiftKey) p = constrainAngle(screen(anchor.loc), point, 45);
        const offset = handleOffset(anchor, p);
        anchor[which] = offset;

        const other = which === 'handleIn' ? 'handleOut' : 'handleIn';
        if (d3_event.altKey) {
            anchor.smooth = false;             // Alt breaks the pair (convert point)
        } else if (anchor.smooth && anchor[other]) {
            // keep it collinear, but let each side keep its own length (Illustrator)
            const otherPoint = handlePoint(anchor, other);
            const center = screen(anchor.loc);
            const aligned = alignOpposite(vecSub(otherPoint, center), vecSub(p, center));
            anchor[other] = handleOffset(anchor, vecAdd(center, aligned));
        }
    }

    /**
     * Convert point (Alt+click / click on the last anchor): the current
     * anchor only loses its forward handle so the next segment starts straight
     * and the curve into it stays; any other anchor becomes a corner.
     */
    function convertAnchor(index) {
        const anchor = _anchors[index];
        if (!anchor) return;
        if (index === _anchors.length - 1) {
            anchor.handleOut = null;
        } else {
            anchor.handleIn = null;
            anchor.handleOut = null;
        }
        anchor.smooth = false;
    }

    function deleteAnchor(index) {
        _anchors.splice(index, 1);
    }

    /** Auto-add: insert an anchor on the path without changing its shape. */
    function insertAnchor(hit) {
        const a = _anchors[hit.segment];
        const b = _anchors[hit.segment + 1];
        if (!a || !b) return -1;

        const [sa, sb] = screenAnchors([a, b]);
        const split = bezierSplit(...segmentControls(sa, sb), hit.t);
        const mid = split.left[3];
        const anchor = {
            loc: geo(mid),
            handleIn: null,
            handleOut: null,
            smooth: true,
            nodeID: null,
            edge: null
        };
        const wasStraight = !a.handleOut && !b.handleIn;
        if (!wasStraight) {
            anchor.handleIn = handleOffset(anchor, split.left[2]);
            anchor.handleOut = handleOffset(anchor, split.right[1]);
            // the neighbours' handles shrink to the split pieces
            a.handleOut = a.handleOut ? handleOffset(a, split.left[1]) : null;
            b.handleIn = b.handleIn ? handleOffset(b, split.right[2]) : null;
        } else {
            anchor.smooth = false;
        }

        _anchors.splice(hit.segment + 1, 0, anchor);
        return hit.segment + 1;
    }


    /* ------------------------------------------------------------ finish -- */

    function resetPath() {
        _anchors = [];
        _gesture = null;
        _cursor = null;
        setHover(null);
        container().classed('betterid-pen-dragging', false);
        clearOverlay();
    }

    /**
     * Turn the path into OSM data: a node per flattened point (reusing the
     * node an anchor was snapped to, inserting into the way it was snapped on)
     * and one way through them; a closed path becomes an area.
     */
    function finishPath(close) {
        // Enter or a double click can arrive mid-drag: commit the pending anchor
        if (_gesture && _gesture.kind === 'place') {
            _anchors.push(_gesture.anchor);
        }
        stopGestureListeners();

        const anchors = _anchors.slice();
        let closed = Boolean(close);
        resetPath();

        if (anchors.length < 2) return;

        const graph = context.graph();
        const flattened = flattenPath(screenAnchors(anchors), closed, flattenOptions());

        const actions = [];
        const nodeIDs = [];
        const seenNodes = new Set();

        flattened.forEach(item => {
            const anchor = item.anchor && item.anchor.source;
            let id;

            if (anchor && anchor.nodeID && graph.hasEntity(anchor.nodeID)) {
                id = anchor.nodeID;
            } else {
                const node = new osmNode({ loc: anchor ? anchor.loc : geo(item.p) });
                actions.push(actionAddEntity(node));
                const edge = anchor && anchor.edge;
                if (edge && graph.hasEntity(edge[0]) && graph.hasEntity(edge[1])) {
                    actions.push(actionAddMidpoint({ loc: node.loc, edge }, node));
                }
                id = node.id;
            }

            if (nodeIDs[nodeIDs.length - 1] === id) return;   // two anchors on one node
            if (seenNodes.has(id) && id !== nodeIDs[0]) return; // avoid loops through a reused node
            seenNodes.add(id);
            nodeIDs.push(id);
        });

        // a path that starts and ends on the same existing node is closed
        if (nodeIDs.length > 2 && nodeIDs[0] === nodeIDs[nodeIDs.length - 1]) {
            nodeIDs.pop();
            closed = true;
        }
        if (nodeIDs.length < 2) return;
        if (closed && nodeIDs.length < 3) closed = false;   // a 2-node ring is degenerate

        const wayNodes = closed ? nodeIDs.concat([nodeIDs[0]]) : nodeIDs;
        const way = new osmWay({ nodes: wayNodes, tags: closed ? { area: 'yes' } : {} });
        actions.push(actionAddEntity(way));

        const annotation = t('operations.start.annotation.' + (closed ? 'area' : 'line'));
        context.perform(...actions, annotation);

        if (context.hasEntity(way.id)) {
            context.enter(modeSelect(context, [way.id]).newFeature(true));
        }
    }

    function removeLastAnchor() {
        if (_gesture) {
            stopGestureListeners();
            _gesture = null;
            container().classed('betterid-pen-dragging', false);
        } else {
            _anchors.pop();
        }
        if (!_anchors.length) {
            resetPath();
        } else {
            draw(_cursor || context.map().mouse());
        }
    }


    /* ------------------------------------------------------- pointer input -- */

    function startGesture(gesture, d3_event) {
        _gesture = gesture;
        setHover(null);
        container().classed('betterid-pen-dragging', true);
        d3_select(window)
            .on(prefix + 'move.betteridPenDrag', pointermove)
            .on(prefix + 'up.betteridPenDrag', pointerup)
            .on('pointercancel.betteridPenDrag', pointerup);
        d3_event.preventDefault();
        d3_event.stopPropagation();
    }

    function stopGestureListeners() {
        d3_select(window)
            .on(prefix + 'move.betteridPenDrag', null)
            .on(prefix + 'up.betteridPenDrag', null)
            .on('pointercancel.betteridPenDrag', null);
    }

    function pointerdown(d3_event) {
        if (!active() || _gesture) return;
        if (d3_event.button !== 0 || !overMap(d3_event)) return;
        if (container().classed('betterid-hand-tool')) return;
        if (!context.map().withinEditableZoom()) return;

        const point = mouseLoc(d3_event);
        const direct = d3_event.ctrlKey || d3_event.metaKey;

        // a grabbed direction handle, with or without the direct selection key
        const handle = handleAt(point);
        if (handle) {
            startGesture({ kind: 'handle', index: handle.index, which: handle.which, start: point, moved: false }, d3_event);
            draw(point);
            return;
        }

        const index = anchorIndexAt(point);

        if (direct) {
            // Ctrl: direct selection - drag an anchor, or click away to end
            if (index === -1) {
                if (_anchors.length) {
                    d3_event.preventDefault();
                    d3_event.stopPropagation();
                    finishPath(false);
                }
                return;
            }
            startGesture({ kind: 'anchor', index, start: point, moved: false }, d3_event);
            return;
        }

        if (index !== -1) {
            const isFirst = index === 0 && _anchors.length > 1;
            const isLast = index === _anchors.length - 1;

            if (d3_event.altKey || isLast) {
                // convert point: click drops the handle(s); dragging a corner pulls new ones
                startGesture({ kind: 'convert', index, start: point, moved: false }, d3_event);
                return;
            }
            if (isFirst) {
                // click closes; dragging shapes the join first
                startGesture({ kind: 'close', index: 0, start: point, moved: false }, d3_event);
                draw(point);
                return;
            }
            // auto-delete
            deleteAnchor(index);
            d3_event.preventDefault();
            d3_event.stopPropagation();
            draw(point);
            return;
        }

        const target = snapTarget(d3_event, point);
        if (!target) {
            const onSegment = segmentAt(point);
            if (onSegment) {
                // auto-add: the new anchor can be dragged straight away
                const inserted = insertAnchor(onSegment);
                if (inserted !== -1) {
                    startGesture({ kind: 'anchor', index: inserted, start: point, moved: false }, d3_event);
                    draw(point);
                }
                return;
            }
        }

        // a second click right on the previous anchor is a double click, not
        // a new anchor on top of the old one
        const now = Date.now();
        const last = _anchors[_anchors.length - 1];
        if (last && now - _lastTapTime < 400 && vecDistance(screen(last.loc), point) <= DBLCLICK_RADIUS_PX) {
            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }
        _lastTapTime = now;

        let anchorPoint = point;
        if (d3_event.shiftKey && last && !target) {
            // Shift constrains the new anchor to 45° steps from the last one
            anchorPoint = constrainAngle(screen(last.loc), point, 45);
        }

        startGesture({
            kind: 'place',
            anchor: newAnchor(anchorPoint, target),
            start: point,
            moved: false
        }, d3_event);
        draw(point);
    }

    function pointermove(d3_event) {
        if (!_gesture) return;
        const point = mouseLoc(d3_event);
        const gesture = _gesture;
        if (!gesture.moved && vecDistance(point, gesture.start) > DRAG_THRESHOLD_PX) {
            gesture.moved = true;
        }

        if (gesture.kind === 'place') {
            if (gesture.moved) pullHandles(gesture.anchor, point, d3_event);

        } else if (gesture.kind === 'handle') {
            const anchor = _anchors[gesture.index];
            if (anchor && gesture.moved) moveHandle(anchor, gesture.which, point, d3_event);

        } else if (gesture.kind === 'anchor') {
            const anchor = _anchors[gesture.index];
            if (anchor && gesture.moved) {
                // handles are stored relative to the anchor, so the curve comes along;
                // a moved anchor is a new node, not the one it was snapped to
                anchor.loc = geo(point);
                anchor.nodeID = null;
                anchor.edge = null;
            }

        } else if (gesture.kind === 'convert') {
            const anchor = _anchors[gesture.index];
            if (anchor && gesture.moved) {
                // dragging out of a corner (or the current anchor) pulls new handles
                pullHandles(anchor, point, { shiftKey: d3_event.shiftKey, altKey: false });
            }

        } else if (gesture.kind === 'close') {
            const anchor = _anchors[0];
            if (anchor && gesture.moved) {
                // the drag is the direction of travel through the closing
                // anchor: on towards the second anchor
                pullHandles(anchor, point, { shiftKey: d3_event.shiftKey, altKey: false });
            }
        }

        draw(point);
        d3_event.preventDefault();
        d3_event.stopPropagation();
    }

    function pointerup(d3_event) {
        if (!_gesture) return;
        stopGestureListeners();
        container().classed('betterid-pen-dragging', false);

        const gesture = _gesture;
        _gesture = null;
        d3_event.preventDefault();
        d3_event.stopPropagation();

        if (gesture.kind === 'place') {
            _anchors.push(gesture.anchor);

        } else if (gesture.kind === 'convert' && !gesture.moved) {
            convertAnchor(gesture.index);

        } else if (gesture.kind === 'close') {
            finishPath(true);
            return;
        }

        draw(_cursor);
    }

    /** Hover tracking while no gesture is running (cheap, no preventDefault). */
    function hovermove(d3_event) {
        if (!active() || _gesture) return;
        if (!overMap(d3_event)) {
            if (_hover) { setHover(null); drawHover(); }
            return;
        }
        const point = mouseLoc(d3_event);
        _cursor = point;
        if (!_anchors.length) {
            // nothing drawn yet: only the snapping cue matters
            const target = snapTarget(d3_event, point);
            setHover(target ? { kind: target.kind === 'node' ? 'connect-node' : 'connect-way', target } : null);
            return;
        }
        setHover(hoverAt(d3_event, point));
        draw(point);
    }

    /** Modifier keys change what a press would do; refresh the cursor. */
    function modifierChange(d3_event) {
        if (!active() || _gesture || !_cursor || !_anchors.length) return;
        if (!/^(Alt|Control|Meta|Shift)$/.test(d3_event.key || '')) return;
        setHover(hoverAt(d3_event, _cursor));
        drawHover();
    }

    function dblclick(d3_event) {
        if (!active() || !hasPath() || !overMap(d3_event)) return;
        d3_event.preventDefault();
        d3_event.stopPropagation();
        finishPath(false);
    }

    function keydown(d3_event) {
        if (!active() || isTextEntry(d3_event)) return;
        modifierChange(d3_event);

        const command = (d3_event.ctrlKey || d3_event.metaKey) && !d3_event.altKey;
        const key = d3_event.key || '';

        if (command && (key === 'z' || key === 'Z') && !d3_event.shiftKey && hasPath()) {
            // Ctrl+Z while drawing is the pen's own undo: it drops the last
            // anchor (Photoshop does the same). With no path it is iD's undo.
            d3_event.preventDefault();
            d3_event.stopPropagation();
            removeLastAnchor();
            return;
        }

        if (!hasPath()) return;

        if (key === 'Enter' || key === 'Escape') {
            // Photoshop, Illustrator and iD all end the path here and keep it
            d3_event.preventDefault();
            d3_event.stopPropagation();
            finishPath(false);

        } else if (key === 'Backspace' || key === 'Delete') {
            d3_event.preventDefault();
            d3_event.stopPropagation();
            removeLastAnchor();
        }
    }

    function keyup(d3_event) {
        modifierChange(d3_event);
    }

    function toolChanged() {
        const isPen = active();
        container().classed('betterid-pen-tool', isPen);
        if (!isPen) {
            // switching tools keeps the drawing, like Photoshop keeps the path
            if (_anchors.length + (_gesture && _gesture.kind === 'place' ? 1 : 0) >= 2) {
                finishPath(false);
            } else {
                stopGestureListeners();
                resetPath();
            }
        }
    }


    function behavior() {
        d3_select(window)
            .on(prefix + 'down.betteridPen', pointerdown, true)
            .on(prefix + 'move.betteridPenHover', hovermove)
            .on('dblclick.betteridPen', dblclick, true)
            .on('keydown.betteridPen', keydown, true)
            .on('keyup.betteridPen', keyup, true);

        context.map().on('drawn.betteridPen', redraw);
        prefs.onChange(BETTERID_TOOL_PREF, toolChanged);
        toolChanged();
    }


    behavior.off = function() {
        d3_select(window)
            .on(prefix + 'down.betteridPen', null, true)
            .on(prefix + 'move.betteridPenHover', null)
            .on('dblclick.betteridPen', null, true)
            .on('keydown.betteridPen', null, true)
            .on('keyup.betteridPen', null, true);
        stopGestureListeners();
        context.map().on('drawn.betteridPen', null);
        prefs.offChange(BETTERID_TOOL_PREF, toolChanged);
        container().classed('betterid-pen-tool', false);
        resetPath();
        if (!_overlay.empty()) _overlay.remove();
        _overlay = d3_select(null);
        _layers = {};
    };


    // exposed for tests
    behavior.anchors = () => _anchors.map(anchor => ({ ...anchor }));
    behavior.finish = finishPath;

    return behavior;
}
