import fetchMock from 'fetch-mock';
import { setTimeout } from 'node:timers/promises';
import { select as d3_select } from 'd3-selection';


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


describe('iD.uiFieldImage', function() {
    let context, entity, selection, imageField;

    beforeEach(function() {
        fetchMock.reset();
        context = iD.coreContext().assetPath('../dist/').init();
        entity = new iD.osmNode({
            id: 'n123',
            loc: [113.6, 24.8],
            tags: { amenity: 'restaurant', image: 'https://example.com/original.jpg' }
        });
        context.history().merge([entity]);
        vi.spyOn(context.map(), 'center').mockReturnValue([113.6, 24.8]);
        vi.spyOn(context.validator(), 'validate').mockImplementation(() => {});

        const field = iD.presetField('image', { key: 'image', type: 'url' });
        let locked = false;
        field.locked = function(value) {
            if (!arguments.length) return locked;
            locked = value;
            return field;
        };
        field.domId = 'form-field-image-test';
        imageField = iD.uiFieldImage(field, context)
            .entityIDs([entity.id])
            .on('change.apply', changed => {
                const current = context.graph().entity(imageField.entityIDs()[0]);
                context.perform(iD.actionChangeTags(current.id, { ...current.tags, ...changed }));
            });
        selection = d3_select(document.createElement('div'));
        selection.call(imageField);
        imageField.tags(entity.tags);
    });

    afterEach(function() {
        vi.restoreAllMocks();
        fetchMock.reset();
    });

    it('is selected by uiField for image URL fields', function() {
        const field = iD.presetField('image', { key: 'image', type: 'url' });
        const rendered = d3_select(document.createElement('div'));

        iD.uiField(context, field, [entity.id], { show: true })
            .tags(entity.tags)
            .render(rendered);

        expect(rendered.select('.image-upload-tools').empty()).toBe(false);
    });

    it('writes an absolute public URL after approval', async function() {
        const id = 'a'.repeat(64);
        const onChange = vi.fn();
        imageField.on('change.test', onChange);
        mockUpload({
            status: 201,
            body: { approved: true, id, url: `/api/osm-ai/photos/${id}.jpg` }
        });

        chooseFile(new File(['approved'], 'restaurant.png', { type: 'image/png' }));
        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

        const expectedURL = new URL(`/api/osm-ai/photos/${id}.jpg`, window.location.origin).href;
        expect(onChange).toHaveBeenCalledWith({ image: expectedURL });
        expect(context.graph().entity(entity.id).tags.image).toEqual(expectedURL);
        expect(selection.select('.image-upload-preview img').attr('src')).toEqual(expectedURL);
    });

    it('keeps the existing image unchanged when moderation rejects the upload', async function() {
        const onChange = vi.fn();
        imageField.on('change.test', onChange);
        mockUpload({
            status: 422,
            body: {
                approved: false,
                error: 'Photo rejected',
                moderation: { reason_en: 'Not suitable OSM evidence' }
            }
        });

        chooseFile(new File(['rejected'], 'restaurant.webp', { type: 'image/webp' }));
        await waitFor(() => expect(selection.select('.image-upload-status').text())
            .toEqual('Not suitable OSM evidence'));

        expect(onChange).not.toHaveBeenCalled();
        expect(context.graph().entity(entity.id).tags.image).toEqual('https://example.com/original.jpg');
        expect(selection.select('.image-upload-tools').classed('has-upload')).toBe(false);
    });

    it('filters image suggestions and applies only suggestions selected by the user', async function() {
        const id = 'b'.repeat(64);
        mockUpload({
            status: 201,
            body: { approved: true, id, url: `/api/osm-ai/photos/${id}.jpg` }
        });
        fetchMock.mock('/api/osm-ai/photo-analyze', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                summary: { zh: '餐厅招牌', en: 'Restaurant sign' },
                suggestions: [
                    { key: 'image', value: 'https://attacker.example/replacement.jpg', confidence: 1 },
                    { key: 'cuisine', value: 'burger', confidence: 0.95 },
                    { key: 'name', value: 'Example Restaurant', confidence: 0.4 },
                    { key: 'phone', value: '+86 751 1234 5678', confidence: 0.9 }
                ]
            })
        });

        chooseFile(new File(['approved'], 'restaurant.jpg', { type: 'image/jpeg' }));
        await waitForUpload();
        selection.select('.image-analyze').dispatch('click');
        await waitFor(() => expect(selection.selectAll('.photo-analysis-result li').size()).toEqual(3));

        expect(selection.selectAll('.photo-analysis-result code').nodes().map(node => node.textContent))
            .toEqual([
                'cuisine=burger',
                'name=Example Restaurant',
                'phone=+86 751 1234 5678'
            ]);

        const checkboxes = selection.selectAll('.photo-analysis-result input[type="checkbox"]').nodes();
        expect(checkboxes.map(node => node.checked)).toEqual([true, false, true]);
        checkboxes[0].checked = false;
        d3_select(checkboxes[0]).dispatch('change');
        checkboxes[1].checked = true;
        d3_select(checkboxes[1]).dispatch('change');

        selection.select('.photo-apply-tags').dispatch('click');
        const updated = context.graph().entity(entity.id).tags;
        const uploadedURL = new URL(`/api/osm-ai/photos/${id}.jpg`, window.location.origin).href;
        expect(updated).toEqual({
            amenity: 'restaurant',
            image: uploadedURL,
            name: 'Example Restaurant',
            phone: '+86 751 1234 5678'
        });
        expect(updated.image).not.toEqual('https://attacker.example/replacement.jpg');
        expect(updated.cuisine).toBeUndefined();
    });

    it('ignores a delayed upload after switching entities', async function() {
        const requests = installDelayedFetch();
        const onChange = vi.fn();
        imageField.on('change.test', onChange);
        const other = new iD.osmNode({
            id: 'n456',
            loc: [113.7, 24.9],
            tags: { shop: 'bakery', image: 'https://example.com/bakery.jpg' }
        });
        context.history().merge([other]);

        chooseFile(new File(['first'], 'first.jpg', { type: 'image/jpeg' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        imageField.entityIDs([other.id]).tags(other.tags);

        expect(requests[0].options.signal.aborted).toBe(true);
        requests[0].resolve(uploadResponse('c'));
        await setTimeout(20);

        expect(onChange).not.toHaveBeenCalled();
        expect(context.graph().entity(entity.id).tags.image).toEqual('https://example.com/original.jpg');
        expect(context.graph().entity(other.id).tags.image).toEqual('https://example.com/bakery.jpg');
        expect(selection.select('.image-upload-tools').classed('has-upload')).toBe(false);
    });

    it('keeps the newest upload when two images finish out of order', async function() {
        const requests = installDelayedFetch();
        const onChange = vi.fn();
        imageField.on('change.test', onChange);

        chooseFile(new File(['first'], 'first.jpg', { type: 'image/jpeg' }));
        await waitFor(() => expect(requests).toHaveLength(1));
        chooseFile(new File(['second'], 'second.jpg', { type: 'image/jpeg' }));
        await waitFor(() => expect(requests).toHaveLength(2));

        expect(requests[0].options.signal.aborted).toBe(true);
        requests[1].resolve(uploadResponse('e'));
        await waitForUpload();
        const newestURL = publicPhotoURL('e');
        expect(context.graph().entity(entity.id).tags.image).toEqual(newestURL);

        requests[0].resolve(uploadResponse('d'));
        await setTimeout(20);

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith({ image: newestURL });
        expect(context.graph().entity(entity.id).tags.image).toEqual(newestURL);
        expect(selection.select('.image-upload-preview img').attr('src')).toEqual(newestURL);
    });

    it('invalidates a delayed upload when the image value is edited manually', async function() {
        const requests = installDelayedFetch();
        chooseFile(new File(['pending'], 'pending.jpg', { type: 'image/jpeg' }));
        await waitFor(() => expect(requests).toHaveLength(1));

        const manualURL = 'https://example.com/manually-edited.jpg';
        selection.select('#form-field-image-test')
            .property('value', manualURL)
            .dispatch('input');

        expect(requests[0].options.signal.aborted).toBe(true);
        expect(context.graph().entity(entity.id).tags.image).toEqual(manualURL);
        requests[0].resolve(uploadResponse('a'));
        await setTimeout(20);

        expect(context.graph().entity(entity.id).tags.image).toEqual(manualURL);
        expect(selection.select('.image-upload-tools').classed('has-upload')).toBe(false);
    });

    it('discards delayed analysis after switching entities', async function() {
        const id = 'f'.repeat(64);
        mockUpload({
            status: 201,
            body: { approved: true, id, url: `/api/osm-ai/photos/${id}.jpg` }
        });
        chooseFile(new File(['approved'], 'restaurant.jpg', { type: 'image/jpeg' }));
        await waitForUpload();

        const requests = installDelayedFetch();
        selection.select('.image-analyze').dispatch('click');
        await waitFor(() => expect(requests).toHaveLength(1));
        const other = new iD.osmNode({
            id: 'n789',
            loc: [113.7, 24.9],
            tags: { shop: 'bakery' }
        });
        context.history().merge([other]);
        imageField.entityIDs([other.id]).tags(other.tags);

        expect(requests[0].options.signal.aborted).toBe(true);
        requests[0].resolve(jsonResponse({
            suggestions: [{ key: 'name', value: 'Wrong Entity', confidence: 1 }]
        }));
        await setTimeout(20);

        expect(selection.select('.photo-analysis-result').empty()).toBe(true);
        expect(context.graph().entity(other.id).tags.name).toBeUndefined();
    });

    function mockUpload({ status, body }) {
        fetchMock.mock('/api/osm-ai/photo-upload', {
            status,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    function chooseFile(file) {
        const input = selection.select('#form-field-image-test-upload').node();
        Object.defineProperty(input, 'files', { configurable: true, value: [file] });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function waitForUpload() {
        await waitFor(() => {
            expect(selection.select('.image-upload-tools').classed('has-upload')).toBe(true);
            expect(selection.select('.image-analyze').property('disabled')).toBe(false);
        });
    }

    function installDelayedFetch() {
        const requests = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
            const pending = deferred();
            requests.push({ url: String(url), options, ...pending });
            return pending.promise;
        });
        return requests;
    }

    function deferred() {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    function uploadResponse(character) {
        const id = character.repeat(64);
        return jsonResponse({ approved: true, id, url: `/api/osm-ai/photos/${id}.jpg` }, 201);
    }

    function jsonResponse(body, status = 200) {
        return {
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(body)
        };
    }

    function publicPhotoURL(character) {
        const id = character.repeat(64);
        return new URL(`/api/osm-ai/photos/${id}.jpg`, window.location.origin).href;
    }
});
