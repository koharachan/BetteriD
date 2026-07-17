import fetchMock from 'fetch-mock';
import { setTimeout } from 'node:timers/promises';
import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';


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

    it('uploads, previews, analyzes, and applies bilingual POI suggestions', async function() {
        const id = 'a'.repeat(64);
        const publicURL = `/api/osm-ai/photos/${id}.jpg`;
        fetchMock.mock('/api/osm-ai/photo-upload', {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                approved: true,
                id,
                url: publicURL,
                width: 640,
                height: 480,
                moderation: { reason_zh: '可用于核实招牌', reason_en: 'Suitable sign evidence' }
            })
        });
        fetchMock.mock('/api/osm-ai/photo-analyze', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                summary: { zh: '识别到一家商店', en: 'A shop was identified' },
                suggestions: [{
                    key: 'phone',
                    value: '+86 751 1234 5678',
                    confidence: 0.92,
                    reason: { zh: '号码显示在招牌上', en: 'The number is visible on the sign' }
                }]
            })
        });

        const entity = new iD.osmNode({ id: 'n123', loc: [113.6, 24.8], tags: { shop: 'yes' } });
        context.history().merge([entity]);
        vi.spyOn(context, 'selectedIDs').mockReturnValue([entity.id]);

        chooseFile(new File(['not decoded by mocked endpoint'], 'shop.png', { type: 'image/png' }));
        await setTimeout(30);

        const upload = JSON.parse(fetchMock.calls('/api/osm-ai/photo-upload')[0][1].body);
        expect(upload.image).toMatch(/^data:image\/png;base64,/);
        expect(upload.provider_order).toEqual(['openai', 'mimo']);
        expect(element.select('.local-photo-preview img').attr('src')).toEqual(publicURL);
        expect(element.select('.local-photo-preview a').attr('href')).toEqual(publicURL);
        expect(context.background().localPhoto().id).toEqual(id);

        element.select('.photo-analyze').dispatch('click');
        await setTimeout(30);

        const analysisRequest = JSON.parse(fetchMock.calls('/api/osm-ai/photo-analyze')[0][1].body);
        expect(analysisRequest.photo_id).toEqual(id);
        expect(analysisRequest.context.location[0]).toBeCloseTo(113.6, 8);
        expect(analysisRequest.context.location[1]).toBeCloseTo(24.8, 8);
        expect(analysisRequest.context.selected_tags).toEqual({ shop: 'yes' });
        expect(element.select('.photo-summary-zh').text()).toEqual('识别到一家商店');
        expect(element.select('.photo-summary-en').text()).toEqual('A shop was identified');
        expect(element.select('.reason-zh').text()).toEqual('号码显示在招牌上');
        expect(element.select('.reason-en').text()).toEqual('The number is visible on the sign');

        element.select('.photo-apply-tags').dispatch('click');
        expect(context.graph().entity(entity.id).tags.phone).toEqual('+86 751 1234 5678');
    });

    it('shows the bilingual moderation reason and does not retain rejected photos', async function() {
        fetchMock.mock('/api/osm-ai/photo-upload', {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                approved: false,
                error: 'Photo was rejected by the publication review',
                moderation: {
                    reason_zh: '图片不符合 OpenStreetMap 实地核实用途',
                    reason_en: 'The image is not suitable OSM survey evidence'
                }
            })
        });

        chooseFile(new File(['rejected by mocked endpoint'], 'rejected.webp', { type: 'image/webp' }));
        await setTimeout(30);

        expect(element.select('.local-photo-status').text())
            .toEqual('图片不符合 OpenStreetMap 实地核实用途');
        expect(element.select('.local-photo-background-controls').classed('has-photo')).toBe(false);
        expect(context.background().localPhoto()).toBeNull();
    });

    function chooseFile(file) {
        const input = element.select('#betterid-background-photo').node();
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
});
