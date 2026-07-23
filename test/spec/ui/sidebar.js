import { select as d3_select } from 'd3-selection';
import { setTimeout } from 'node:timers/promises';
import { timerFlush as d3_timerFlush } from 'd3-timer';


describe('iD.uiSidebar', function() {
    var originalMatchMedia = window.matchMedia;

    afterEach(function() {
        window.matchMedia = originalMatchMedia;
        d3_select(document.body).selectAll('.sidebar-test-container').remove();
    });

    it('renders and can close an existing feature editor on mobile', async () => {
        await iD.presetManager.ensureLoaded(true);
        window.matchMedia = () => ({ matches: true });

        const container = d3_select(document.body)
            .append('div')
            .attr('class', 'sidebar-test-container');
        const selection = container
            .append('div')
            .attr('class', 'sidebar');
        const context = iD.coreContext().assetPath('../dist/').init().container(container);
        context.connection = () => ({
            historyURL: () => 'https://www.openstreetmap.org/node/1/history',
            isDataLoaded: () => true,
            maxWayNodes: () => 2000,
            noteURL: () => 'https://www.openstreetmap.org/note/1',
            on: vi.fn()
        });
        container
            .append('div')
            .attr('class', 'main-map')
            .call(context.map());
        const sidebar = iD.uiSidebar(context);
        const ui = context.ui();
        ui.sidebar = sidebar;
        ui.onResize = vi.fn();

        context.history().merge([
            new iD.osmNode({ id: 'n1', loc: [0, 0], tags: { amenity: 'cafe' } })
        ]);

        selection.call(sidebar);
        expect(selection.classed('collapsed')).toBe(true);

        sidebar.select(['n1'], false);

        expect(selection.classed('collapsed')).toBe(false);
        expect(selection.select('.entity-editor-pane .header').empty()).toBe(false);

        selection.select('.entity-editor-pane .header button.close').node().click();
        await setTimeout(300);
        d3_timerFlush();

        expect(context.mode().id).toBe('browse');
        expect(selection.classed('collapsed')).toBe(true);
    });
});
