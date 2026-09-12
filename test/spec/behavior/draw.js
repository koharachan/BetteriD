import { select as d3_select } from 'd3-selection';

import { behaviorDraw } from '../../../modules/behavior/draw';
import { prefs } from '../../../modules/core/preferences';


describe('behaviorDraw click vs. drag', function() {
    const originalMatchMedia = window.matchMedia;
    const SNAP_PREF = 'betterid.editing.snap_tolerance';

    afterEach(function() {
        window.matchMedia = originalMatchMedia;
        prefs(SNAP_PREF, null);
    });

    function harness() {
        window.matchMedia = () => ({ matches: false });

        const surface = d3_select(document.body).append('div');
        const map = {
            dblclickZoomEnable: () => map,
            minzoom: () => map
        };
        const hover = () => {};
        hover.cancel = () => {};
        const projection = loc => loc;
        projection.invert = point => point;

        const context = {
            activeID: () => null,
            graph: () => ({ childNodes: () => [] }),
            install: behavior => surface.call(behavior),
            minEditableZoom: () => 16,
            mode: () => ({ id: 'draw-line' }),
            map: () => map,
            projection,
            ui: () => ({ sidebar: { hover } }),
            uninstall: behavior => surface.call(behavior.off)
        };

        let clicks = 0;
        let cancels = 0;
        const draw = behaviorDraw(context)
            .on('click.test', () => clicks++)
            .on('downcancel.test', () => cancels++);
        surface.call(draw);

        const prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
        const down = surface.on(`${prefix}down.draw`);
        const move = surface.on(`${prefix}move.draw`);
        const up = d3_select(window).on(`${prefix}up.draw`);

        function pointerEvent(x, y, type) {
            return {
                altKey: false,
                buttons: type === `${prefix}up` ? 0 : 1,
                clientX: x,
                clientY: y,
                pointerId: 1,
                pointerType: 'mouse',
                preventDefault: () => {},
                stopPropagation: () => {},
                target: surface.node(),
                timeStamp: 1,
                type
            };
        }

        return {
            clicks: () => clicks,
            cancels: () => cancels,
            destroy: () => surface.call(draw.off).remove(),
            drag: (from, to) => {
                down.call(surface.node(), pointerEvent(from[0], from[1], `${prefix}down`));
                move.call(surface.node(), pointerEvent(to[0], to[1], `${prefix}move`));
                up.call(window, pointerEvent(to[0], to[1], `${prefix}up`));
            }
        };
    }

    it('places a vertex when the pointer drifts a couple of pixels, for any snap setting', function() {
        for (const snap of ['2', '8', '30']) {
            prefs(SNAP_PREF, snap);
            const h = harness();
            h.drag([20, 20], [22, 20]);   // 2px drift, well under the 4px threshold

            expect(h.clicks(), `snap=${snap}`).toBe(1);
            expect(h.cancels(), `snap=${snap}`).toBe(0);

            h.destroy();
        }
    });

    it('treats a real drag as a drag, not a click', function() {
        prefs(SNAP_PREF, '2');
        const h = harness();
        h.drag([20, 20], [30, 20]);   // 10px drag

        expect(h.clicks()).toBe(0);
        expect(h.cancels()).toBe(1);

        h.destroy();
    });

    it('accepts the second click of a fast double click even when the hand moves slightly', function() {
        prefs(SNAP_PREF, '4');
        const h = harness();

        h.drag([20, 20], [20, 20]);           // first click, no drift
        expect(h.clicks()).toBe(1);

        h.drag([20, 20], [23, 20]);           // second click with 3px drift
        expect(h.clicks()).toBe(2);

        h.destroy();
    });
});
