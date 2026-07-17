import { throttle, isArray, clamp } from 'es-toolkit/compat';

import { dispatch as d3_dispatch } from 'd3-dispatch';
import { interpolate as d3_interpolate } from 'd3-interpolate';
import { scaleLinear as d3_scaleLinear } from 'd3-scale';
import { select as d3_select } from 'd3-selection';
import { zoom as d3_zoom, zoomIdentity as d3_zoomIdentity } from 'd3-zoom';

import { prefs } from '../core/preferences';
import {
    BETTERID_PREFS, betteridBool, experimentalFeatureEnabled, getSnapTolerance
} from '../core/betterid_preferences';
import { geoExtent, geoPointInPolygon, geoRawMercator, geoScaleToZoom, geoZoomToScale } from '../geo';
import { modeBrowse } from '../modes/browse';
import { svgAreas, svgLabels, svgLayers, svgLines, svgMidpoints, svgPoints, svgVertices } from '../svg';
import { utilFastMouse, utilFunctor, utilSetTransform, utilEntityAndDeepMemberIDs } from '../util/util';
import { utilBindOnce } from '../util/bind_once';
import { utilDetect } from '../util/detect';
import { utilGetDimensions } from '../util/dimensions';
import { utilRebind } from '../util/rebind';
import { utilZoomPan } from '../util/zoom_pan';
import { utilDoubleUp } from '../util/double_up';

// constants
var TILESIZE = 256;
var minZoom = 2;
var maxZoom = 24;
var kMin = geoZoomToScale(minZoom, TILESIZE);
var kMax = geoZoomToScale(maxZoom, TILESIZE);
const NAVIGATION_KEYS = new Set(['w', 'a', 's', 'd']);
const W_TAP_MAX_MS = 220;
const NAVIGATION_SPEED_MULTIPLIER = 1.6;
const WALK_SPEED = 320 * NAVIGATION_SPEED_MULTIPLIER;
const FLY_SPEED = 520 * NAVIGATION_SPEED_MULTIPLIER;


export function rendererMap(context) {
    var dispatch = d3_dispatch(
        'move', 'drawn',
        'crossEditableZoom', 'hitMinZoom',
        'changeHighlighting', 'changeAreaFill'
    );
    var projection = context.projection;
    var curtainProjection = context.curtainProjection;
    var drawLayers;
    var drawPoints;
    var drawVertices;
    var drawLines;
    var drawAreas;
    var drawMidpoints;
    var drawLabels;

    var _selection = d3_select(null);
    var supersurface = d3_select(null);
    var wrapper = d3_select(null);
    var surface = d3_select(null);

    var _dimensions = [1, 1];
    var _dblClickZoomEnabled = true;
    var _redrawEnabled = true;
    var _gestureTransformStart;
    var _transformStart = projection.transform();
    var _transformLast;
    var _isTransformed = false;
    var _minzoom = 0;
    var _getMouseCoords;
    var _lastPointerEvent;
    var _lastWithinEditableZoom;
    var _mapPointerIDs = new Set();
    var _rightDrag;
    var _suppressContextMenuUntil = 0;

    var _navigationKeys = new Set();
    var _navigationFrame;
    var _navigationLastTime;
    var _navigationDirection = '';
    var _navigationStarted;
    var _navigationVelocity = [0, 0];
    var _navigationReleaseStarted;
    var _navigationReleaseVelocity = [0, 0];
    var _navigationZoomKeys = new Set();
    var _wPressStarted;
    var _wHoldTimeout;
    var _wNavigationStarted = false;

    // whether a pointerdown event started the zoom
    var _pointerDown = false;

    // use pointer events on supported platforms; fallback to mouse events
    var _pointerPrefix = 'PointerEvent' in window ? 'pointer' : 'mouse';

    // use pointer event interaction if supported; fallback to touch/mouse events in d3-zoom
    var _zoomerPannerFunction = 'PointerEvent' in window ? utilZoomPan : d3_zoom;

    var _zoomerPanner = _zoomerPannerFunction()
        .scaleExtent([kMin, kMax])
        .interpolate(d3_interpolate)
        .filter(zoomEventFilter)
        .on('zoom.map', zoomPan)
        .on('start.map', function(d3_event) {
            _pointerDown = d3_event && (d3_event.type === 'pointerdown' ||
                (d3_event.sourceEvent && d3_event.sourceEvent.type === 'pointerdown'));
        })
        .on('end.map', function() {
            finishTransform();
        });
    var _doubleUpHandler = utilDoubleUp();

    var scheduleRedraw = throttle(redraw, 750);
    // var isRedrawScheduled = false;
    // var pendingRedrawCall;
    // function scheduleRedraw() {
    //     // Only schedule the redraw if one has not already been set.
    //     if (isRedrawScheduled) return;
    //     isRedrawScheduled = true;
    //     var that = this;
    //     var args = arguments;
    //     pendingRedrawCall = window.requestIdleCallback(function () {
    //         // Reset the boolean so future redraws can be set.
    //         isRedrawScheduled = false;
    //         redraw.apply(that, args);
    //     }, { timeout: 1400 });
    // }

    function cancelPendingRedraw() {
        scheduleRedraw.cancel();
        // isRedrawScheduled = false;
        // window.cancelIdleCallback(pendingRedrawCall);
    }


    function finishTransform() {
        _pointerDown = false;
        if (!_isTransformed) return;

        cancelPendingRedraw();
        resetTransform();
        redraw();
    }


    function panAnimated(delta) {
        const transform = projection.transform();
        const next = d3_zoomIdentity
            .translate(transform.x + delta[0], transform.y + delta[1])
            .scale(transform.k);

        if (_zoomerPanner._transform) {
            _zoomerPanner._transform(next);
        } else if (!_selection.empty()) {
            _selection.node().__zoom = next;
        }
        zoomPan(undefined, undefined, next);
    }


    function map(selection) {
        _selection = selection;

        context
            .on('change.map', immediateRedraw);

        var osm = context.connection();
        if (osm) {
            osm.on('change.map', immediateRedraw);
        }

        function didUndoOrRedo(targetTransform) {
            var mode = context.mode().id;
            if (mode !== 'browse' && mode !== 'select') return;
            if (targetTransform) {
                map.transformEase(targetTransform);
            }
        }

        context.history()
            .on('merge.map', function() { scheduleRedraw(); })
            .on('change.map', immediateRedraw)
            .on('undone.map', function(stack, fromStack) {
                didUndoOrRedo(fromStack.transform);
            })
            .on('redone.map', function(stack) {
                didUndoOrRedo(stack.transform);
            });

        context.background()
            .on('change.map', immediateRedraw);

        context.features()
            .on('redraw.map', immediateRedraw);

        drawLayers
            .on('change.map', function() {
                context.background().updateImagery();
                immediateRedraw();
            });

        selection
            .on('wheel.map mousewheel.map', function(d3_event) {
                // disable swipe-to-navigate browser pages on trackpad/magic mouse – #5552
                d3_event.preventDefault();
            })
            .call(_zoomerPanner)
            .call(_zoomerPanner.transform, projection.transform())
            .on('dblclick.zoom', null); // override d3-zoom dblclick handling

        map.supersurface = selection.append('div')
            .attr('class', 'supersurface')
            .call(utilSetTransform, 0, 0);
        supersurface = map.supersurface;

        // Need a wrapper div because Opera can't cope with an absolutely positioned
        // SVG element: http://bl.ocks.org/jfirebaugh/6fbfbd922552bf776c16
        wrapper = supersurface
            .append('div')
            .attr('class', 'layer layer-data');

        map.surface = wrapper
            .call(drawLayers)
            .selectAll('.surface');
        surface = map.surface;

        surface
            .call(drawLabels.observe)
            .call(_doubleUpHandler)
            .on(_pointerPrefix + 'down.zoom', function(d3_event) {
                _lastPointerEvent = d3_event;
                if (d3_event.button === 2) {
                    startRightDrag(d3_event);
                    d3_event.stopPropagation();
                } else {
                    _mapPointerIDs.add(d3_event.pointerId || 'mouse');
                }
            }, true)
            .on(_pointerPrefix + 'up.zoom', function(d3_event) {
                _lastPointerEvent = d3_event;
                endMapPointer(d3_event);
            })
            .on(_pointerPrefix + 'move.map', function(d3_event) {
                _lastPointerEvent = d3_event;
            })
            .on(_pointerPrefix + 'over.vertices', function(d3_event) {
                if (map.editableDataEnabled() && !_isTransformed) {
                    var hover = d3_event.target.__data__;
                    surface.call(drawVertices.drawHover, context.graph(), hover, map.extent());
                    dispatch.call('drawn', this, { full: false });
                }
            })
            .on(_pointerPrefix + 'out.vertices', function(d3_event) {
                if (map.editableDataEnabled() && !_isTransformed) {
                    var hover = d3_event.relatedTarget && d3_event.relatedTarget.__data__;
                    surface.call(drawVertices.drawHover, context.graph(), hover, map.extent());
                    dispatch.call('drawn', this, { full: false });
                }
            })
            .on('contextmenu.map-right-drag', function(d3_event) {
                if (performance.now() <= _suppressContextMenuUntil) {
                    d3_event.preventDefault();
                    d3_event.stopImmediatePropagation();
                    _suppressContextMenuUntil = 0;
                }
            });

        d3_select(window)
            .on(_pointerPrefix + 'move.map-right-drag', moveRightDrag, true)
            .on(_pointerPrefix + 'up.map-right-drag', endRightDrag, true)
            .on('pointercancel.map-right-drag', cancelRightDrag, true)
            .on(_pointerPrefix + 'up.map-transform pointercancel.map-transform', endMapPointer)
            .on('keydown.map-navigation', navigationKeydown, true)
            .on('keyup.map-navigation', navigationKeyup, true)
            .on('blur.map-navigation', stopNavigation);

        var detected = utilDetect();

        // only WebKit supports gesture events
        if ('GestureEvent' in window &&
            // Listening for gesture events on iOS 13.4+ breaks double-tapping,
            // but we only need to do this on desktop Safari anyway. – #7694
            !detected.isMobileWebKit) {

            // Desktop Safari sends gesture events for multitouch trackpad pinches.
            // We can listen for these and translate them into map zooms.
            surface
                .on('gesturestart.surface', function(d3_event) {
                    d3_event.preventDefault();
                    _gestureTransformStart = projection.transform();
                })
                .on('gesturechange.surface', gestureChange);
        }

        // must call after surface init
        updateAreaFill();

        _doubleUpHandler.on('doubleUp.map', function(d3_event, p0) {
            if (!_dblClickZoomEnabled) return;

            // don't zoom if targeting something other than the map itself
            if (typeof d3_event.target.__data__ === 'object' &&
                // or area fills
                !d3_select(d3_event.target).classed('fill')) return;

            var zoomOut = d3_event.shiftKey;

            var t = projection.transform();

            var p1 = t.invert(p0);

            t = t.scale(zoomOut ? 0.5 : 2);

            t.x = p0[0] - p1[0] * t.k;
            t.y = p0[1] - p1[1] * t.k;

            map.transformEase(t);
        });

        context.on('enter.map',  function() {
            if (!map.editableDataEnabled(true /* skip zoom check */)) return;
            if (_isTransformed) return;

            // redraw immediately any objects affected by a change in selectedIDs.
            var graph = context.graph();
            var selectedAndParents = {};
            context.selectedIDs().forEach(function(id) {
                var entity = graph.hasEntity(id);
                if (entity) {
                    selectedAndParents[entity.id] = entity;
                    if (entity.type === 'node') {
                        graph.parentWays(entity).forEach(function(parent) {
                            selectedAndParents[parent.id] = parent;
                        });
                    }
                }
            });
            var data = Object.values(selectedAndParents);
            var filter = function(d) { return d.id in selectedAndParents; };

            data = context.features().filter(data, graph);

            surface
                .call(drawVertices.drawSelected, graph, map.extent())
                .call(drawLines, graph, data, filter)
                .call(drawAreas, graph, data, filter)
                .call(drawMidpoints, graph, data, filter, map.trimmedExtent());

            updateIndoorFocus(context.history().intersects(map.extent()), graph);

            dispatch.call('drawn', this, { full: false });

            // redraw everything else later
            scheduleRedraw();
        });

        map.dimensions(utilGetDimensions(selection));
    }


    function startRightDrag(d3_event) {
        if (!betteridBool(BETTERID_PREFS.rightDrag, true)) return;
        if (d3_event.pointerType && d3_event.pointerType !== 'mouse') return;

        _rightDrag = {
            pointerId: d3_event.pointerId || 'mouse',
            start: [d3_event.clientX, d3_event.clientY],
            last: [d3_event.clientX, d3_event.clientY],
            moved: false
        };
    }


    function endMapPointer(d3_event) {
        _mapPointerIDs.delete(d3_event.pointerId || 'mouse');
        if (!_mapPointerIDs.size) finishTransform();
    }


    function moveRightDrag(d3_event) {
        if (!_rightDrag || _rightDrag.pointerId !== (d3_event.pointerId || 'mouse')) return;
        if ('buttons' in d3_event && !(d3_event.buttons & 2)) {
            endRightDrag(d3_event);
            return;
        }

        const point = [d3_event.clientX, d3_event.clientY];
        const totalX = point[0] - _rightDrag.start[0];
        const totalY = point[1] - _rightDrag.start[1];
        const threshold = Math.max(4, getSnapTolerance() / 2);
        if (!_rightDrag.moved && Math.hypot(totalX, totalY) < threshold) return;

        _rightDrag.moved = true;
        d3_event.preventDefault();
        d3_event.stopImmediatePropagation();

        const delta = [point[0] - _rightDrag.last[0], point[1] - _rightDrag.last[1]];
        _rightDrag.last = point;
        panAnimated(delta);
    }


    function endRightDrag(d3_event) {
        if (!_rightDrag || _rightDrag.pointerId !== (d3_event.pointerId || 'mouse')) return;
        if (_rightDrag.moved) {
            d3_event.preventDefault();
            d3_event.stopImmediatePropagation();
            _suppressContextMenuUntil = performance.now() + 500;
            finishTransform();
        }
        _rightDrag = null;
    }


    function cancelRightDrag(d3_event) {
        if (!_rightDrag || _rightDrag.pointerId !== (d3_event.pointerId || 'mouse')) return;
        if (_rightDrag.moved) finishTransform();
        _rightDrag = null;
    }


    function navigationEnabled() {
        return experimentalFeatureEnabled(BETTERID_PREFS.wasdNavigation);
    }


    function isTextEntryTarget(target) {
        if (!target || target.nodeType !== 1) return false;
        return target.isContentEditable ||
            /^(INPUT|SELECT|TEXTAREA)$/.test(target.nodeName) ||
            Boolean(target.closest?.('[contenteditable="true"]'));
    }


    function navigationEventKey(d3_event) {
        if (d3_event.code === 'Space' || d3_event.key === ' ' || d3_event.key === 'Spacebar') {
            return 'space';
        }
        return String(d3_event.key || '').toLowerCase();
    }


    function startNavigationKey(key) {
        _navigationKeys.add(key);
        if (!_navigationFrame) {
            _navigationLastTime = performance.now();
            _navigationFrame = window.requestAnimationFrame(navigateFrame);
        }
    }


    function stopNavigationMotion() {
        _navigationKeys.clear();
        _navigationDirection = '';
        _navigationStarted = undefined;
        _navigationReleaseStarted = undefined;
        _navigationVelocity = [0, 0];
        _navigationReleaseVelocity = [0, 0];
        _navigationLastTime = undefined;
        if (_navigationFrame) window.cancelAnimationFrame(_navigationFrame);
        _navigationFrame = undefined;
        finishTransform();
    }


    function releaseNavigationKey(key) {
        _navigationKeys.delete(key);
        if ((prefs(BETTERID_PREFS.navigationMode) || 'walk') === 'walk' && !_navigationKeys.size) {
            stopNavigationMotion();
        }
    }


    function clearWPress() {
        if (_wHoldTimeout) window.clearTimeout(_wHoldTimeout);
        _wHoldTimeout = undefined;
        _wPressStarted = undefined;
        _wNavigationStarted = false;
    }


    function handleWKeydown(d3_event) {
        if (_wPressStarted !== undefined || d3_event.repeat) return;

        _wPressStarted = performance.now();
        _wNavigationStarted = false;
        if (!navigationEnabled()) return;

        d3_event.preventDefault();
        _wHoldTimeout = window.setTimeout(function() {
            _wHoldTimeout = undefined;
            if (_wPressStarted === undefined || !navigationEnabled()) return;
            _wNavigationStarted = true;
            startNavigationKey('w');
        }, W_TAP_MAX_MS);
    }


    function handleWKeyup(d3_event) {
        if (_wPressStarted === undefined) return;

        const shortTap = performance.now() - _wPressStarted <= W_TAP_MAX_MS;
        const wasNavigating = _wNavigationStarted;
        clearWPress();

        d3_event.preventDefault();
        d3_event.stopImmediatePropagation();
        if (wasNavigating) {
            releaseNavigationKey('w');
        } else if (shortTap) {
            map.toggleWireframe();
        }
    }


    function handleZoomKeydown(d3_event, key) {
        if (!navigationEnabled() || (key !== 'shift' && key !== 'space')) return false;

        d3_event.preventDefault();
        d3_event.stopImmediatePropagation();
        if (d3_event.repeat || _navigationZoomKeys.has(key)) return true;

        _navigationZoomKeys.add(key);
        if (key === 'shift') {
            map.zoomIn();
        } else {
            map.zoomOut();
        }
        return true;
    }


    function navigationKeydown(d3_event) {
        if (isTextEntryTarget(d3_event.target) || isTextEntryTarget(document.activeElement)) return;
        if (d3_event.ctrlKey || d3_event.altKey || d3_event.metaKey) return;

        const key = navigationEventKey(d3_event);
        if (handleZoomKeydown(d3_event, key)) return;
        if (d3_event.shiftKey) return;
        if (key === 'w') {
            handleWKeydown(d3_event);
            return;
        }
        if (!navigationEnabled()) return;
        if (!NAVIGATION_KEYS.has(key)) return;

        d3_event.preventDefault();
        startNavigationKey(key);
    }


    function navigationKeyup(d3_event) {
        const key = navigationEventKey(d3_event);
        if (_navigationZoomKeys.has(key)) {
            d3_event.preventDefault();
            d3_event.stopImmediatePropagation();
            _navigationZoomKeys.delete(key);
            return;
        }
        if (key === 'w') {
            handleWKeyup(d3_event);
            return;
        }
        if (!NAVIGATION_KEYS.has(key)) return;
        releaseNavigationKey(key);
    }


    function stopNavigation() {
        clearWPress();
        _navigationZoomKeys.clear();
        stopNavigationMotion();
    }


    function navigationVector() {
        const x = (_navigationKeys.has('a') ? 1 : 0) - (_navigationKeys.has('d') ? 1 : 0);
        const y = (_navigationKeys.has('w') ? 1 : 0) - (_navigationKeys.has('s') ? 1 : 0);
        const length = Math.hypot(x, y) || 1;
        return [x / length, y / length];
    }


    function navigateFrame(now) {
        _navigationFrame = undefined;
        if (!navigationEnabled()) {
            stopNavigation();
            return;
        }

        const elapsed = Math.min(50, Math.max(0, now - (_navigationLastTime || now)));
        _navigationLastTime = now;
        const mode = prefs(BETTERID_PREFS.navigationMode) || 'walk';
        let velocity;

        if (_navigationKeys.size) {
            const direction = Array.from(_navigationKeys).sort().join('');
            const vector = navigationVector();
            if (direction !== _navigationDirection) {
                _navigationDirection = direction;
                _navigationStarted = now;
            }

            if (mode === 'fly') {
                const t = Math.min(1, (now - _navigationStarted) / 280);
                const eased = t * t * (3 - 2 * t);  // cubic Bezier-like ease-in-out
                velocity = [vector[0] * FLY_SPEED * eased, vector[1] * FLY_SPEED * eased];
            } else {
                velocity = [vector[0] * WALK_SPEED, vector[1] * WALK_SPEED];
            }

            _navigationVelocity = velocity;
            _navigationReleaseStarted = undefined;
        } else if (mode === 'fly' && (_navigationVelocity[0] || _navigationVelocity[1])) {
            if (_navigationReleaseStarted === undefined) {
                _navigationReleaseStarted = now;
                _navigationReleaseVelocity = _navigationVelocity.slice();
            }
            const t = Math.min(1, (now - _navigationReleaseStarted) / 420);
            const eased = 1 - t * t * (3 - 2 * t);
            velocity = [
                _navigationReleaseVelocity[0] * eased,
                _navigationReleaseVelocity[1] * eased
            ];
            _navigationVelocity = velocity;
            if (t === 1) {
                stopNavigation();
                return;
            }
        } else {
            stopNavigation();
            return;
        }

        panAnimated([velocity[0] * elapsed / 1000, velocity[1] * elapsed / 1000]);
        _navigationFrame = window.requestAnimationFrame(navigateFrame);
    }


    function zoomEventFilter(d3_event) {
        // Fix for #2151, (see also d3/d3-zoom#60, d3/d3-brush#18)
        // Intercept `mousedown` and check if there is an orphaned zoom gesture.
        // This can happen if a previous `mousedown` occurred without a `mouseup`.
        // If we detect this, dispatch `mouseup` to complete the orphaned gesture,
        // so that d3-zoom won't stop propagation of new `mousedown` events.
        if (d3_event.type === 'mousedown') {
            var hasOrphan = false;
            var listeners = window.__on;
            for (var i = 0; i < listeners.length; i++) {
                var listener = listeners[i];
                if (listener.name === 'zoom' && listener.type === 'mouseup') {
                    hasOrphan = true;
                    break;
                }
            }
            if (hasOrphan) {
                const event = new Event('mouseup');
                // Event needs to be dispatched with an event.view property.
                event.view = window;
                window.dispatchEvent(event);
            }
        }

        return d3_event.button !== 2;   // ignore right clicks
    }


    function pxCenter() {
        return [_dimensions[0] / 2, _dimensions[1] / 2];
    }


    function drawEditable(difference, extent) {
        var mode = context.mode();
        var graph = context.graph();
        var features = context.features();
        var all = context.history().intersects(map.extent());
        var fullRedraw = false;
        var data;
        var set;
        var filter;
        var applyFeatureLayerFilters = true;

        if (map.isInWideSelection()) {
            data = [];
            utilEntityAndDeepMemberIDs(mode.selectedIDs(), context.graph()).forEach(function(id) {
                var entity = context.hasEntity(id);
                if (entity) data.push(entity);
            });
            fullRedraw = true;
            filter = utilFunctor(true);
            // selected features should always be visible, so we can skip filtering
            applyFeatureLayerFilters = false;

        } else if (difference) {
            var complete = difference.complete(map.extent());
            data = Object.values(complete).filter(Boolean);
            set = new Set(Object.keys(complete));
            filter = function(d) { return set.has(d.id); };
            features.clear(data);

        } else {
            // force a full redraw if gatherStats detects that a feature
            // should be auto-hidden (e.g. points or buildings)..
            if (features.gatherStats(all, graph, _dimensions)) {
                extent = undefined;
            }

            if (extent) {
                data = context.history().intersects(map.extent().intersection(extent));
                set = new Set(data.map(function(entity) { return entity.id; }));
                filter = function(d) { return set.has(d.id); };

            } else {
                data = all;
                fullRedraw = true;
                filter = utilFunctor(true);
            }
        }

        if (applyFeatureLayerFilters) {
            data = features.filter(data, graph);
        } else {
            context.features().resetStats();
        }

        if (mode && mode.id === 'select') {
            // update selected vertices - the user might have just double-clicked a way,
            // creating a new vertex, triggering a partial redraw without a mode change
            surface.call(drawVertices.drawSelected, graph, map.extent());
        }

        surface
            .call(drawVertices, graph, data, filter, map.extent(), fullRedraw)
            .call(drawLines, graph, data, filter)
            .call(drawAreas, graph, data, filter)
            .call(drawMidpoints, graph, data, filter, map.trimmedExtent())
            .call(drawPoints, graph, data, filter)
            .call(drawLabels, graph, data, filter, _dimensions, fullRedraw);

        updateIndoorFocus(all, graph);

        dispatch.call('drawn', this, {full: true});
    }


    function updateIndoorFocus(data, graph) {
        const enabled = experimentalFeatureEnabled(BETTERID_PREFS.indoorFocus);
        const selected = context.selectedIDs()
            .map(id => graph.hasEntity(id))
            .filter(Boolean);

        const focusValues = { level: new Set(), layer: new Set() };
        const focusEntities = new Set();
        let isIndoorSelection = false;

        function collect(entity) {
            if (!entity || focusEntities.has(entity.id)) return;
            focusEntities.add(entity.id);
            const tags = entity.tags || {};
            isIndoorSelection ||= Boolean(tags.indoor && tags.indoor !== 'no') ||
                Boolean(tags.indoormark && tags.indoormark !== 'no') ||
                tags.level !== undefined;
            for (const key of ['level', 'layer']) {
                String(tags[key] || '').split(/[;,]/)
                    .map(value => value.trim())
                    .filter(Boolean)
                    .forEach(value => focusValues[key].add(value));
            }
        }

        for (const entity of selected) {
            collect(entity);
            graph.parentWays(entity).forEach(collect);
            graph.parentRelations(entity).forEach(collect);
        }

        const active = enabled && selected.length && isIndoorSelection;
        _selection.classed('betterid-indoor-focus', Boolean(active));
        if (!active) {
            surface.selectAll('.betterid-indoor-dim').classed('betterid-indoor-dim', false);
            return;
        }

        const keep = new Set(focusEntities);
        for (const entity of selected) {
            utilEntityAndDeepMemberIDs([entity.id], graph).forEach(id => keep.add(id));
            if (entity.type === 'way') entity.nodes.forEach(id => keep.add(id));
        }

        const center = selected[0].extent(graph).center();
        for (const entity of data) {
            if (!entity.tags.building) continue;
            let containsFocus = false;
            if (entity.type === 'way') {
                const polygon = entity.nodes
                    .map(id => graph.hasEntity(id))
                    .filter(Boolean)
                    .map(node => node.loc);
                containsFocus = polygon.length > 3 && geoPointInPolygon(center, polygon);
            } else if (entity.type === 'relation') {
                containsFocus = entity.extent(graph).contains(center);
            }
            if (!containsFocus) continue;

            utilEntityAndDeepMemberIDs([entity.id], graph).forEach(id => keep.add(id));
            if (entity.type === 'way') entity.nodes.forEach(id => keep.add(id));
        }

        function datumEntity(d) {
            return d?.properties?.entity || d?.entity || (d?.tags && d?.id ? d : null);
        }

        const focusCache = new Map();
        function onFocusLevel(entity) {
            if (!entity) return true;
            if (keep.has(entity.id)) return true;
            if (focusCache.has(entity.id)) return focusCache.get(entity.id);

            const candidates = [entity]
                .concat(graph.parentWays(entity))
                .concat(graph.parentRelations(entity));
            const result = candidates.some(candidate => {
                const tags = candidate.tags || {};
                return ['level', 'layer'].some(key => {
                    if (!focusValues[key].size) return false;
                    return String(tags[key] || '').split(/[;,]/)
                        .map(value => value.trim())
                        .some(value => focusValues[key].has(value));
                });
            });
            focusCache.set(entity.id, result);
            return result;
        }

        surface.selectAll('.layer-osm *')
            .classed('betterid-indoor-dim', d => !onFocusLevel(datumEntity(d)));
    }

    map.init = function() {
        drawLayers = svgLayers(projection, context);
        drawPoints = svgPoints(projection, context);
        drawVertices = svgVertices(projection, context);
        drawLines = svgLines(projection, context);
        drawAreas = svgAreas(projection, context);
        drawMidpoints = svgMidpoints(projection, context);
        drawLabels = svgLabels(projection, context);
    };

    function editOff() {
        context.features().resetStats();
        surface.selectAll('.layer-osm *').remove();
        surface.selectAll('.layer-touch:not(.markers) *').remove();

        var allowed = {
            'browse': true,
            'save': true,
            'select-note': true,
            'select-data': true,
            'select-error': true
        };

        var mode = context.mode();
        if (mode && !allowed[mode.id]) {
            context.enter(modeBrowse(context));
        }

        dispatch.call('drawn', this, {full: true});
    }





    function gestureChange(d3_event) {
        // Remap Safari gesture events to wheel events - #5492
        // We want these disabled most places, but enabled for zoom/unzoom on map surface
        // https://developer.mozilla.org/en-US/docs/Web/API/GestureEvent
        var e = d3_event;
        e.preventDefault();

        var props = {
            deltaMode: 0,    // dummy values to ignore in zoomPan
            deltaY: 1,       // dummy values to ignore in zoomPan
            clientX: e.clientX,
            clientY: e.clientY,
            screenX: e.screenX,
            screenY: e.screenY,
            x: e.x,
            y: e.y
        };

        var e2 = new WheelEvent('wheel', props);
        e2._scale = e.scale;         // preserve the original scale
        e2._rotation = e.rotation;   // preserve the original rotation

        _selection.node().dispatchEvent(e2);
    }


    function zoomPan(event, key, transform) {
        var source = event && event.sourceEvent || event;
        var eventTransform = transform || (event && event.transform);
        var x = eventTransform.x;
        var y = eventTransform.y;
        var k = eventTransform.k;

        // Special handling of 'wheel' events:
        // They might be triggered by the user scrolling the mouse wheel,
        // or 2-finger pinch/zoom gestures, the transform may need adjustment.
        if (source && source.type === 'wheel') {

            // assume that the gesture is already handled by pointer events
            if (_pointerDown) return;

            var detected = utilDetect();
            var dX = source.deltaX;
            var dY = source.deltaY;
            var x2 = x;
            var y2 = y;
            var k2 = k;
            var t0, p0, p1;

            // Normalize mousewheel scroll speed (Firefox) - #3029
            // If wheel delta is provided in LINE units, recalculate it in PIXEL units
            // We are essentially redoing the calculations that occur here:
            //   https://github.com/d3/d3-zoom/blob/78563a8348aa4133b07cac92e2595c2227ca7cd7/src/zoom.js#L203
            // See this for more info:
            //   https://github.com/basilfx/normalize-wheel/blob/master/src/normalizeWheel.js
            if (source.deltaMode === 1 /* LINE */) {
                // Convert from lines to pixels, more if the user is scrolling fast.
                // (I made up the exp function to roughly match Firefox to what Chrome does)
                // These numbers should be floats, because integers are treated as pan gesture below.
                var lines = Math.abs(source.deltaY);
                var sign = (source.deltaY > 0) ? 1 : -1;
                dY = sign * clamp(
                    lines * 18.001,
                    4.000244140625,    // min
                    350.000244140625   // max
                );

                // recalculate x2,y2,k2
                t0 = _isTransformed ? _transformLast : _transformStart;
                p0 = _getMouseCoords(source);
                p1 = t0.invert(p0);
                k2 = t0.k * Math.pow(2, -dY / 500);
                k2 = clamp(k2, kMin, kMax);
                x2 = p0[0] - p1[0] * k2;
                y2 = p0[1] - p1[1] * k2;

            // 2 finger map pinch zooming (Safari) - #5492
            // These are fake `wheel` events we made from Safari `gesturechange` events..
            } else if (source._scale) {
                // recalculate x2,y2,k2
                t0 = _gestureTransformStart;
                p0 = _getMouseCoords(source);
                p1 = t0.invert(p0);
                k2 = t0.k * source._scale;
                k2 = clamp(k2, kMin, kMax);
                x2 = p0[0] - p1[0] * k2;
                y2 = p0[1] - p1[1] * k2;

            // 2 finger map pinch zooming (all browsers except Safari) - #5492
            // Pinch zooming via the `wheel` event will always have:
            // - `ctrlKey = true`
            // - `deltaY` is not round integer pixels (ignore `deltaX`)
            } else if (source.ctrlKey && !isInteger(dY)) {
                dY *= 6;   // slightly scale up whatever the browser gave us

                // recalculate x2,y2,k2
                t0 = _isTransformed ? _transformLast : _transformStart;
                p0 = _getMouseCoords(source);
                p1 = t0.invert(p0);
                k2 = t0.k * Math.pow(2, -dY / 500);
                k2 = clamp(k2, kMin, kMax);
                x2 = p0[0] - p1[0] * k2;
                y2 = p0[1] - p1[1] * k2;

            // Trackpad scroll zooming with shift or alt/option key down
            } else if ((source.altKey || source.shiftKey) && isInteger(dY)) {
                // recalculate x2,y2,k2
                t0 = _isTransformed ? _transformLast : _transformStart;
                p0 = _getMouseCoords(source);
                p1 = t0.invert(p0);
                k2 = t0.k * Math.pow(2, -dY / 500);
                k2 = clamp(k2, kMin, kMax);
                x2 = p0[0] - p1[0] * k2;
                y2 = p0[1] - p1[1] * k2;

            // 2 finger map panning (Mac only, all browsers except Firefox #8595) - #5492, #5512
            // Panning via the `wheel` event will always have:
            // - `ctrlKey = false`
            // - `deltaX`,`deltaY` are round integer pixels
            } else if (detected.os === 'mac' && detected.browser !== 'Firefox' && !source.ctrlKey && isInteger(dX) && isInteger(dY)) {
                p1 = projection.translate();
                x2 = p1[0] - dX;
                y2 = p1[1] - dY;
                k2 = projection.scale();
                k2 = clamp(k2, kMin, kMax);
            }

            // something changed - replace the event transform
            if (x2 !== x || y2 !== y || k2 !== k) {
                x = x2;
                y = y2;
                k = k2;
                eventTransform = d3_zoomIdentity.translate(x2, y2).scale(k2);
                if (_zoomerPanner._transform) {
                    // utilZoomPan interface
                    _zoomerPanner._transform(eventTransform);
                } else {
                    // d3_zoom interface
                    _selection.node().__zoom = eventTransform;
                }
            }

        }

        if (_transformStart.x === x &&
            _transformStart.y === y &&
            _transformStart.k === k) {
            return;  // no change
        }

        if (geoScaleToZoom(k, TILESIZE) < _minzoom) {
            surface.interrupt();
            dispatch.call('hitMinZoom', this, map);
            setCenterZoom(map.center(), context.minEditableZoom(), 0, true);
            scheduleRedraw();
            dispatch.call('move', this, map);
            return;
        }

        projection.transform(eventTransform);

        var withinEditableZoom = map.withinEditableZoom();
        if (_lastWithinEditableZoom !== withinEditableZoom) {
            if (_lastWithinEditableZoom !== undefined) {
                // notify that the map zoomed in or out over the editable zoom threshold
                dispatch.call('crossEditableZoom', this, withinEditableZoom);
            }
            _lastWithinEditableZoom = withinEditableZoom;
        }

        var scale = k / _transformStart.k;
        var tX = (x / scale - _transformStart.x) * scale;
        var tY = (y / scale - _transformStart.y) * scale;

        if (context.inIntro()) {
            curtainProjection.transform({
                x: x - tX,
                y: y - tY,
                k: k
            });
        }

        if (source) {
            _lastPointerEvent = event;
        }
        _isTransformed = true;
        _transformLast = eventTransform;
        utilSetTransform(supersurface, tX, tY, scale);
        scheduleRedraw();

        dispatch.call('move', this, map);


        function isInteger(val) {
            return typeof val === 'number' && isFinite(val) && Math.floor(val) === val;
        }
    }


    function resetTransform() {
        if (!_isTransformed) return false;

        utilSetTransform(supersurface, 0, 0);
        _isTransformed = false;
        if (context.inIntro()) {
            curtainProjection.transform(projection.transform());
        }
        return true;
    }


    function redraw(difference, extent) {
        // in unit tests, we need to abort if the test has already completed
        if (typeof window === 'undefined') return;

        if (surface.empty() || !_redrawEnabled) return;

        _selection.style('--betterid-snap-tolerance', `${getSnapTolerance()}px`);

        // If we are in the middle of a zoom/pan, we can't do differenced redraws.
        // It would result in artifacts where differenced entities are redrawn with
        // one transform and unchanged entities with another.
        if (resetTransform()) {
            difference = undefined;
            extent = undefined;
        }

        var zoom = map.zoom();
        var z = String(~~zoom);

        if (surface.attr('data-zoom') !== z) {
            surface.attr('data-zoom', z);
        }

        // class surface as `lowzoom` around z17-z18.5 (based on latitude)
        var lat = map.center()[1];
        var lowzoom = d3_scaleLinear()
            .domain([-60, 0, 60])
            .range([17, 18.5, 17])
            .clamp(true);

        surface
            .classed('low-zoom', zoom <= lowzoom(lat));


        if (!difference) {
            supersurface.call(context.background());
            wrapper.call(drawLayers);
        }

        // OSM
        if (map.editableDataEnabled() || map.isInWideSelection()) {
            context.loadTiles(projection);
            drawEditable(difference, extent);
        } else {
            editOff();
        }

        _transformStart = projection.transform();

        return map;
    }



    var immediateRedraw = function(difference, extent) {
        if (!difference && !extent) cancelPendingRedraw();
        redraw(difference, extent);
    };


    map.lastPointerEvent = function() {
        return _lastPointerEvent;
    };


    map.mouse = function(d3_event) {
        var event = d3_event || _lastPointerEvent;
        if (event) {
            var s;
            while ((s = event.sourceEvent)) { event = s; }
            return _getMouseCoords(event);
        }
        return null;
    };


    // returns Lng/Lat
    map.mouseCoordinates = function() {
        var coord = map.mouse() || pxCenter();
        return projection.invert(coord);
    };


    map.dblclickZoomEnable = function(val) {
        if (!arguments.length) return _dblClickZoomEnabled;
        _dblClickZoomEnabled = val;
        return map;
    };


    map.redrawEnable = function(val) {
        if (!arguments.length) return _redrawEnabled;
        _redrawEnabled = val;
        return map;
    };


    map.isTransformed = function() {
        return _isTransformed;
    };


    function setTransform(t2, duration, force) {
        var t = projection.transform();
        if (!force && t2.k === t.k && t2.x === t.x && t2.y === t.y) return false;

        if (duration) {
            _selection
                .transition()
                .duration(duration)
                .on('start', function() { map.startEase(); })
                .call(_zoomerPanner.transform, d3_zoomIdentity.translate(t2.x, t2.y).scale(t2.k));
        } else {
            projection.transform(t2);
            _transformStart = t2;
            _selection.call(_zoomerPanner.transform, _transformStart);
        }

        return true;
    }


    function setCenterZoom(loc2, z2, duration, force) {
        var c = map.center();
        var z = map.zoom();
        if (loc2[0] === c[0] && loc2[1] === c[1] && z2 === z && !force) return false;

        var proj = geoRawMercator().transform(projection.transform());  // copy projection

        var k2 = clamp(geoZoomToScale(z2, TILESIZE), kMin, kMax);
        proj.scale(k2);

        var t = proj.translate();
        var point = proj(loc2);

        var center = pxCenter();
        t[0] += center[0] - point[0];
        t[1] += center[1] - point[1];

        return setTransform(d3_zoomIdentity.translate(t[0], t[1]).scale(k2), duration, force);
    }


    map.pan = function(delta, duration) {
        var t = projection.translate();
        var k = projection.scale();

        t[0] += delta[0];
        t[1] += delta[1];

        if (duration) {
            _selection
                .transition()
                .duration(duration)
                .on('start', function() { map.startEase(); })
                .call(_zoomerPanner.transform, d3_zoomIdentity.translate(t[0], t[1]).scale(k));
        } else {
            projection.translate(t);
            _transformStart = projection.transform();
            _selection.call(_zoomerPanner.transform, _transformStart);
            dispatch.call('move', this, map);
            immediateRedraw();
        }

        return map;
    };


    /** @type {GetSet<unknown, Vec2>} */
    map.dimensions = function(val) {
        if (!arguments.length) return _dimensions;

        _dimensions = val;
        drawLayers.dimensions(_dimensions);
        context.background().dimensions(_dimensions);
        projection.clipExtent([[0, 0], _dimensions]);
        _getMouseCoords = utilFastMouse(supersurface.node());

        scheduleRedraw();
        return map;
    };


    function zoomIn(delta) {
        setCenterZoom(map.center(), Math.trunc(map.zoom() + 0.45) + delta, 150, true);
    }

    function zoomOut(delta) {
        setCenterZoom(map.center(), Math.ceil(map.zoom() - 0.45) - delta, 150, true);
    }

    map.zoomIn = function() { zoomIn(1); };
    map.zoomInFurther = function() { zoomIn(4); };
    map.canZoomIn = function() { return map.zoom() < maxZoom; };

    map.zoomOut = function() { zoomOut(1); };
    map.zoomOutFurther = function() { zoomOut(4); };
    map.canZoomOut = function() { return map.zoom() > minZoom; };

    map.center = function(loc2) {
        if (!arguments.length) {
            return projection.invert(pxCenter());
        }

        if (setCenterZoom(loc2, map.zoom())) {
            dispatch.call('move', this, map);
        }

        scheduleRedraw();
        return map;
    };

    function trimmedCenter(loc, zoom) {
        var offset = [paneWidth() / 2, (footerHeight() - toolbarHeight()) / 2];

        var proj = geoRawMercator().transform(projection.transform());  // copy projection
        // use the target zoom to calculate the offset center
        proj.scale(geoZoomToScale(zoom, TILESIZE));

        var locPx = proj(loc);
        var offsetLocPx = [locPx[0] + offset[0], locPx[1] + offset[1]];
        var offsetLoc = proj.invert(offsetLocPx);

        return offsetLoc;
    };

    function paneWidth() {
        const openPane = context.container().select('.map-panes .map-pane.shown');
        if (!openPane.empty()) {
            return openPane.node().offsetWidth;
        }
        return 0;
    };

    function toolbarHeight() {
        const toolbar = context.container().select('.top-toolbar');
        return toolbar.node().offsetHeight;
    };

    function footerHeight() {
        const footer = context.container().select('.map-footer-bar');
        return footer.node().offsetHeight;
    }

    map.zoom = function(z2) {
        if (!arguments.length) {
            return Math.max(geoScaleToZoom(projection.scale(), TILESIZE), 0);
        }

        if (z2 < _minzoom) {
            surface.interrupt();
            dispatch.call('hitMinZoom', this, map);
            z2 = context.minEditableZoom();
        }

        if (setCenterZoom(map.center(), z2)) {
            dispatch.call('move', this, map);
        }

        scheduleRedraw();
        return map;
    };


    map.centerZoom = function(loc2, z2) {
        if (setCenterZoom(loc2, z2)) {
            dispatch.call('move', this, map);
        }

        scheduleRedraw();
        return map;
    };


    map.zoomTo = function(what) {
        return map.zoomToEase(what, 0);
    };


    map.centerEase = function(loc2, duration) {
        duration = duration || 250;
        setCenterZoom(loc2, map.zoom(), duration);
        return map;
    };


    map.zoomEase = function(z2, duration) {
        duration = duration || 250;
        setCenterZoom(map.center(), z2, duration, false);
        return map;
    };


    map.centerZoomEase = function(loc2, z2, duration) {
        duration = duration || 250;
        setCenterZoom(loc2, z2, duration, false);
        return map;
    };


    map.transformEase = function(t2, duration) {
        duration = duration || 250;
        setTransform(t2, duration, false /* don't force */);
        return map;
    };


    map.zoomToEase = function(what, duration) {
        let extent;
        if (what instanceof geoExtent) {
            // we've directly been given an extent
            extent = what;
        } else {
            // we're given one or more entities to zoom to
            if (!isArray(what)) what = [what];
            extent = what
                .map(entity => entity.extent(context.graph()))
                .reduce((a, b) => a.extend(b));
        }

        if (!isFinite(extent.area())) return map;

        var z = clamp(map.trimmedExtentZoom(extent), 0, 20);
        const loc = trimmedCenter(extent.center(), z);

        if (duration === 0) {
            return map.centerZoom(loc, z);
        } else {
            return map.centerZoomEase(loc, z, duration);
        }
    };


    map.startEase = function() {
        utilBindOnce(surface, _pointerPrefix + 'down.ease', function() {
            map.cancelEase();
        });
        return map;
    };


    map.cancelEase = function() {
        _selection.interrupt();
        return map;
    };


    map.extent = function(val) {
        if (!arguments.length) {
            return new geoExtent(
                projection.invert([0, _dimensions[1]]),
                projection.invert([_dimensions[0], 0])
            );
        } else {
            var extent = geoExtent(val);
            map.centerZoom(extent.center(), map.extentZoom(extent));
        }
    };


    /** @type {GetSet<typeof map, geoExtent>} */
    map.trimmedExtent = function(val) {
        if (!arguments.length) {
            var headerY = 71;
            var footerY = 30;
            var pad = 10;
            return new geoExtent(
                projection.invert([pad, _dimensions[1] - footerY - pad]),
                projection.invert([_dimensions[0] - pad, headerY + pad])
            );
        } else {
            var extent = geoExtent(val);
            map.centerZoom(extent.center(), map.trimmedExtentZoom(extent));
        }
    };


    function calcExtentZoom(extent, dim) {
        var tl = projection([extent[0][0], extent[1][1]]);
        var br = projection([extent[1][0], extent[0][1]]);

        // Calculate maximum zoom that fits extent
        var hFactor = (br[0] - tl[0]) / dim[0];
        var vFactor = (br[1] - tl[1]) / dim[1];
        var hZoomDiff = Math.log(Math.abs(hFactor)) / Math.LN2;
        var vZoomDiff = Math.log(Math.abs(vFactor)) / Math.LN2;
        var newZoom = map.zoom() - Math.max(hZoomDiff, vZoomDiff);

        return newZoom;
    }


    map.extentZoom = function(val) {
        return calcExtentZoom(geoExtent(val), _dimensions);
    };


    map.trimmedExtentZoom = function(val) {
        const trim = 40;
        const trimmed = [
            _dimensions[0] - trim - paneWidth(),
            _dimensions[1] - trim - toolbarHeight() - footerHeight()
        ];
        return calcExtentZoom(geoExtent(val), trimmed);
    };


    map.withinEditableZoom = function() {
        return map.zoom() >= context.minEditableZoom();
    };


    map.isInWideSelection = function() {
        return !map.withinEditableZoom() && context.selectedIDs().length;
    };


    map.editableDataEnabled = function(skipZoomCheck) {

        var layer = context.layers().layer('osm');
        if (!layer || !layer.enabled()) return false;

        return skipZoomCheck || map.withinEditableZoom();
    };


    map.notesEditable = function() {
        var layer = context.layers().layer('notes');
        if (!layer || !layer.enabled()) return false;

        return map.withinEditableZoom();
    };


    map.minzoom = function(val) {
        if (!arguments.length) return _minzoom;
        _minzoom = val;
        return map;
    };


    map.toggleHighlightEdited = function() {
        surface.classed('highlight-edited', !surface.classed('highlight-edited'));
        map.pan([0,0]);  // trigger a redraw
        dispatch.call('changeHighlighting', this);
    };


    /** @type import('../ui/sections/map_style_options').MapStyle[] */
    map.areaFillOptions = ['wireframe', 'partial', 'full'];

    map.activeAreaFill = function(val) {
        if (!arguments.length) return prefs('area-fill') || 'partial';

        prefs('area-fill', val);
        if (val !== 'wireframe') {
            prefs('area-fill-toggle', val);
        }
        updateAreaFill();
        map.pan([0,0]);  // trigger a redraw
        dispatch.call('changeAreaFill', this);
        return map;
    };

    map.toggleWireframe = function() {

        var activeFill = map.activeAreaFill();

        if (activeFill === 'wireframe') {
            activeFill = prefs('area-fill-toggle') || 'partial';
        } else {
            activeFill = 'wireframe';
        }

        map.activeAreaFill(activeFill);
    };


    prefs.onChange(BETTERID_PREFS.snapTolerance, function() {
        if (!_selection.empty()) immediateRedraw();
    });
    prefs.onChange(BETTERID_PREFS.experimental, function() {
        if (!navigationEnabled()) stopNavigation();
        if (!_selection.empty()) immediateRedraw();
    });
    prefs.onChange(BETTERID_PREFS.indoorFocus, function() {
        if (!_selection.empty()) immediateRedraw();
    });
    prefs.onChange(BETTERID_PREFS.wasdNavigation, function() {
        if (!navigationEnabled()) stopNavigation();
    });

    function updateAreaFill() {
        var activeFill = map.activeAreaFill();
        map.areaFillOptions.forEach(function(opt) {
            surface.classed('fill-' + opt, Boolean(opt === activeFill));
        });
    }


    map.layers = () => drawLayers;


    map.doubleUpHandler = function() {
        return _doubleUpHandler;
    };


    return utilRebind(map, dispatch, 'on');
}
