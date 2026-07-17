import fetchMock from 'fetch-mock';
import { setTimeout } from 'node:timers/promises';
import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';

import { BETTERID_PREFS, setProviderOrder } from '../../../../modules/core/betterid_preferences';
import { prefs } from '../../../../modules/core/preferences';


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
        prefs(BETTERID_PREFS.searchOrder, null);
        prefs(BETTERID_PREFS.textOrder, null);
        d3_selectAll('.ui-wrap').remove();
    });


    it('requests web-backed tag suggestions with the selected entity context', async function() {
        setProviderOrder('search', ['kimi', 'openai']);
        setProviderOrder('text', ['mimo', 'deepseek', 'openai']);
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
        expect(request.provider_order).toEqual(['kimi', 'openai']);
        expect(request.text_provider_order).toEqual(['mimo', 'deepseek', 'openai']);
        expect(element.select('.ai-tag-proposed').text()).toEqual('building=school');
        expect(element.select('.ai-tag-source-links a').attr('href')).toEqual('https://example.com/school');
        expect(element.select('.ai-tag-web-badge').classed('hide')).toBe(false);
    });


    it('renders an unsourced fallback warning alongside usable suggestions', async function() {
        const warning = '网络搜索暂不可用，以下建议未经过网络检索，请人工核实。';
        fetchMock.mock('/api/osm-ai/tag-suggestions', {
            body: JSON.stringify({
                summary: '已根据输入信息生成未检索的建议。',
                suggestions: [{
                    key: 'building',
                    value: 'school',
                    confidence: 0.8,
                    reason: '<img src=x onerror=alert(1)>请人工核实',
                    sources: []
                }],
                sources: [],
                warnings: [warning]
            }),
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

        element.select('.ai-tag-input')
            .property('value', '补充学校建筑标签')
            .dispatch('input');
        element.select('.ai-tag-run').dispatch('click');
        await setTimeout(20);

        expect(element.select('.ai-tag-status-warning').text()).toEqual(warning);
        expect(element.select('.ai-tag-status-error').empty()).toBe(true);
        expect(element.select('.ai-tag-proposed').text()).toEqual('building=school');
        expect(element.select('.ai-tag-reason').text()).toContain('<img src=x onerror=alert(1)>');
        expect(element.select('.ai-tag-reason img').empty()).toBe(true);
        expect(element.selectAll('.ai-tag-source-links a').size()).toEqual(0);
        expect(element.select('.ai-tag-web-badge').classed('hide')).toBe(true);
    });


    it('bounds oversized model output before rendering it', async function() {
        assistant.tags(Object.fromEntries(
            Array.from({ length: 130 }, (_, index) => [`betterid:input:${index}`, `value-${index}`])
        ));
        fetchMock.mock('/api/osm-ai/tag-suggestions', {
            body: JSON.stringify({
                summary: '摘'.repeat(600),
                suggestions: Array.from({ length: 20 }, (_, index) => ({
                    key: `betterid:test:${index}`,
                    value: `value-${index}`,
                    confidence: 0.9,
                    reason: '理'.repeat(500)
                })),
                sources: Array.from({ length: 12 }, (_, index) => ({
                    title: `来源 ${index}`,
                    url: index ? `https://example.com/source/${index}` : 'data:text/html,not-a-source',
                    snippet: '片'.repeat(500)
                })),
                warnings: Array.from({ length: 12 }, (_, index) => `警告 ${index} ${'告'.repeat(300)}`)
            }),
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

        element.select('.ai-tag-input')
            .property('value', '返回很多搜索结果')
            .dispatch('input');
        element.select('.ai-tag-run').dispatch('click');
        await setTimeout(20);

        const request = JSON.parse(fetchMock.lastCall()[1].body);
        expect(Object.keys(request.tags)).toHaveLength(100);
        expect(element.selectAll('.ai-tag-suggestion').size()).toEqual(8);
        expect(element.selectAll('.ai-tag-sources a').size()).toEqual(4);
        expect(element.selectAll('.ai-tag-status-warning').size()).toEqual(4);
        expect(Array.from(element.select('.ai-tag-status-summary').text())).toHaveLength(300);
        expect(Array.from(element.select('.ai-tag-reason').text())).toHaveLength(240);
        expect(Array.from(element.select('.ai-tag-sources a').attr('title'))).toHaveLength(240);
        expect(element.select('.ai-tag-sources a').attr('href')).toMatch(/^https:/);
    });


    it('rejects image and metadata keys case-insensitively', async function() {
        const blockedKeys = [
            'image', 'IMAGE', 'Source:survey', 'TiGeR:cfcc', 'ODbL:note', 'Metadata:internal',
            'Created_By', 'Attribution', 'Import', 'TIMESTAMP', 'Version', 'changeset',
            'Uid', 'USER', 'Visible'
        ];
        fetchMock.mock('/api/osm-ai/tag-suggestions', {
            body: JSON.stringify({
                suggestions: [
                    ...blockedKeys.map(key => ({ key, value: 'blocked', confidence: 0.9 })),
                    { key: 'building', value: 'school', confidence: 0.9 }
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

        expect(element.selectAll('.ai-tag-suggestion').size()).toEqual(1);
        expect(element.select('.ai-tag-proposed').text()).toEqual('building=school');

        const changed = new Promise(resolve => {
            assistant.on('change', (entityIDs, tags) => resolve({ entityIDs, tags }));
        });
        element.select('.ai-tag-apply').dispatch('click');
        expect(await changed).toEqual({
            entityIDs: ['n12345'],
            tags: { building: 'school' }
        });
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
