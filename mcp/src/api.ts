import type { Tags } from './normalize.js';

const DEFAULT_TIMEOUT_MS = 90_000;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';

export interface SuggestTagsInput {
  description: string;
  tags?: Tags;
  geometry?: string;
  location?: { lat: number; lon: number };
  locale?: string;
  provider_order?: string[];
  text_provider_order?: string[];
}

export interface TranslateInput {
  text: string;
  target_langs: string[];
  provider_order?: string[];
}

export interface SummarizeInput {
  summary: unknown;
  provider_order?: string[];
}

export interface BetterIdApiOptions {
  webBaseUrl?: string;
  nominatimUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Client for the BetteriD web backend and Nominatim used by auxilliary tools. */
export class BetterIdApi {
  private readonly webBaseUrl: string;
  private readonly nominatimUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BetterIdApiOptions = {}) {
    this.webBaseUrl = (options.webBaseUrl ?? 'http://127.0.0.1:9178').replace(/\/+$/, '');
    this.nominatimUrl = (options.nominatimUrl ?? NOMINATIM_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async suggestTags(input: SuggestTagsInput): Promise<unknown> {
    return this.post('/api/osm-ai/tag-suggestions', input);
  }

  /** Translate text into multiple BCP 47 target languages via the BetteriD AI backend. */
  async translate(input: TranslateInput): Promise<unknown> {
    const { text, target_langs, provider_order } = input;
    if (!text.trim()) throw new Error('翻译文本不能为空');
    if (!target_langs.length || target_langs.length > 8) {
      throw new Error('target_langs 需要 1-8 个 BCP 47 语言代码');
    }
    for (const lang of target_langs) {
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(lang.trim())) {
        throw new Error(`无效的语言代码：${lang}`);
      }
    }
    return this.post('/api/osm-ai/translate', {
      text,
      target_langs: target_langs.map((lang) => lang.trim()),
      ...(provider_order?.length ? { provider_order } : {})
    });
  }

  /** Ask the BetteriD AI backend to summarize a changeset diff into a comment. */
  async summarize(input: SummarizeInput): Promise<unknown> {
    return this.post('/api/osm-ai/summarize', {
      summary: input.summary,
      ...(input.provider_order?.length ? { provider_order: input.provider_order } : {})
    });
  }

  async geocode(query: string, limit: number): Promise<unknown> {
    const params = new URLSearchParams({
      format: 'jsonv2',
      limit: String(Math.min(Math.max(limit, 1), 5)),
      'accept-language': 'zh-CN,zh,en',
      q: query
    });
    return this.get(`${this.nominatimUrl}/search?${params.toString()}`);
  }

  private async get(url: string): Promise<unknown> {
    return this.request(url, { method: 'GET' });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request(`${this.webBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'betterid-mcp/0.1',
          ...(init.headers ?? {})
        }
      });
      const raw = await response.text();
      let data: unknown = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      }
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && !Array.isArray(data) &&
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : response.statusText || 'request failed';
        throw new Error(`HTTP ${response.status}: ${message}`);
      }
      return data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`请求超时（${this.timeoutMs}ms）：${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
