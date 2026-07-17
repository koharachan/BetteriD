import fetchMock from 'fetch-mock';
import { setTimeout } from 'node:timers/promises';
import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';

async function waitFor(check, timeout = 2000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try {
            return check();
        } catch (error) {
            lastError = error;
        }
        await setTimeout(10);
    }
    throw lastError;
}


describe('iD.uiSectionExperimentalBackground', function() {
    let container, context, element, section;

    beforeEach(function() {
        iD.prefs('betterid.experimental.enabled', 'true');
        iD.prefs('betterid.experimental.dual_imagery', 'false');
        iD.prefs('betterid.experimental.local_photo', 'true');
        fetchMock.reset();

        container = d3_select('body').append('div');
        context = iD.coreContext().assetPath('../dist/').init().container(container);
        container.append('div')
            .attr('class', 'main-map')
            .call(context.map());
        context.map().dimensions([1000, 800]).centerZoom([113.6, 24.8], 18);
        section = iD.uiSectionExperimentalBackground(context).expandedByDefault(true);
        element = d3_select('body')
            .append('div')
            .attr('class', 'ui-wrap')
            .call(section.render);
    });

    afterEach(function() {
        fetchMock.reset();
        iD.prefs('betterid.experimental.enabled', null);
        iD.prefs('betterid.experimental.dual_imagery', null);
        iD.prefs('betterid.experimental.local_photo', null);
        iD.prefs('betterid.background.secondary_opacity', null);
        container.remove();
        d3_selectAll('.ui-wrap').remove();
        vi.restoreAllMocks();
    });

    it('preserves zero secondary imagery opacity across renders', function() {
        iD.prefs('betterid.background.secondary_opacity', '0');
        iD.prefs('betterid.experimental.dual_imagery', 'true');
        section.reRender();

        expect(context.background().secondaryOpacity()).toEqual(0);
        expect(element.select('.dual-imagery-controls input[type="range"]').property('value')).toEqual('0');
        expect(element.select('.dual-imagery-controls output').text()).toEqual('0%');
    });

    it('opens and previews a local photo without uploading or analyzing it', async function() {
        chooseFile(new File(['local pixels'], 'survey.png', { type: 'image/png' }));
        await waitFor(() => expect(context.background().localPhoto()).not.toBeNull());

        const photo = context.background().localPhoto();
        expect(photo.id).toMatch(/^local-/);
        expect(photo.url).toMatch(/^data:image\/png;base64,/);
        expect(element.select('.local-photo-preview img').attr('src')).toEqual(photo.url);
        expect(element.select('.local-photo-background-controls').classed('has-photo')).toBe(true);
        expect(element.select('.local-photo-preview a').empty()).toBe(true);
        expect(element.select('.photo-analyze').empty()).toBe(true);
        expect(fetchMock.calls('/api/osm-ai/photo-upload')).toHaveLength(0);
        expect(fetchMock.calls('/api/osm-ai/photo-analyze')).toHaveLength(0);

        element.select('.photo-remove').dispatch('click');
        expect(context.background().localPhoto()).toBeNull();
    });

    it('rejects an unsupported local file without contacting photo services', function() {
        chooseFile(new File(['not a photo'], 'notes.txt', { type: 'text/plain' }));

        expect(element.select('.local-photo-status').text())
            .toEqual(iD.localizer.t('background.experimental.invalid_photo'));
        expect(element.select('.local-photo-background-controls').classed('has-photo')).toBe(false);
        expect(context.background().localPhoto()).toBeNull();
        expect(fetchMock.calls('/api/osm-ai/photo-upload')).toHaveLength(0);
        expect(fetchMock.calls('/api/osm-ai/photo-analyze')).toHaveLength(0);
    });

    function chooseFile(file) {
        const input = element.select('#betterid-background-photo').node();
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
});
