import { select as d3_select } from 'd3-selection';

import { actionAddEntity } from '../actions/add_entity';
import { actionAddVertex } from '../actions/add_vertex';
import { t } from '../core/localizer';
import { geoVecLength } from '../geo';
import { modeDrawLine } from '../modes/draw_line';
import { modeSelect } from '../modes/select';
import { OsmAbstractEntity, osmNode, osmWay } from '../osm';
import { utilFastMouse } from '../util';


const DOUBLE_TAP_DELAY = 350;
const DOUBLE_TAP_TOLERANCE = 24;
// Fire before behaviorSelect's 500ms context-menu long press.
const LONG_PRESS_DELAY = 450;
const MOVE_TOLERANCE = 12;


/** Mobile shortcuts for starting common drawing modes directly on the map. */
export function behaviorMobileDraw(context) {
    const pointerPrefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
    let down;
    let lastTap;
    let longPressTimer;

    function behavior(selection) {
        selection.on(`${pointerPrefix}down.mobileDraw`, pointerdown);
        d3_select(window)
            .on(`${pointerPrefix}move.mobileDraw`, pointermove, true)
            .on(`${pointerPrefix}up.mobileDraw`, pointerup, true)
            .on('pointercancel.mobileDraw', cancel, true);
    }

    behavior.off = function(selection) {
        cancel();
        lastTap = null;
        selection.on(`${pointerPrefix}down.mobileDraw`, null);
        d3_select(window)
            .on(`${pointerPrefix}move.mobileDraw`, null, true)
            .on(`${pointerPrefix}up.mobileDraw`, null, true)
            .on('pointercancel.mobileDraw', null, true);
    };

    function pointerdown(event) {
        if (!utilIsMobileDrawEvent(event) || !isBlankMapTarget(event.target)) return;
        if (down) return;

        const point = utilFastMouse(this)(event);
        down = {
            id: event.pointerId,
            point,
            getter: utilFastMouse(this),
            longPressed: false
        };

        longPressTimer = window.setTimeout(() => {
            if (!down) return;
            down.longPressed = true;
            lastTap = null;
            addPoint(context.projection.invert(down.point));
        }, LONG_PRESS_DELAY);
    }

    function pointermove(event) {
        if (!down || down.id !== event.pointerId) return;
        if (geoVecLength(down.point, down.getter(event)) > MOVE_TOLERANCE) cancel();
    }

    function pointerup(event) {
        if (!down || down.id !== event.pointerId) return;

        clearLongPress();
        const current = down;
        down = null;
        if (current.longPressed) {
            event.preventDefault();
            return;
        }

        const point = current.getter(event);
        const now = performance.now();
        const isDoubleTap = lastTap && now - lastTap.time <= DOUBLE_TAP_DELAY &&
            geoVecLength(lastTap.point, point) <= DOUBLE_TAP_TOLERANCE;

        if (isDoubleTap) {
            event.preventDefault();
            lastTap = null;
            addLine(context.projection.invert(point));
        } else {
            lastTap = { point, time: now };
        }
    }

    function cancel() {
        clearLongPress();
        down = null;
    }

    function clearLongPress() {
        if (longPressTimer) window.clearTimeout(longPressTimer);
        longPressTimer = null;
    }

    function addPoint(loc) {
        if (context.mode().id !== 'browse' || !context.editable()) return;

        const node = new osmNode({ loc });
        context.perform(actionAddEntity(node), t('operations.add.annotation.point'));
        context.enter(modeSelect(context, [node.id]).newFeature(true));
    }

    function addLine(loc) {
        if (context.mode().id !== 'browse' || !context.editable()) return;

        const startGraph = context.graph();
        const node = new osmNode({ loc });
        const way = new osmWay();

        context.perform(
            actionAddEntity(node),
            actionAddEntity(way),
            actionAddVertex(way.id, node.id)
        );

        context.enter(
            modeDrawLine(context, way.id, startGraph, 'line')
                .presetGeometries(['line', 'area'])
        );
    }

    return behavior;
}


export function utilIsMobileDrawEvent(event) {
    if (!event || !['touch', 'pen'].includes(event.pointerType)) return false;
    if (typeof window.matchMedia === 'function') {
        return window.matchMedia('(max-width: 767px)').matches;
    }
    return window.innerWidth <= 767;
}


function isBlankMapTarget(target) {
    const datum = target?.__data__;
    if (datum instanceof OsmAbstractEntity) return false;
    return !(datum?.properties?.entity instanceof OsmAbstractEntity);
}
