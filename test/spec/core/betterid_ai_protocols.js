import {
    directAiChat,
    directAiImageEdit,
    setUserAiProvider
} from '../../../modules/core/betterid_ai';
import { buildChatCall, extractCompletionText } from '../../../modules/core/betterid_ai_protocols';
import { CODEX_PREFS, setCodexSession } from '../../../modules/core/betterid_codex_auth';
import { prefs } from '../../../modules/core/preferences';


describe('betterid AI protocols', function() {
    const realFetch = globalThis.fetch;
    let requests;

    function stubText(text, ok = true) {
        globalThis.fetch = (url, init) => {
            requests.push({ url, init, body: JSON.parse(init.body) });
            return Promise.resolve({
                ok,
                status: ok ? 200 : 500,
                text: () => Promise.resolve(text)
            });
        };
    }

    beforeEach(function() {
        requests = [];
        delete globalThis.OSM_PROXY_CONFIG;
        setUserAiProvider({ enabled: false, baseUrl: '', apiKey: '', textModel: '', protocol: 'openai', stream: false });
        setCodexSession(null);
    });

    afterEach(function() {
        globalThis.fetch = realFetch;
        Object.values(prefs && {}).forEach(() => {});
        ['betterid.ai.custom.enabled', 'betterid.ai.custom.base_url', 'betterid.ai.custom.api_key',
            'betterid.ai.custom.text_model', 'betterid.ai.custom.vision_model', 'betterid.ai.custom.protocol',
            'betterid.ai.custom.stream'].forEach(key => prefs(key, null));
        Object.values(CODEX_PREFS).forEach(key => prefs(key, null));
    });

    it('concatenates an OpenAI chat stream', function() {
        const raw = [
            'data: {"choices":[{"delta":{"content":"He"}}]}',
            '',
            'data: {"choices":[{"delta":{"content":"llo"}}]}',
            '',
            'data: [DONE]',
            ''
        ].join('\n');
        expect(extractCompletionText(raw, 'openai')).toEqual('Hello');
    });

    it('posts a streaming chat completion when stream is enabled', async function() {
        setUserAiProvider({
            enabled: true,
            baseUrl: 'https://api.example/v1',
            apiKey: 'sk-1',
            textModel: 'gpt-test',
            protocol: 'openai',
            stream: true
        });
        stubText('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
        await expect(directAiChat({ prompt: 'hi' })).resolves.toEqual('OK');
        expect(requests[0].url).toEqual('https://api.example/v1/chat/completions');
        expect(requests[0].body.stream).toBe(true);
        expect(requests[0].init.headers.Authorization).toEqual('Bearer sk-1');
    });

    it('speaks Anthropic messages', function() {
        const call = buildChatCall({
            protocol: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'ant-key'
        }, { prompt: 'hi', model: 'claude-test', maxTokens: 32, stream: false });
        expect(call.url).toEqual('https://api.anthropic.com/v1/messages');
        expect(call.headers['x-api-key']).toEqual('ant-key');
        expect(call.headers['anthropic-version']).toEqual('2023-06-01');
        expect(call.body.messages[0].content).toEqual('hi');
    });

    it('speaks Gemini generateContent', function() {
        const call = buildChatCall({
            protocol: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'gem-key'
        }, { prompt: 'hi', model: 'gemini-2.5-flash', stream: true });
        expect(call.url).toContain('/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
        expect(call.headers['x-goog-api-key']).toEqual('gem-key');
        expect(call.body.contents[0].parts[0].text).toEqual('hi');
    });

    it('speaks the Responses API for Codex with the signed-in token', async function() {
        setCodexSession({ accessToken: 'codex-token', refreshToken: '', expiresAt: Date.now() + 3600_000 });
        setUserAiProvider({
            enabled: true,
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            apiKey: '',
            textModel: 'gpt-5.1-codex',
            protocol: 'codex',
            stream: true
        });
        stubText('data: {"type":"response.output_text.delta","delta":"OK"}\n\n');
        await expect(directAiChat({ prompt: 'hi' })).resolves.toEqual('OK');
        expect(requests[0].url).toEqual('https://chatgpt.com/backend-api/codex/responses');
        expect(requests[0].init.headers.Authorization).toEqual('Bearer codex-token');
        expect(requests[0].init.headers['OpenAI-Beta']).toEqual('responses=experimental');
        expect(requests[0].body.input).toBeTruthy();
        expect(requests[0].body.stream).toBe(true);
    });

    it('keeps image editing on the OpenAI protocol', async function() {
        setUserAiProvider({
            enabled: true,
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'ant',
            textModel: 'claude',
            imageModel: 'claude',
            protocol: 'anthropic'
        });
        await expect(directAiImageEdit({
            image: 'data:image/png;base64,AAAA',
            prompt: 'outline'
        })).rejects.toThrow(/OpenAI/);
    });
});
