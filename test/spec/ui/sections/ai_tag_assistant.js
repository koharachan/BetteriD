import fetchMock from 'fetch-mock';
import { setTimeout } from 'node:timers/promises';
import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';


describe('iD.uiSectionAiTagAssistant', function() {
    let assistant, context, element, entity;

    function render(tags = entity.tags) {
        assistant = iD.uiSectionAiTagAssistant(context)
            .entityIDs([entity.id])
            .tags(tags)
            .state('select')
            .expandedByDefault(true);

        element = d3_select('body')
            .append('div')
            .attr('class', 'ui-wrap')
            .call(assistant.render);
    }

    beforeEach(function() {
        entity = new iD.osmNode({
            id: 'n12345',
            loc: [113.598, 24.815],
            tags: { amenity: 'school', name: '测试学校' }
        });
        context = iD.coreContext().assetPath('../dist/').init();
        context.history().merge([entity]);
        fetchMock.reset();
        render();
    });

    afterEach(function() {
        fetchMock.reset();
        d3_selectAll('.ui-wrap').remove();
    });


    it('requests web-backed tag suggestions with the selected entity context', async function() {
        fetchMock.mock('/api/osm-ai/tag-suggestions', {
            body: JSON.stringify({
                summary: '根据学校官网补充建筑用途。',
                suggestions: [{
                    key: 'building',
                    value: 'school',
                    confidence: 0.9,
                    reason: '官网将其标为教学楼。'
                }],
                sources: [{ title: '学校官网', url: 'https://example.com/school' }]
            }),
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

        element.select('.ai-tag-input')
            .property('value', '这是学校教学楼，请搜索官网并建议标签')
            .dispatch('input');
        element.select('.ai-tag-run').dispatch('click');
        await setTimeout(20);

        const request = JSON.parse(fetchMock.lastCall()[1].body);
        expect(request.description).toContain('学校教学楼');
        expect(request.tags).toEqual({ amenity: 'school', name: '测试学校' });
        expect(request.geometry).toEqual('point');
        expect(request.location).toEqual({ lon: 113.598, lat: 24.815 });
        expect(request.web_search).toBeTruthy();
        expect(element.select('.ai-tag-proposed').text()).toEqual('building=school');
        expect(element.select('.ai-tag-source-links a').attr('href')).toEqual('https://example.com/school');
    });


    it('applies only selected changes and drops unchanged suggestions', async function() {
        fetchMock.mock('/api/osm-ai/tag-suggestions', {
            body: JSON.stringify({
                suggestions: [
                    { key: 'amenity', value: 'school', confidence: 0.9 },
                    { key: 'building', value: 'school', confidence: 0.9 },
                    { key: 'opening_hours', value: 'Mo-Fr 08:00-17:00', confidence: 0.1 }
                ]
            }),
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

        element.select('.ai-tag-input')
            .property('value', '补充学校标签')
            .dispatch('input');
        element.select('.ai-tag-run').dispatch('click');
        await setTimeout(20);

        expect(element.selectAll('.ai-tag-suggestion').size()).toEqual(2);
        expect(element.selectAll('.ai-tag-suggestion input').nodes().map(node => node.checked)).toEqual([true, false]);

        const changed = new Promise(resolve => {
            assistant.on('change', (entityIDs, tags) => resolve({ entityIDs, tags }));
        });
        element.select('.ai-tag-apply').dispatch('click');

        expect(await changed).toEqual({
            entityIDs: ['n12345'],
            tags: { building: 'school' }
        });
    });
});
