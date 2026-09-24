import {
    directAiAvailable,
    directAiChat,
    directAiJson,
    directAiModel,
    extractJsonObject
} from '../../../modules/core/betterid_ai';


describe('betterid direct AI client', function() {
    const realFetch = globalThis.fetch;
    let requests;

    function stub(response, ok = true) {
        globalThis.fetch = (url, init) => {
            requests.push({ url, init, body: JSON.parse(init.body) });
            return Promise.resolve({
                ok,
                status: ok ? 200 : 500,
                json: () => Promise.resolve(response),
                text: () => Promise.resolve(JSON.stringify(response))
            });
        };
    }

    beforeEach(function() {
        requests = [];
        globalThis.OSM_PROXY_CONFIG = {
            ai: {
                baseUrl: 'http://ai.example/v1/',
                apiKey: 'test-key',
                textModel: 'text-model',
                visionModel: '',
                disableThinking: true,
                timeout: 5000
            }
        };
    });

    afterEach(function() {
        globalThis.fetch = realFetch;
        delete globalThis.OSM_PROXY_CONFIG;
    });

    it('is unavailable until the deployment publishes an endpoint', function() {
        expect(directAiAvailable()).toBe(true);

        globalThis.OSM_PROXY_CONFIG = { osmApiConnection: {} };
        expect(directAiAvailable()).toBe(false);
        expect(directAiModel('text')).toEqual(null);
    });

    it('falls back to the text model when no vision model is set', function() {
        expect(directAiModel('text')).toEqual('text-model');
        expect(directAiModel('vision')).toEqual('text-model');
    });

    it('posts a plain chat completion with the bearer key', async function() {
        stub({ choices: [{ message: { content: 'hello' } }] });

        const text = await directAiChat({ prompt: 'hi', system: 'be nice', maxTokens: 128 });

        expect(text).toEqual('hello');
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toEqual('http://ai.example/v1/chat/completions');
        expect(requests[0].init.headers.Authorization).toEqual('Bearer test-key');
        expect(requests[0].body.model).toEqual('text-model');
        expect(requests[0].body.max_tokens).toEqual(128);
        expect(requests[0].body.thinking).toStrictEqual({ type: 'disabled' });
        expect(requests[0].body.messages[0]).toStrictEqual({ role: 'system', content: 'be nice' });
        expect(requests[0].body.messages[1]).toStrictEqual({ role: 'user', content: 'hi' });
    });

    it('sends images to the vision model as a data URL', async function() {
        stub({ choices: [{ message: { content: 'a cat' } }] });

        await directAiChat({ prompt: 'what is this', image: 'data:image/jpeg;base64,AAAA' });

        expect(requests[0].body.model).toEqual('text-model');
        expect(requests[0].body.thinking).toStrictEqual(undefined);
        expect(requests[0].body.messages[0].content[0].text).toEqual('what is this');
        expect(requests[0].body.messages[0].content[1].image_url.url).toEqual('data:image/jpeg;base64,AAAA');
    });

    it('asks for a JSON object and parses fenced or chatty answers', async function() {
        stub({ choices: [{ message: { content: '```json\n{"summary":"ok"}\n```' } }] });
        await expect(directAiJson({ prompt: 'go' })).resolves.toStrictEqual({ summary: 'ok' });
        expect(requests[0].body.response_format).toStrictEqual({ type: 'json_object' });

        stub({ choices: [{ message: { content: 'Sure! Here it is: {"a":{"b":1}} — done.' } }] });
        await expect(directAiJson({ prompt: 'go' })).resolves.toStrictEqual({ a: { b: 1 } });
    });

    it('rejects empty completions and non-JSON answers', async function() {
        stub({ choices: [{ message: { content: '   ' } }] });
        await expect(directAiChat({ prompt: 'go' })).rejects.toThrow(/empty completion/);

        stub({ choices: [{ message: { content: 'no object here' } }] });
        await expect(directAiJson({ prompt: 'go' })).rejects.toThrow(/did not return JSON/);
    });

    it('extracts the first balanced object, ignoring braces in strings', function() {
        expect(extractJsonObject('{"a":"}{"}')).toStrictEqual({ a: '}{' });
        expect(extractJsonObject('prefix {"a":1} suffix')).toStrictEqual({ a: 1 });
        expect(extractJsonObject('nothing')).toEqual(null);
    });
});
