import { select as d3_select } from 'd3-selection';

import { behaviorBetteridPen } from '../../../modules/behavior/betterid_pen';
import {
    BETTERID_TOOL_PREF, BETTERID_PEN_SNAPPING_PREF, BETTERID_PEN_TOLERANCE_PREF
} from '../../../modules/core/betterid_tools';
import { prefs } from '../../../modules/core/preferences';


describe('behaviorBetteridPen', function() {
    const prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
    let container, context, behavior, mapNode;

    beforeEach(function() {
        container = d3_select('body').append('div').attr('class', 'ideditor');
        context = iD.coreContext().assetPath('../dist/').init().container(container);
        container.append('div').attr('class', 'main-map').call(context.map());
        mapNode = container.select('.main-map').node();
        context.map().dimensions([1000, 1000]);
        context.map().centerZoom([0, 0], 18);
        context.enter(iD.modeBrowse(context));

        prefs(BETTERID_TOOL_PREF, 'pen');
        behavior = behaviorBetteridPen(context);
        context.install(behavior);
    });

    afterEach(function() {
        context.uninstall(behavior);
        prefs(BETTERID_TOOL_PREF, null);
        prefs(BETTERID_PEN_SNAPPING_PREF, null);
        prefs(BETTERID_PEN_TOLERANCE_PREF, null);
        container.remove();
    });


    function pointerEvent(type, x, y, options) {
        const init = Object.assign({
            bubbles: true,
            cancelable: true,
            view: typeof jsdom !== 'undefined' ? jsdom.window : window,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type.endsWith('up') ? 0 : 1
        }, options || {});
        const Ctor = prefix === 'pointer' && window.PointerEvent ? window.PointerEvent : MouseEvent;
        const event = new Ctor(type, init);
        if (prefix === 'pointer') {
            try { Object.defineProperty(event, 'pointerType', { value: 'mouse' }); } catch { /* ignore */ }
            try { Object.defineProperty(event, 'pointerId', { value: 1 }); } catch { /* ignore */ }
        }
        return event;
    }

    function down(x, y, options, target) {
        (target || mapNode).dispatchEvent(pointerEvent(prefix + 'down', x, y, options));
    }

    function move(x, y, options) {
        mapNode.dispatchEvent(pointerEvent(prefix + 'move', x, y, options));
    }

    function up(x, y, options) {
        mapNode.dispatchEvent(pointerEvent(prefix + 'up', x, y, options));
    }

    function click(x, y, options, target) {
        down(x, y, options, target);
        up(x, y, options);
    }

    function drag(from, to, options) {
        down(from[0], from[1], options);
        move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, options);
        move(to[0], to[1], options);
        up(to[0], to[1], options);
    }

    function key(name, options) {
        window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: name, bubbles: true, cancelable: true }, options || {})));
    }

    function newWays() {
        return context.history().difference().created().filter(e => e.type === 'way');
    }

    /** A rendered touch target the way iD draws them, so the pen can snap to it. */
    function targetElement(entity) {
        const element = context.surface().append('circle').node();
        element.__data__ = { type: 'Feature', properties: { target: true, entity: entity } };
        return element;
    }


    it('turns two clicks and Enter into a two-node line', function() {
        click(100, 100);
        click(300, 100);
        expect(behavior.anchors()).toHaveLength(2);

        key('Enter');

        const ways = newWays();
        expect(ways).toHaveLength(1);
        expect(ways[0].nodes).toHaveLength(2);
        expect(ways[0].tags).toEqual({});
        expect(context.mode().id).toEqual('select');
        expect(context.selectedIDs()).toEqual([ways[0].id]);
        expect(context.history().undoAnnotation()).toEqual('Started a line.');
        expect(behavior.anchors()).toHaveLength(0);
    });


    it('adds nodes along a dragged (smooth) anchor but none along straight runs', function() {
        click(100, 300);
        drag([300, 100], [420, 100]);     // smooth point, handle to the right
        click(500, 300);
        click(900, 300);                  // straight run: no extra nodes
        key('Enter');

        const way = newWays()[0];
        const locs = way.nodes.map(id => context.projection(context.entity(id).loc));
        expect(way.nodes.length).toBeGreaterThan(4);

        // every in-between node sits on the curved part, left of x=500
        const between = locs.slice(1, -1).filter(p => p[0] > 505 && p[0] < 895);
        expect(between).toHaveLength(0);
    });


    it('closes the path on the first anchor and makes an area', function() {
        click(100, 100);
        click(300, 100);
        click(300, 300);
        click(100, 100);                  // back on the first anchor

        const ways = newWays();
        expect(ways).toHaveLength(1);
        expect(ways[0].isClosed()).toBe(true);
        expect(ways[0].tags).toEqual({ area: 'yes' });
        expect(ways[0].nodes).toHaveLength(4);
        expect(context.history().undoAnnotation()).toEqual('Started an area.');
    });


    it('finishes (not discards) on Escape', function() {
        click(100, 100);
        click(200, 150);
        key('Escape');
        expect(newWays()).toHaveLength(1);
    });


    it('removes the last anchor with Backspace and with Ctrl+Z while drawing', function() {
        click(100, 100);
        click(200, 100);
        click(300, 100);
        key('Backspace');
        expect(behavior.anchors()).toHaveLength(2);
        key('z', { ctrlKey: true });
        expect(behavior.anchors()).toHaveLength(1);
        // nothing was committed to the editor's history by the pen's own undo
        expect(context.history().difference().created()).toHaveLength(0);
    });


    it('does not place a duplicate anchor on the second click of a double click', function() {
        click(100, 100);
        click(300, 100);
        click(301, 101);                  // the second half of a double click
        mapNode.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 301, clientY: 101 }));

        const ways = newWays();
        expect(ways).toHaveLength(1);
        expect(ways[0].nodes).toHaveLength(2);
    });


    it('constrains a Shift+click to 45 degree steps', function() {
        click(100, 100);
        click(300, 112, { shiftKey: true });
        const anchors = behavior.anchors();
        const a = context.projection(anchors[0].loc);
        const b = context.projection(anchors[1].loc);
        expect(Math.abs(b[1] - a[1])).toBeLessThan(0.01);
    });


    it('deletes a middle anchor on click and inserts one on the path', function() {
        click(100, 100);
        click(300, 100);
        click(500, 100);
        expect(behavior.anchors()).toHaveLength(3);

        click(300, 100);                  // auto-delete
        expect(behavior.anchors()).toHaveLength(2);

        click(300, 101);                  // auto-add on the straight segment
        const anchors = behavior.anchors();
        expect(anchors).toHaveLength(3);
        const inserted = context.projection(anchors[1].loc);
        expect(inserted[0]).toBeCloseTo(300, 0);
    });


    it('clicking the current anchor drops its forward handle only', function() {
        click(100, 100);
        drag([300, 100], [400, 160]);
        let last = behavior.anchors()[1];
        expect(last.handleIn).toBeTruthy();
        expect(last.handleOut).toBeTruthy();

        click(300, 100);
        last = behavior.anchors()[1];
        expect(last.handleIn).toBeTruthy();
        expect(last.handleOut).toBeNull();
    });


    it('reuses an existing node when the click lands on its touch target', function() {
        const node = new iD.osmNode({ loc: context.projection.invert([500, 500]) });
        context.perform(iD.actionAddEntity(node));

        click(100, 100);
        click(500, 500, {}, targetElement(node));
        key('Enter');

        const way = newWays()[0];
        expect(way.nodes).toHaveLength(2);
        expect(way.nodes[1]).toEqual(node.id);
        // the pen created one node (the first anchor) plus the way
        const created = context.history().difference().created();
        expect(created.filter(e => e.type === 'node')).toHaveLength(2);   // `node` itself + the anchor
    });


    it('inserts the new node into a way it was snapped on', function() {
        const a = new iD.osmNode({ loc: context.projection.invert([400, 600]) });
        const b = new iD.osmNode({ loc: context.projection.invert([600, 600]) });
        const road = new iD.osmWay({ nodes: [a.id, b.id], tags: { highway: 'residential' } });
        context.perform(iD.actionAddEntity(a), iD.actionAddEntity(b), iD.actionAddEntity(road));

        click(500, 100);
        click(500, 600, {}, targetElement(road));
        key('Enter');

        const way = newWays().find(w => w.id !== road.id);
        expect(way.nodes).toHaveLength(2);
        const joint = way.nodes[1];
        expect(context.entity(road.id).nodes).toEqual([a.id, joint, b.id]);
        const loc = context.projection(context.entity(joint).loc);
        expect(loc[0]).toBeCloseTo(500, 0);
        expect(loc[1]).toBeCloseTo(600, 0);
    });


    it('does not snap while Alt is held or when snapping is off', function() {
        const node = new iD.osmNode({ loc: context.projection.invert([500, 500]) });
        context.perform(iD.actionAddEntity(node));

        click(100, 100);
        click(500, 500, { altKey: true }, targetElement(node));
        expect(behavior.anchors()[1].nodeID).toBeNull();
        key('Escape');

        prefs(BETTERID_PEN_SNAPPING_PREF, 'false');
        click(100, 100);
        click(500, 500, {}, targetElement(node));
        expect(behavior.anchors()[1].nodeID).toBeNull();
    });


    it('commits the drawing when another tool is chosen', function() {
        click(100, 100);
        click(200, 200);
        prefs(BETTERID_TOOL_PREF, 'select');
        expect(newWays()).toHaveLength(1);
        expect(behavior.anchors()).toHaveLength(0);
    });


    it('ignores the map while the hand tool (Space) is held', function() {
        context.container().classed('betterid-hand-tool', true);
        click(100, 100);
        expect(behavior.anchors()).toHaveLength(0);
    });
});
