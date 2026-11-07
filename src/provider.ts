import { createHash } from 'node:crypto';
import { parseUsage } from './usage.ts';
import type { Auth } from './auth.ts';
import type { Completion, Model, WireItem } from './contracts.ts';

const contextCodes = new Set(['context_length_exceeded', 'context_window_exceeded', 'too_many_tokens']);
const contextLimitError = () => Object.assign(new Error('The model context window is full.'), { code: 'context_length_exceeded' });

/** Keep actionable parameter/code diagnostics without echoing prompts, tokens or server HTML. */
function requestError(status: number, payload: unknown): Error {
  const body = payload as { error?: { code?: unknown; type?: unknown; param?: unknown; message?: unknown } | string;
    detail?: unknown } | null;
  const structured = body?.error && typeof body.error === 'object' ? body.error : undefined;
  const safeAtom = (value: unknown): string | undefined => typeof value === 'string'
    && /^[A-Za-z0-9_.\[\]-]{1,128}$/.test(value) ? value : undefined;
  const code = safeAtom(structured?.code) ?? safeAtom(structured?.type);
  let param = safeAtom(structured?.param);
  let unsupported = false;
  for (const detail of [body?.detail, structured?.message, body?.error]) {
    if (typeof detail !== 'string') continue;
    const match = /^(?:Unsupported|Unknown|Unrecognized) parameter:\s*['"]?([A-Za-z_][A-Za-z0-9_.\[\]-]{0,127})['"]?\.?$/i.exec(detail.trim());
    if (match) { param = match[1]; unsupported = true; break; }
  }
  const detail = unsupported ? ` Unsupported parameter: ${param}.`
    : [code, param ? `parameter: ${param}` : undefined].filter(Boolean).join('; ');
  return Object.assign(new Error(`The model request failed (${status}).${detail ? (unsupported ? detail : ` ${detail}.`) : ' Please try again.'}`),
    { status, ...(code ? { code } : {}), ...(param ? { param } : {}) });
}

export const executeTool = {
  type: 'namespace', name: 'cosmurgy', description: 'Cosmurgy runtime capabilities', tools: [{
    type: 'function', name: 'execute', description: 'Execute TypeScript with top-level await. Compose the tools described in your instructions using tools.NAME(arguments). Return a JSON-serializable result. Node builtins are available through await import("node:fs/promises") etc. Runs with full local user access.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'TypeScript async function body; use return to produce a result.' } }, required: ['code'], additionalProperties: false }, strict: true,
  }],
};

/** Parse SSE across arbitrary UTF-8/chunk boundaries, including CRLF and multiline data. */
export async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let lines: string[] = [];
  function parse(): Record<string, any> | undefined {
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    lines = [];
    if (!data || data === '[DONE]') return;
    return JSON.parse(data);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) { const item = parse(); if (item) yield item; } else lines.push(line);
      }
      if (done) {
        if (buffer) lines.push(buffer.replace(/\r$/, ''));
        const item = parse(); if (item) yield item;
        break;
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
/** Opaque routing hint stable across appended turns, reloads and restarts. */
export function promptCacheKey(model: string, instructions: string, scope = 'default'): string {
  return 'cosmurgy:' + createHash('sha256').update(JSON.stringify([scope, model, instructions, executeTool])).digest('hex').slice(0, 48);
}
export class Provider {
  private auth: Pick<Auth, 'token'>;
  private fetcher: typeof fetch;
  private base: string;
  constructor(auth: Pick<Auth, 'token'>, fetcher: typeof fetch = fetch, base = 'https://api.openai.com/v1') {
    this.auth = auth; this.fetcher = fetcher; this.base = base;
  }
  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.auth.token(attempt === 1);
      response = await this.fetcher(`${this.base}/${path}`, { ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      if (response.status !== 401 || attempt === 1) break;
      await response.body?.cancel();
    }
    if (!response!.ok) {
      // Avoid echoing request bodies, credentials, or server HTML into conversations.
      const status = response!.status;
      let payload: unknown;
      if (status === 400 || status === 413) {
        payload = await response!.json().catch(() => null);
        const error = (payload as { error?: { code?: string; type?: string } } | null)?.error;
        if (status === 413 || contextCodes.has(error?.code ?? '') || contextCodes.has(error?.type ?? '')) throw contextLimitError();
      } else { await response!.body?.cancel(); }
      if (status === 401 || status === 403) throw new Error('ChatGPT access was rejected. Reconnect your account and check that plan usage is enabled.');
      if (status === 429) throw new Error('ChatGPT usage limit reached. Check your plan usage or try again later.');
      throw requestError(status, payload);
    }
    return response!;
  }
  async models(signal?: AbortSignal): Promise<Model[]> {
    const response = await this.request('models', { signal: signal ?? AbortSignal.timeout(30_000) });
    const body = await response.json() as { models: { slug: string; display_name: string; visibility: string }[] };
    if (!Array.isArray(body.models)) throw new Error('ChatGPT returned an unexpected model catalog.');
    return body.models.filter(m => m.visibility === 'list').map(m => ({ slug: m.slug, name: m.display_name || m.slug }));
  }
  async complete(model: string, input: WireItem[], instructions: string,
    signal: AbortSignal, onDelta: (delta: string) => void, options: { cacheScope?: string } = {}): Promise<Completion> {
    const response = await this.request('responses', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model, input, instructions, store: false, stream: true,
        // The ChatGPT subscription route rejects prompt_cache_retention. Let the service manage its lifetime.
        prompt_cache_key: promptCacheKey(model, instructions, options.cacheScope),
        include: ['reasoning.encrypted_content'], tools: [executeTool] }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    });
    if (!response.body) throw new Error('The model response had no stream.');
    for await (const event of events(response.body)) {
      if (event.type === 'response.output_text.delta') onDelta(event.delta);
      if (event.type === 'response.completed') {
        if (event.response?.status !== 'completed' || !Array.isArray(event.response?.output)) throw new Error('The model did not complete its response.');
        const output = event.response.output as WireItem[];
        return { output, usage: parseUsage(event.response.usage), calls: output.filter(item => item.type === 'function_call').map(item => ({
          id: String(item.call_id), name: String(item.name), arguments: String(item.arguments),
        })) };
      }
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
        const code = event.response?.error?.code ?? event.error?.code ?? event.code ?? event.response?.incomplete_details?.reason;
        if (contextCodes.has(code)) throw contextLimitError();
        if (code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable') {
          throw new Error('ChatGPT plan usage is currently unavailable or its limit was reached. Check ChatGPT Settings → Usage.');
        }
        throw new Error(`The model response ${event.type === 'response.incomplete' ? 'was incomplete' : 'failed'}. Please try again.`);
      }
    }
    throw new Error('The model stream ended before completion. Please try again.');
  }
}
