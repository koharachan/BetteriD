import { fn } from '@vitest/spy';
import { setTimeout } from 'node:timers/promises';
import { select as d3_select } from 'd3-selection';
import { timerFlush as d3_timerFlush } from 'd3-timer';
import css from '../../../css/55_cursors.css?raw';

describe('iD.Map', function() {
    var content, context, map;

    beforeEach(function() {
        d3_select('head').append('style').html(css);
        content = d3_select('body').append('div');
        context = iD.coreContext().assetPath('../dist/').init().container(content);
        map = context.map();
        content.call(map);
        // Set default dimensions for map before zoom/center tests
        map.dimensions([1000, 1000]);
    });

    afterEach(function() {
        content.remove();
    });

    describe('#zoom', function() {
        it('gets and sets zoom level', function() {
            expect(map.zoom(4)).toEqual(map);
            expect(map.zoom()).toEqual(4);
        });

        it('dispatches move event when zoom changes', function() {
            const spy = fn();
            map.zoom(4);
            map.on('move', spy);
            map.zoom(5);
            expect(spy).toHaveBeenCalled();
        });

        it('dispatches no move event when zoom does not change', function() {
            const spy = fn();
            map.zoom(4);
            map.on('move', spy);
            map.zoom(4);
            expect(spy).not.toHaveBeenCalled();
        });

        it('respects minzoom', function() {
            map.minzoom(16);
            map.zoom(15);
            expect(map.zoom()).toEqual(16);
        });
    });

    describe('#zoomIn', function() {
        it('increments zoom', async () => {
            expect(map.zoom(4)).toEqual(map);
            map.zoomIn();
            await setTimeout(275);
            d3_timerFlush();
            expect(map.zoom()).toBeCloseTo(5, 6);
        });
    });

    describe('#zoomOut', function() {
        it('decrements zoom', async () => {
            expect(map.zoom(4)).toEqual(map);
            map.zoomOut();
            await setTimeout(275);
            d3_timerFlush();
            expect(map.zoom()).toBeCloseTo(3, 6);
        });
    });

    describe('#minzoom', function() {
        it('is zero by default', function() {
            expect(map.minzoom()).toEqual(0);
        });
    });

    describe('#center', function() {
        it('gets and sets center', function() {
            expect(map.center([0, 0])).toEqual(map);
            expect(map.center()[0]).toBeCloseTo(0, 6);
            expect(map.center()[1]).toBeCloseTo(0, 6);
            expect(map.center([10, 15])).toEqual(map);
            expect(map.center()[0]).toBeCloseTo(10, 6);
            expect(map.center()[1]).toBeCloseTo(15, 6);
        });

        it('dispatches move event when center changes', function() {
            const spy = fn();
            map.center([0, 0]);
            map.on('move', spy);
            map.center([1, 1]);
            expect(spy).toHaveBeenCalled();
        });

        it('dispatches no move event when center does not change', function() {
            const spy = fn();
            map.center([0, 0]);
            map.on('move', spy);
            map.center([0, 0]);
            expect(spy).not.toHaveBeenCalled();
        });
    });

    describe('#centerEase', function() {
        it('sets center', async () => {
            expect(map.center([10, 10])).toEqual(map);
            expect(map.centerEase([20, 20], 250)).toEqual(map);
            await setTimeout(275);
            d3_timerFlush();
            expect(map.center()[0]).toBeCloseTo(20, 6);
            expect(map.center()[1]).toBeCloseTo(20, 6);
        });
    });

    describe('#centerZoom', function() {
        it('gets and sets center and zoom', function() {
            expect(map.centerZoom([20, 25], 4)).toEqual(map);
            expect(map.center()[0]).toBeCloseTo(20, 6);
            expect(map.center()[1]).toBeCloseTo(25, 6);
            expect(map.zoom()).toBe(4);
        });
    });

    describe('#extent', function() {
        it('gets and sets extent', function() {
            map.dimensions([100, 100])
                .center([0, 0]);

            expect(map.extent()[0][0]).toBeCloseTo(-17.5, 0);
            expect(map.extent()[1][0]).toBeCloseTo(17.5, 0);
            map.extent([[10, 1], [30, 1]]);
            expect(map.extent()[0][0]).toBeCloseTo(10, 1);
            expect(map.extent()[1][0]).toBeCloseTo(30, 1);
            map.extent([[-1, -40], [1, -20]]);
            expect(map.extent()[0][1]).toBeGreaterThan(-41);
            expect(map.extent()[0][1]).toBeLessThan(-39);
            expect(map.extent()[1][1]).toBeGreaterThan(-21);
            expect(map.extent()[1][1]).toBeLessThan(-19);
        });
    });

    describe('surface', function() {
        it('is an SVG element', function() {
           expect(map.surface.node().tagName).toEqual('svg');
        });
    });

    describe('cursors', function() {
        var mode, behavior, point, vertex, line, area, midpoint;

        beforeEach(function() {
            mode = d3_select('body').append('div');
            behavior = mode.append('div');

            point    = behavior.append('div').attr('class', 'node point');
            vertex   = behavior.append('div').attr('class', 'node vertex');
            line     = behavior.append('div').attr('class', 'way line');
            area     = behavior.append('div').attr('class', 'way area');
            midpoint = behavior.append('div').attr('class', 'midpoint');
            // Ensure map dimensions set for any map instance created in nested tests
            if (typeof map?.dimensions === 'function') map.dimensions([1000, 1000]);
        });

        afterEach(function() {
            mode.remove();
        });

        function cursor(selection) {
            return window.getComputedStyle(selection.node()).cursor;
        }

        test('points use select-point cursor in browse and select modes', function() {
            mode.attr('class', 'ideditor mode-browse');
            expect(cursor(point)).to.match(/cursor\/select-point/);
            mode.attr('class', 'ideditor mode-select');
            expect(cursor(point)).to.match(/cursor\/select-point/);
        });

        test('vertices use select-vertex cursor in browse and select modes', function() {
            mode.attr('class', 'ideditor mode-browse');
            expect(cursor(vertex)).to.match(/cursor\/select-vertex/);
            mode.attr('class', 'ideditor mode-select');
            expect(cursor(vertex)).to.match(/cursor\/select-vertex/);
        });

        test('lines use select-line cursor in browse and select modes', function() {
            mode.attr('class', 'ideditor mode-browse');
            expect(cursor(line)).to.match(/cursor\/select-line/);
            mode.attr('class', 'ideditor mode-select');
            expect(cursor(line)).to.match(/cursor\/select-line/);
        });

        test('areas use select-area cursor in browse and select modes', function() {
            mode.attr('class', 'ideditor mode-browse');
            expect(cursor(area)).to.match(/cursor\/select-area/);
            mode.attr('class', 'ideditor mode-select');
            expect(cursor(area)).to.match(/cursor\/select-area/);
        });

        test('midpoints use select-split cursor in browse and select modes', function() {
            mode.attr('class', 'ideditor mode-browse');
            expect(cursor(midpoint)).to.match(/cursor\/select-split/);
            mode.attr('class', 'ideditor mode-select');
            expect(cursor(midpoint)).to.match(/cursor\/select-split/);
        });

        test('features use select-add cursor for adding to a selection', function() {
            mode.attr('class', 'ideditor mode-select');
            behavior.attr('class', 'behavior-multiselect');
            expect(cursor(point)).to.match(/cursor\/select-add/);
            expect(cursor(vertex)).to.match(/cursor\/select-add/);
            expect(cursor(line)).to.match(/cursor\/select-add/);
            expect(cursor(area)).to.match(/cursor\/select-add/);
        });

        test('features use select-remove cursor for removing from a selection', function() {
            mode.attr('class', 'ideditor mode-select');
            behavior.attr('class', 'behavior-multiselect');
            point.classed('selected', true);
            vertex.classed('selected', true);
            line.classed('selected', true);
            area.classed('selected', true);
            expect(cursor(point)).to.match(/cursor\/select-remove/);
            expect(cursor(vertex)).to.match(/cursor\/select-remove/);
            expect(cursor(line)).to.match(/cursor\/select-remove/);
            expect(cursor(area)).to.match(/cursor\/select-remove/);
        });

        test('targeted ways use draw-connect-line cursor in draw modes', function() {
            behavior.attr('class', 'behavior-hover');
            line.classed('target', true);
            area.classed('target', true);
            mode.attr('class', 'ideditor mode-draw-line');
            expect(cursor(line)).to.match(/cursor\/draw-connect-line/);
            expect(cursor(area)).to.match(/cursor\/draw-connect-line/);
            mode.attr('class', 'ideditor mode-draw-area');
            expect(cursor(line)).to.match(/cursor\/draw-connect-line/);
            expect(cursor(area)).to.match(/cursor\/draw-connect-line/);
            mode.attr('class', 'ideditor mode-add-line');
            expect(cursor(line)).to.match(/cursor\/draw-connect-line/);
            expect(cursor(area)).to.match(/cursor\/draw-connect-line/);
            mode.attr('class', 'ideditor mode-add-area');
            expect(cursor(line)).to.match(/cursor\/draw-connect-line/);
            expect(cursor(area)).to.match(/cursor\/draw-connect-line/);
            mode.attr('class', 'ideditor mode-drag-node');
            expect(cursor(line)).to.match(/cursor\/draw-connect-line/);
            expect(cursor(area)).to.match(/cursor\/draw-connect-line/);
        });

        test('targeted vertices use draw-connect-vertex cursor in draw modes', function() {
            behavior.attr('class', 'behavior-hover');
            vertex.classed('target', true);
            mode.attr('class', 'ideditor mode-draw-line');
            expect(cursor(vertex)).to.match(/cursor\/draw-connect-vertex/);
            mode.attr('class', 'ideditor mode-draw-area');
            expect(cursor(vertex)).to.match(/cursor\/draw-connect-vertex/);
            mode.attr('class', 'ideditor mode-add-line');
            expect(cursor(vertex)).to.match(/cursor\/draw-connect-vertex/);
            mode.attr('class', 'ideditor mode-add-area');
            expect(cursor(vertex)).to.match(/cursor\/draw-connect-vertex/);
            mode.attr('class', 'ideditor mode-drag-node');
            expect(cursor(vertex)).to.match(/cursor\/draw-connect-vertex/);
        });
    });
});


describe('rendererMap BetteriD interactions', function() {
    var container, context, surface;
    var pointerPrefix, PointerEventClass;

    function pointerEvent(type, options) {
        return new PointerEventClass(pointerPrefix + type, {
            bubbles: true,
            cancelable: true,
            view: jsdom.window,
            pointerId: 1,
            pointerType: 'mouse',
            ...options
        });
    }

    beforeEach(function() {
        pointerPrefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
        PointerEventClass = 'PointerEvent' in window ? PointerEvent : MouseEvent;
        iD.prefs('betterid.editing.right_drag', 'true');

        container = d3_select('body').append('div');
        context = iD.coreContext().assetPath('../dist/').init().container(container);
        container.append('div')
            .attr('class', 'main-map')
            .call(context.map());
        context.map().redrawEnable(false);
        surface = context.surface().node();
    });

    afterEach(function() {
        iD.prefs('betterid.editing.right_drag', null);
        iD.prefs('betterid.editing.snap_tolerance', null);
        iD.prefs('betterid.experimental.enabled', null);
        iD.prefs('betterid.experimental.wasd_navigation', null);
        iD.prefs('betterid.experimental.indoor_focus', null);
        iD.prefs('betterid.navigation.mode', null);
        iD.prefs('betterid.editing.adobe_shortcuts', null);
        vi.restoreAllMocks();
        container.remove();
    });

    it('pans with a right-button drag and suppresses its context menu', function() {
        const before = context.map().center();
        surface.dispatchEvent(pointerEvent('down', {
            button: 2, buttons: 2, clientX: 100, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('move', {
            button: 2, buttons: 2, clientX: 125, clientY: 110
        }));
        window.dispatchEvent(pointerEvent('up', {
            button: 2, buttons: 0, clientX: 125, clientY: 110
        }));

        expect(context.map().center()).not.toEqual(before);
        expect(context.map().isTransformed()).toBe(false);

        const menuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        expect(surface.dispatchEvent(menuEvent)).toBe(false);
        expect(menuEvent.defaultPrevented).toBe(true);
    });

    it('does not suppress the context menu for a short right click', function() {
        surface.dispatchEvent(pointerEvent('down', {
            button: 2, buttons: 2, clientX: 100, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('up', {
            button: 2, buttons: 0, clientX: 100, clientY: 100
        }));

        const menuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        expect(surface.dispatchEvent(menuEvent)).toBe(true);
        expect(menuEvent.defaultPrevented).toBe(false);
    });

    it('resets a transformed map when the pointer is released on window', function() {
        surface.dispatchEvent(pointerEvent('down', {
            button: 0, buttons: 1, clientX: 100, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('move', {
            button: 0, buttons: 1, clientX: 125, clientY: 110
        }));
        expect(context.map().isTransformed()).toBe(true);

        window.dispatchEvent(pointerEvent('up', {
            button: 0, buttons: 0, clientX: 125, clientY: 110
        }));
        expect(context.map().isTransformed()).toBe(false);
    });
    it('resets a transformed map on pointer cancellation', function() {
        surface.dispatchEvent(pointerEvent('down', {
            button: 0, buttons: 1, clientX: 100, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('move', {
            button: 0, buttons: 1, clientX: 125, clientY: 110
        }));
        expect(context.map().isTransformed()).toBe(true);

        const cancel = new Event('pointercancel', { bubbles: true, cancelable: true });
        if ('PointerEvent' in window) {
            Object.defineProperty(cancel, 'pointerId', { value: 1 });
        }
        window.dispatchEvent(cancel);

        expect(context.map().isTransformed()).toBe(false);
    });

    it('uses the configured snap tolerance as the right-drag threshold', function() {
        iD.prefs('betterid.editing.snap_tolerance', '30');
        const before = context.map().center();

        surface.dispatchEvent(pointerEvent('down', {
            button: 2, buttons: 2, clientX: 100, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('move', {
            button: 2, buttons: 2, clientX: 110, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('up', {
            button: 2, buttons: 0, clientX: 110, clientY: 100
        }));
        expect(context.map().center()).toEqual(before);

        iD.prefs('betterid.editing.snap_tolerance', '2');
        surface.dispatchEvent(pointerEvent('down', {
            button: 2, buttons: 2, clientX: 100, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('move', {
            button: 2, buttons: 2, clientX: 110, clientY: 100
        }));
        window.dispatchEvent(pointerEvent('up', {
            button: 2, buttons: 0, clientX: 110, clientY: 100
        }));
        expect(context.map().center()).not.toEqual(before);
    });

    it('shows and hides the indoor-focus status line', function() {
        const status = () => container.select('.betterid-map-status');

        // indoor focus off: hidden
        context.map().redrawEnable(true);
        context.map().pan([0, 0]);
        expect(status().attr('hidden')).not.toBeNull();

        // indoor focus on with an indoor feature selected: shows its levels
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.indoor_focus', 'true');
        const node = new iD.osmNode({ id: 'n-focus', loc: [0, 0], tags: { indoor: 'room', level: '1;2;3' } });
        context.perform(iD.actionAddEntity(node));
        context.enter(iD.modeSelect(context, [node.id]));
        context.map().pan([0, 0]);

        expect(status().attr('hidden')).toBeNull();
        // the spec harness has no general locale strings, so only assert that the
        // status line got content; the localized text is checked in the browser
        expect(status().text().length).toBeGreaterThan(0);
    });

    it('moves linearly at 1.6x speed with SD and stops on key release', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.navigation.mode', 'walk');

        let frame;
        const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback;
            return 1;
        });

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', cancelable: true }));
        expect(frame).toBeTypeOf('function');
        const before = context.projection.transform();
        frame(performance.now() + 100);  // elapsed time is capped at 50ms
        const after = context.projection.transform();
        expect(after.x - before.x).toBeCloseTo(-25.6, 6);  // 320px/s * 1.6 * 0.05s

        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }));
        expect(cancelFrame).toHaveBeenCalled();
        expect(context.map().isTransformed()).toBe(false);
    });

    it('keeps the W and A tap shortcuts when navigation is disabled', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'false');

        const shortcut = vi.fn();
        context.keybinding().on('A', shortcut);

        // A still reaches the mode keybinding (Continue)
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
        expect(shortcut).toHaveBeenCalledOnce();

        // W still toggles the area fill instead of being swallowed
        context.map().activeAreaFill('partial');
        const wEvent = new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true });
        document.dispatchEvent(wEvent);
        expect(context.map().activeAreaFill()).toBe('wireframe');
        expect(wEvent.defaultPrevented).toBe(true);
    });

    it('uses a short A release for shortcuts and a held A for movement', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.navigation.mode', 'walk');

        let frame;
        let holdCallback;
        const shortcut = vi.fn();
        context.keybinding().on('A', shortcut);
        vi.spyOn(window, 'setTimeout').mockImplementation(callback => {
            holdCallback = callback;
            return 1;
        });
        vi.spyOn(window, 'clearTimeout').mockImplementation(() => {});
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback;
            return 1;
        });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true, cancelable: true }));
        expect(shortcut).toHaveBeenCalledOnce();
        expect(frame).toBeUndefined();

        holdCallback = undefined;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
        expect(holdCallback).toBeTypeOf('function');
        holdCallback();
        expect(frame).toBeTypeOf('function');

        const before = context.projection.transform();
        frame(performance.now() + 100);
        expect(context.projection.transform().x).toBeGreaterThan(before.x);
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true, cancelable: true }));
        expect(shortcut).toHaveBeenCalledOnce();
        expect(context.map().isTransformed()).toBe(false);
    });

    it('uses a short selected D release for shortcuts and a held D for movement', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.navigation.mode', 'walk');

        const node = new iD.osmNode({ id: 'n-nav-d', loc: [0, 0] });
        context.perform(iD.actionAddEntity(node));
        context.enter(iD.modeSelect(context, [node.id]));

        let frame;
        let holdCallback;
        const shortcut = vi.fn();
        context.keybinding().on('D', shortcut);
        vi.spyOn(window, 'setTimeout').mockImplementation(callback => {
            holdCallback = callback;
            return 1;
        });
        vi.spyOn(window, 'clearTimeout').mockImplementation(() => {});
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback;
            return 1;
        });

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'd', bubbles: true, cancelable: true }));
        expect(shortcut).toHaveBeenCalledOnce();
        expect(frame).toBeUndefined();

        holdCallback = undefined;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }));
        expect(holdCallback).toBeTypeOf('function');
        holdCallback();
        expect(frame).toBeTypeOf('function');

        const before = context.projection.transform();
        frame(performance.now() + 100);
        expect(context.projection.transform().x).toBeLessThan(before.x);
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'd', bubbles: true, cancelable: true }));
        expect(shortcut).toHaveBeenCalledOnce();
        expect(context.map().isTransformed()).toBe(false);
    });

    it('moves immediately with Ctrl+Shift+WASD', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.navigation.mode', 'walk');

        let frame;
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback;
            return 1;
        });

        const event = new KeyboardEvent('keydown', {
            key: 'd',
            ctrlKey: true,
            shiftKey: true,
            cancelable: true
        });
        window.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(frame).toBeTypeOf('function');

        const before = context.projection.transform();
        frame(performance.now() + 100);
        expect(context.projection.transform().x).toBeLessThan(before.x);
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd', cancelable: true }));
        expect(context.map().isTransformed()).toBe(false);
    });

    it('delays S when JOSM shortcuts are enabled', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.editing.josm_shortcuts', 'true');

        let frame;
        let holdCallback;
        vi.spyOn(window, 'setTimeout').mockImplementation(callback => {
            holdCallback = callback;
            return 1;
        });
        vi.spyOn(window, 'clearTimeout').mockImplementation(() => {});
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback;
            return 1;
        });

        const before = context.projection.transform();
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 's',
            cancelable: true
        }));

        expect(holdCallback).toBeTypeOf('function');
        window.dispatchEvent(new KeyboardEvent('keyup', {
            key: 's',
            cancelable: true
        }));

        expect(frame).toBeUndefined();
        expect(context.projection.transform()).toEqual(before);
    });

    it('uses a short W release for wireframe and a held W for movement', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.navigation.mode', 'walk');
        context.map().activeAreaFill('partial');

        let frame;
        let holdCallback;
        vi.spyOn(window, 'setTimeout').mockImplementation(callback => {
            holdCallback = callback;
            return 1;
        });
        vi.spyOn(window, 'clearTimeout').mockImplementation(() => {});
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback;
            return 1;
        });

        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', cancelable: true }));
        expect(context.map().activeAreaFill()).toEqual('partial');
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', cancelable: true }));
        expect(context.map().activeAreaFill()).toEqual('wireframe');
        expect(frame).toBeUndefined();

        context.map().activeAreaFill('partial');
        holdCallback = undefined;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', cancelable: true }));
        expect(holdCallback).toBeTypeOf('function');
        holdCallback();
        expect(frame).toBeTypeOf('function');

        const before = context.map().center();
        frame(performance.now() + 100);
        expect(context.map().center()).not.toEqual(before);
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', cancelable: true }));
        expect(context.map().activeAreaFill()).toEqual('partial');
        expect(context.map().isTransformed()).toBe(false);
    });

    it('zooms on a short Shift press and preserves a held Shift', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');

        const zoomIn = vi.spyOn(context.map(), 'zoomIn').mockReturnValue(context.map());
        const shiftKeydown = vi.fn();
        document.addEventListener('keydown', shiftKeydown);
        let holdCallback;
        vi.spyOn(window, 'setTimeout').mockImplementation(callback => {
            holdCallback = callback;
            return 1;
        });
        vi.spyOn(window, 'clearTimeout').mockImplementation(() => {});

        const shiftDown = new KeyboardEvent('keydown', {
            key: 'Shift', shiftKey: true, bubbles: true, cancelable: true
        });
        document.dispatchEvent(shiftDown);
        expect(shiftDown.defaultPrevented).toBe(true);
        expect(zoomIn).not.toHaveBeenCalled();
        document.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Shift', bubbles: true, cancelable: true
        }));
        expect(zoomIn).toHaveBeenCalledOnce();
        expect(shiftKeydown).not.toHaveBeenCalled();

        holdCallback = undefined;
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Shift', shiftKey: true, bubbles: true, cancelable: true
        }));
        expect(holdCallback).toBeTypeOf('function');
        holdCallback();
        expect(shiftKeydown).toHaveBeenCalledOnce();
        expect(shiftKeydown.mock.calls[0][0].shiftKey).toBe(true);
        document.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Shift', bubbles: true, cancelable: true
        }));
        expect(zoomIn).toHaveBeenCalledOnce();

        document.removeEventListener('keydown', shiftKeydown);
    });

    it('zooms out once per Space press while navigation is enabled', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        // the Adobe shortcut layer owns Space when it is enabled
        iD.prefs('betterid.editing.adobe_shortcuts', 'false');

        const zoomOut = vi.spyOn(context.map(), 'zoomOut').mockReturnValue(context.map());
        const spaceDown = new KeyboardEvent('keydown', {
            key: ' ', code: 'Space', keyCode: 32, cancelable: true
        });
        window.dispatchEvent(spaceDown);
        expect(spaceDown.defaultPrevented).toBe(true);
        expect(zoomOut).toHaveBeenCalledOnce();
        window.dispatchEvent(new KeyboardEvent('keyup', {
            key: ' ', code: 'Space', keyCode: 32, cancelable: true
        }));
    });

    it('leaves Space to the Adobe hand tool when that layer is on', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.editing.adobe_shortcuts', 'true');

        const zoomOut = vi.spyOn(context.map(), 'zoomOut').mockReturnValue(context.map());
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: ' ', code: 'Space', keyCode: 32, cancelable: true
        }));
        expect(zoomOut).not.toHaveBeenCalled();
        window.dispatchEvent(new KeyboardEvent('keyup', {
            key: ' ', code: 'Space', keyCode: 32, cancelable: true
        }));
    });

    it('eases WASD fly mode and continues briefly after key release', function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.wasd_navigation', 'true');
        iD.prefs('betterid.navigation.mode', 'fly');

        let frame;
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
            frame = callback;
            return 1;
        });

        const start = performance.now();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', cancelable: true }));
        frame(start + 10);
        frame(start + 150);
        const atRelease = context.map().center();

        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }));
        frame(start + 170);
        expect(context.map().center()).not.toEqual(atRelease);

        frame(start + 600);
        expect(context.map().isTransformed()).toBe(false);
    });
    it('keeps the active indoor level above other floors without the experimental master switch', function() {
        iD.prefs('betterid.experimental.enabled', 'false');
        iD.prefs('betterid.experimental.indoor_focus', 'true');
        context.map().centerZoom([0, 0], 20);

        const selected = new iD.osmNode({
            id: 'n-indoor-selected',
            loc: [0, 0],
            tags: { indoor: 'room', level: '1' }
        });
        const sameLevel = new iD.osmNode({
            id: 'n-indoor-same',
            loc: [0.00001, 0],
            tags: { indoor: 'room', level: '1' }
        });
        const otherLevel = new iD.osmNode({
            id: 'n-indoor-other',
            loc: [0.00002, 0],
            tags: { indoor: 'room', level: '2' }
        });
        const corners = [
            new iD.osmNode({ id: 'n-building-1', loc: [-0.0001, -0.0001] }),
            new iD.osmNode({ id: 'n-building-2', loc: [0.0001, -0.0001] }),
            new iD.osmNode({ id: 'n-building-3', loc: [0.0001, 0.0001] }),
            new iD.osmNode({ id: 'n-building-4', loc: [-0.0001, 0.0001] })
        ];
        const building = new iD.osmWay({
            id: 'w-indoor-building',
            nodes: corners.map(node => node.id).concat(corners[0].id),
            tags: { building: 'yes' }
        });
        const focusedFloor = new iD.osmWay({
            id: 'w-indoor-focused-floor',
            nodes: building.nodes,
            tags: { area: 'yes', indoor: 'level', level: '1' }
        });
        const otherFloor = new iD.osmWay({
            id: 'w-indoor-other-floor',
            nodes: building.nodes,
            tags: { area: 'yes', indoor: 'level', level: '2' }
        });
        context.history().merge([
            selected, sameLevel, otherLevel, ...corners, building, focusedFloor, otherFloor
        ]);
        vi.spyOn(context, 'selectedIDs').mockReturnValue([selected.id]);

        const layer = d3_select(surface).select('.layer-osm');
        expect(layer.size()).toEqual(1);
        const selectedMark = layer.append('path').datum(selected);
        const sameLevelMark = layer.append('path').datum(sameLevel);
        const otherLevelMark = layer.append('path').datum(otherLevel);
        const buildingMark = layer.append('path').datum(building);

        context.map().redrawEnable(true);
        context.map().pan([0, 0]);

        const areaFill = d3_select(surface).select('.layer-osm.areas .area-fill');
        areaFill.append('path')
            .attr('class', `way area fill ${focusedFloor.id}`)
            .datum(focusedFloor);
        areaFill.append('path')
            .attr('class', `way area fill ${otherFloor.id}`)
            .datum(otherFloor);
        context.enter(iD.modeSelect(context, [selected.id]));

        expect(container.classed('betterid-indoor-focus')).toBe(true);
        expect(container.select('.main-map').classed('betterid-indoor-focus')).toBe(true);
        expect(selectedMark.classed('betterid-indoor-dim')).toBe(false);
        expect(sameLevelMark.classed('betterid-indoor-dim')).toBe(false);
        expect(buildingMark.classed('betterid-indoor-dim')).toBe(false);
        expect(otherLevelMark.classed('betterid-indoor-dim')).toBe(true);
        const floorOrder = areaFill.selectAll('path.area').nodes()
            .map(node => node.__data__.id)
            .filter(id => id === focusedFloor.id || id === otherFloor.id);
        expect(floorOrder).toEqual([otherFloor.id, focusedFloor.id]);

        iD.prefs('betterid.experimental.indoor_focus', 'false');
        expect(container.classed('betterid-indoor-focus')).toBe(false);
        expect(container.select('.main-map').classed('betterid-indoor-focus')).toBe(false);
        context.map().redrawEnable(false);
    });
});
