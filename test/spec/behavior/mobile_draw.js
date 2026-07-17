import { setTimeout as delay } from 'node:timers/promises';

import { behaviorMobileDraw, utilIsMobileDrawEvent } from '../../../modules/behavior/mobile_draw';
import { behaviorDraw } from '../../../modules/behavior/draw';
import { coreGraph } from '../../../modules';
import { select as d3_select } from 'd3-selection';


describe('mobile drawing gestures', function() {
    const originalMatchMedia = window.matchMedia;

    afterEach(function() {
        window.matchMedia = originalMatchMedia;
    });

    it('enables shortcuts only for touch or pen on narrow viewports', function() {
        window.matchMedia = () => ({ matches: true });

        expect(utilIsMobileDrawEvent({ pointerType: 'touch' })).toBe(true);
        expect(utilIsMobileDrawEvent({ pointerType: 'pen' })).toBe(true);
        expect(utilIsMobileDrawEvent({ pointerType: 'mouse' })).toBe(false);
    });

    it('keeps the shortcuts off on wide viewports', function() {
        window.matchMedia = () => ({ matches: false });

        expect(utilIsMobileDrawEvent({ pointerType: 'touch' })).toBe(false);
    });

    it('starts a line with line and area preset choices on a double tap', function() {
        window.matchMedia = () => ({ matches: true });
        const harness = mobileHarness();

        harness.tap(1);
        harness.tap(2);

        expect(harness.enteredMode().id).toBe('draw-line');
        expect(harness.enteredMode().presetGeometries()).toStrictEqual(['line', 'area']);
        expect(Object.values(harness.graph().entities).filter(entity => entity?.type === 'node')).toHaveLength(1);
        expect(Object.values(harness.graph().entities).filter(entity => entity?.type === 'way')).toHaveLength(1);

        harness.destroy();
    });

    it('adds a new point on a long press', async function() {
        window.matchMedia = () => ({ matches: true });
        const harness = mobileHarness();

        harness.down(1);
        await delay(475);

        expect(harness.enteredMode().id).toBe('select');
        expect(harness.enteredMode().newFeature()).toBe(true);
        expect(Object.values(harness.graph().entities).filter(entity => entity?.type === 'node')).toHaveLength(1);

        harness.up(1);
        harness.destroy();
    });

    it('finishes the current line on the second narrow-screen touch tap', function() {
        window.matchMedia = () => ({ matches: true });

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
        let finishes = 0;
        const draw = behaviorDraw(context)
            .on('click.test', () => clicks++)
            .on('finish.test', () => finishes++);
        surface.call(draw);

        const prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
        const down = surface.on(`${prefix}down.draw`);
        const up = d3_select(window).on(`${prefix}up.draw`);
        const event = {
            altKey: false,
            buttons: 0,
            clientX: 20,
            clientY: 20,
            pointerId: 1,
            pointerType: 'touch',
            preventDefault: () => {},
            stopPropagation: () => {},
            target: surface.node(),
            timeStamp: 1,
            type: `${prefix}up`
        };

        down.call(surface.node(), { ...event, type: `${prefix}down` });
        up.call(window, event);
        down.call(surface.node(), { ...event, timeStamp: 2, type: `${prefix}down` });
        up.call(window, { ...event, timeStamp: 2 });

        expect(clicks).toBe(1);
        expect(finishes).toBe(1);

        surface.call(draw.off).remove();
    });

    function mobileHarness() {
        const surface = d3_select(document.body).append('div');
        let graph = new coreGraph();
        let mode = { id: 'browse' };
        let enteredMode;
        const hover = () => {};
        hover.cancel = () => {};
        const projection = loc => loc;
        projection.invert = point => point;

        const context = {
            container: () => surface,
            editable: () => true,
            enter: newMode => {
                mode = newMode;
                enteredMode = newMode;
            },
            graph: () => graph,
            mode: () => mode,
            perform: (...args) => {
                if (typeof args.at(-1) !== 'function') args.pop();
                graph = args.reduce((result, action) => action(result), graph);
            },
            projection,
            ui: () => ({ sidebar: { hover } })
        };

        const behavior = behaviorMobileDraw(context);
        surface.call(behavior);
        const prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
        const pointerdown = surface.on(`${prefix}down.mobileDraw`);
        const pointerup = d3_select(window).on(`${prefix}up.mobileDraw`);

        function event(pointerId, type) {
            return {
                clientX: 20,
                clientY: 20,
                pointerId,
                pointerType: 'touch',
                preventDefault: () => {},
                target: surface.node(),
                type
            };
        }

        return {
            destroy: () => surface.call(behavior.off).remove(),
            down: pointerId => pointerdown.call(surface.node(), event(pointerId, `${prefix}down`)),
            enteredMode: () => enteredMode,
            graph: () => graph,
            tap: pointerId => {
                pointerdown.call(surface.node(), event(pointerId, `${prefix}down`));
                pointerup.call(window, event(pointerId, `${prefix}up`));
            },
            up: pointerId => pointerup.call(window, event(pointerId, `${prefix}up`))
        };
    }
});
