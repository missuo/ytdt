/**
 * Minimal client for OpenAI-compatible Chat Completions endpoints
 * (OpenAI, DeepSeek, OpenRouter, Gemini's OpenAI layer, Ollama, vLLM, ...).
 */

export type LlmErrorCode = 'auth' | 'config' | 'rate' | 'http' | 'network';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: LlmErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function endpoint(baseUrl: string, path: '/chat/completions' | '/models'): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (path === '/chat/completions' && base.endsWith('/chat/completions')) return base;
  return base.replace(/\/chat\/completions$/, '') + path;
}

function headers(apiKey: string): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (typeof e === 'string') return e;
    if (e?.message) return String(e.message);
    if (j.message) return String(j.message);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new LlmError(`Network error: ${(e as Error).message}`, 'network');
  }
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  const detail = errorMessage(body) || res.statusText;
  const code: LlmErrorCode =
    res.status === 401 || res.status === 403
      ? 'auth'
      : res.status === 429
        ? 'rate'
        : res.status === 404 || res.status === 400
          ? 'config'
          : 'http';
  throw new LlmError(`HTTP ${res.status}: ${detail}`, code, res.status);
}

function requireConfig(cfg: LlmConfig) {
  if (!cfg.baseUrl.trim()) throw new LlmError('API base URL is not set.', 'config');
  if (!cfg.model.trim()) throw new LlmError('Model is not set.', 'config');
}

/** Streams assistant text deltas. Falls back to a single chunk if the server ignores `stream`. */
export async function* streamChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  requireConfig(cfg);
  const body: Record<string, unknown> = { model: cfg.model.trim(), messages, stream: true };
  if (cfg.temperature != null) body.temperature = cfg.temperature;

  const res = await send(endpoint(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(cfg.apiKey),
    body: JSON.stringify(body),
    signal,
  });

  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content) yield content;
    return;
  }
  if (!res.body) return;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new LlmError(errorMessage(JSON.stringify(j)), 'http');
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function completeChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let out = '';
  for await (const d of streamChat(cfg, messages, signal)) out += d;
  return out;
}

export async function listModels(cfg: Pick<LlmConfig, 'baseUrl' | 'apiKey'>): Promise<string[]> {
  if (!cfg.baseUrl.trim()) throw new LlmError('API base URL is not set.', 'config');
  const res = await send(endpoint(cfg.baseUrl, '/models'), { headers: headers(cfg.apiKey) });
  const j = await res.json();
  const list: unknown[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return list
    .map((m: any) => (typeof m === 'string' ? m : (m?.id ?? m?.name)))
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^models\//, ''))
    .sort();
}
