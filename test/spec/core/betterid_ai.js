import {
    BETTERID_AI_PREFS,
    aiProvider,
    aiTranslate,
    directAiAvailable,
    directAiChat,
    directAiImageAvailable,
    directAiImageEdit,
    directAiJson,
    directAiModel,
    extractJsonObject,
    setUserAiProvider,
    userAiProvider
} from '../../../modules/core/betterid_ai';
import { prefs } from '../../../modules/core/preferences';


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


describe('betterid user-configured AI provider', function() {
    const realFetch = globalThis.fetch;
    let requests;

    function stub(response, ok = true) {
        globalThis.fetch = (url, init) => {
            requests.push({ url, init });
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
        delete globalThis.OSM_PROXY_CONFIG;
        setUserAiProvider({ enabled: false, baseUrl: '', apiKey: '', textModel: '', visionModel: '', imageModel: '', imageApi: '' });
    });

    afterEach(function() {
        globalThis.fetch = realFetch;
        delete globalThis.OSM_PROXY_CONFIG;
        delete globalThis.BETTERID_DESKTOP;
        Object.values(BETTERID_AI_PREFS).forEach(key => prefs(key, null));
    });

    it('is only active when enabled with a base URL', function() {
        expect(userAiProvider()).toBeNull();
        setUserAiProvider({ enabled: true, baseUrl: ' https://api.example/v1 ', apiKey: ' sk-1 ', textModel: 'm1' });
        const provider = userAiProvider();
        expect(provider.source).toEqual('user');
        expect(provider.baseUrl).toEqual('https://api.example/v1');
        expect(provider.apiKey).toEqual('sk-1');
        expect(provider.imageApi).toEqual('images');
        expect(directAiAvailable()).toBe(true);

        setUserAiProvider({ baseUrl: '' });
        expect(userAiProvider()).toBeNull();
    });

    it('takes precedence over the deployment endpoint', function() {
        globalThis.OSM_PROXY_CONFIG = { ai: { baseUrl: 'http://deploy/v1', apiKey: 'd', textModel: 'deploy-model' } };
        expect(aiProvider().source).toEqual('deployment');
        setUserAiProvider({ enabled: true, baseUrl: 'http://mine/v1', apiKey: 'k', textModel: 'my-model', imageModel: 'img' });
        expect(aiProvider().source).toEqual('user');
        expect(directAiModel('text')).toEqual('my-model');
        expect(directAiModel('image')).toEqual('img');
        expect(directAiImageAvailable()).toBe(true);
    });

    it('edits an image through the Images API and returns a data URL', async function() {
        setUserAiProvider({ enabled: true, baseUrl: 'http://mine/v1', apiKey: 'k', imageModel: 'gpt-image-1', imageApi: 'images' });
        stub({ data: [{ b64_json: 'AAAA' }] });

        const result = await directAiImageEdit({
            image: 'data:image/png;base64,iVBORw0KGgo=',
            prompt: 'outline',
            size: '1024x1024'
        });
        expect(result).toEqual('data:image/png;base64,AAAA');
        expect(requests[0].url).toEqual('http://mine/v1/images/edits');
        expect(requests[0].init.headers.Authorization).toEqual('Bearer k');
        expect(requests[0].init.body).toBeInstanceOf(FormData);
        expect(requests[0].init.body.get('model')).toEqual('gpt-image-1');
        expect(requests[0].init.body.get('size')).toEqual('1024x1024');
        expect(requests[0].init.body.get('response_format')).toBeNull();   // gpt-image-1 ignores it
    });

    it('edits an image through a chat completion that answers with one', async function() {
        setUserAiProvider({ enabled: true, baseUrl: 'http://mine/v1', apiKey: 'k', imageModel: 'image-model', imageApi: 'chat' });
        stub({ choices: [{ message: { content: 'done', images: [{ image_url: { url: 'data:image/png;base64,BBBB' } }] } }] });

        const result = await directAiImageEdit({ image: 'data:image/png;base64,iVBORw0KGgo=', prompt: 'outline' });
        expect(result).toEqual('data:image/png;base64,BBBB');
        expect(requests[0].url).toEqual('http://mine/v1/chat/completions');
        const body = JSON.parse(requests[0].init.body);
        expect(body.model).toEqual('image-model');
        expect(body.modalities).toEqual(['image', 'text']);
    });

    it('rejects when the model returns no image', async function() {
        setUserAiProvider({ enabled: true, baseUrl: 'http://mine/v1', apiKey: 'k', imageModel: 'x', imageApi: 'chat' });
        stub({ choices: [{ message: { content: 'sorry' } }] });
        await expect(directAiImageEdit({ image: 'data:image/png;base64,AA==', prompt: 'p' }))
            .rejects.toThrow('did not return an image');
    });

    it('translates through the proxy when no direct provider exists, and directly otherwise', async function() {
        stub({ translations: [{ lang: 'zh', text: '湖' }] });
        const viaProxy = await aiTranslate('lake', ['zh']);
        expect(viaProxy.translations[0].text).toEqual('湖');
        expect(requests[0].url).toEqual('/api/osm-ai/translate');

        requests = [];
        setUserAiProvider({ enabled: true, baseUrl: 'http://mine/v1', apiKey: 'k', textModel: 'm' });
        stub({ choices: [{ message: { content: '{"translations":[{"lang":"zh","text":"湖泊"}]}' } }] });
        const direct = await aiTranslate('lake', ['zh']);
        expect(direct.translations[0].text).toEqual('湖泊');
        expect(requests[0].url).toEqual('http://mine/v1/chat/completions');
    });

    it('has no proxy in the desktop app', async function() {
        globalThis.BETTERID_DESKTOP = true;
        await expect(aiTranslate('lake', ['zh'])).rejects.toMatchObject({ status: 503 });
    });
});
