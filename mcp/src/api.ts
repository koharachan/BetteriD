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
