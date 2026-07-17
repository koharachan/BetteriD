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


describe('iD.uiSectionPresetFields', function() {
    let context, element, section;

    beforeEach(function() {
        context = iD.coreContext().assetPath('../dist/').init();
        const entityA = new iD.osmNode({
            id: 'n100',
            loc: [113.6, 24.8],
            tags: { amenity: 'restaurant', image: 'https://example.com/a.jpg' }
        });
        const entityB = new iD.osmNode({
            id: 'n200',
            loc: [113.7, 24.9],
            tags: { shop: 'bakery', image: 'https://example.com/b.jpg' }
        });
        context.history().merge([entityA, entityB]);

        const image = iD.presetField('image', {
            key: 'image',
            type: 'url',
            geometry: ['point']
        });
        const preset = {
            fields: () => [image],
            moreFields: () => []
        };
        section = iD.uiSectionPresetFields(context)
            .entityIDs([entityA.id])
            .presets([preset])
            .tags(entityA.tags)
            .expandedByDefault(true);
        element = d3_select('body')
            .append('div')
            .attr('class', 'preset-fields-test')
            .call(section.render);
    });

    afterEach(function() {
        vi.restoreAllMocks();
        d3_selectAll('.preset-fields-test').remove();
    });

    it('disposes a pending image upload when the section switches entities', async function() {
        const requests = installDelayedFetch();
        const changed = vi.fn((field, entityIDs, tags) => {
            const entity = context.graph().entity(entityIDs[0]);
            context.perform(iD.actionChangeTags(entity.id, { ...entity.tags, ...tags }));
        });
        section.on('change.test', changed);

        chooseFile(new File(['pending'], 'pending.jpg', { type: 'image/jpeg' }));
        await waitFor(() => expect(requests).toHaveLength(1));

        const entityB = context.graph().entity('n200');
        section.entityIDs([entityB.id]).tags(entityB.tags);
        expect(requests[0].options.signal.aborted).toBe(true);
        section.reRender();

        requests[0].resolve(uploadResponse('a'));
        await setTimeout(20);

        expect(changed).not.toHaveBeenCalled();
        expect(context.graph().entity('n100').tags.image).toEqual('https://example.com/a.jpg');
        expect(context.graph().entity('n200').tags.image).toEqual('https://example.com/b.jpg');
        expect(element.select('.image-upload-tools').classed('has-upload')).toBe(false);
    });

    function chooseFile(file) {
        const input = element.select('.image-upload-tools input[type="file"]').node();
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function installDelayedFetch() {
        const requests = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
            let resolve;
            const promise = new Promise(res => { resolve = res; });
            requests.push({ url: String(url), options, promise, resolve });
            return promise;
        });
        return requests;
    }

    function uploadResponse(character) {
        const id = character.repeat(64);
        return {
            ok: true,
            status: 201,
            json: () => Promise.resolve({
                approved: true,
                id,
                url: `/api/osm-ai/photos/${id}.jpg`
            })
        };
    }
});
