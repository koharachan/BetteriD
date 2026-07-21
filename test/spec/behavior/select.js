import { setTimeout } from 'node:timers/promises';
import { select as d3_select } from 'd3-selection';

describe('iD.behaviorSelect', function() {
    var a, b, context, behavior, container;
    var originalMatchMedia = window.matchMedia;

    function simulateClick(el, o) {
        // clicks need to appear wherever the map is
        var mapNode = context.container().select('.main-map').node();
        var rect = mapNode.getBoundingClientRect();
        var click = { clientX: rect.left, clientY: rect.top };
        var down = new MouseEvent('mousedown', { bubbles: true, view: jsdom.window, ...click, ...o });
        var up = new MouseEvent('mouseup', { bubbles: true, view: jsdom.window, ...click, ...o });
        if (o && o.pointerType) {
            down.pointerType = o.pointerType;
            up.pointerType = o.pointerType;
        }
        el.dispatchEvent(down);
        el.dispatchEvent(up);
    }

    beforeEach(function() {
        container = d3_select('body').append('div');
        context = iD.coreContext().assetPath('../dist/').init().container(container);

        a = new iD.osmNode({loc: [0, 0]});
        b = new iD.osmNode({loc: [0, 0]});

        context.perform(iD.actionAddEntity(a), iD.actionAddEntity(b));

        container
            .append('div')
            .attr('class', 'main-map')
            .call(context.map())
            .append('div')
            .attr('class', 'inspector-wrap');

        context.surface().select('.data-layer.osm').selectAll('circle')
            .data([a, b])
            .enter().append('circle')
            .attr('class', function(d) { return d.id; });

        context.enter(iD.modeBrowse(context));

        behavior = iD.behaviorSelect(context);
        context.install(behavior);
    });

    afterEach(function() {
        window.matchMedia = originalMatchMedia;
        context.uninstall(behavior);
        context.mode().exit();
        container.remove();
    });

    it('refuses to enter select mode with no ids', function() {
        context.enter(iD.modeSelect(context, []));
        expect(context.mode().id, 'empty array').toEqual('browse');
        context.enter(iD.modeSelect(context, undefined));
        expect(context.mode().id, 'undefined').toEqual('browse');
    });

    it('refuses to enter select mode with nonexistent ids', function() {
        context.enter(iD.modeSelect(context, ['w-1']));
        expect(context.mode().id).toEqual('browse');
    });

    it('click on entity selects the entity', async () => {
        var el = context.surface().selectAll('.' + a.id).node();
        simulateClick(el, {});
        await setTimeout(50);
        expect(context.selectedIDs()).toEqual([a.id]);
    });

    it('click on empty space clears the selection', async () => {
        context.enter(iD.modeSelect(context, [a.id]));
        var el = context.surface().node();
        simulateClick(el, {});
        await setTimeout(50);
        expect(context.mode().id).toEqual('browse');
    });

    it('shift-click on unselected entity adds it to the selection', async () => {
        context.enter(iD.modeSelect(context, [a.id]));
        var el = context.surface().selectAll('.' + b.id).node();
        simulateClick(el, { shiftKey: true });
        await setTimeout(50);
        expect(context.selectedIDs()).toEqual([a.id, b.id]);
    });

    it('shift-click on selected entity removes it from the selection', async () => {
        context.enter(iD.modeSelect(context, [a.id, b.id]));
        var el = context.surface().selectAll('.' + b.id).node();
        simulateClick(el, { shiftKey: true });
        await setTimeout(50);
        expect(context.selectedIDs()).toEqual([a.id]);
    });

    it('shift-click on last selected entity clears the selection', async () => {
        context.enter(iD.modeSelect(context, [a.id]));
        var el = context.surface().selectAll('.' + a.id).node();
        simulateClick(el, { shiftKey: true });
        await setTimeout(50);
        expect(context.mode().id).toEqual('browse');
    });

    it('shift-click on empty space leaves the selection unchanged', async () => {
        context.enter(iD.modeSelect(context, [a.id]));
        var el = context.surface().node();
        simulateClick(el, { shiftKey: true });
        await setTimeout(50);
        expect(context.selectedIDs()).toEqual([a.id]);
    });

    it('adds to the selection on a mobile tap', async () => {
        window.matchMedia = () => ({ matches: true });
        context.enter(iD.modeSelect(context, [a.id]));

        var el = context.surface().selectAll('.' + b.id).node();
        simulateClick(el, { pointerType: 'touch' });
        await setTimeout(50);
        expect(context.selectedIDs()).toEqual([a.id, b.id]);
    });

    it('starts rotate mode on Ctrl+Shift drag from a selected feature', function() {
        context.map().dimensions([1000, 1000]);
        context.map().centerZoom([0, 0], 20);
        context.enter(iD.modeSelect(context, [a.id, b.id]));

        var el = context.surface().selectAll('.' + a.id).node();
        var prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
        var event = prefix === 'pointer' ?
            new PointerEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                button: 0,
                ctrlKey: true,
                shiftKey: true
            }) :
            new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                button: 0,
                ctrlKey: true,
                shiftKey: true
            });

        el.dispatchEvent(event);
        expect(context.mode().id).toEqual('rotate');
    });
});
