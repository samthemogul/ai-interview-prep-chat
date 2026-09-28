import type { ChatMessage, FetchLike } from '../../src/ollama/OllamaClient';

export interface FakeOllamaOptions {
  running?: boolean;
  version?: string;
  models?: Array<{ name: string; size?: number; parameter_size?: string; family?: string }>;
  /** Produces the streamed reply (as content chunks) for a chat request. */
  reply?: (messages: ChatMessage[], model: string) => string[];
  /** Delay between streamed chunks, in ms. */
  chunkDelayMs?: number;
  /** HTTP status for /api/chat (e.g. 404 for a missing model). */
  chatStatus?: number;
  chatErrorBody?: string;
  /** A JSON error object emitted mid-stream after N chunks. */
  streamErrorAfter?: { chunks: number; error: string };
  /** Ollama's done_reason on the final line; defaults to "length" when num_predict cut the reply. */
  doneReason?: string;
}

export interface FakeOllama {
  fetch: FetchLike;
  chatRequests: Array<{ model: string; messages: ChatMessage[]; options: Record<string, unknown> }>;
  pulls: string[];
  set(opts: Partial<FakeOllamaOptions>): void;
}

const enc = new TextEncoder();

function ndjsonStream(
  lines: Array<Record<string, unknown>>,
  delayMs: number,
  signal?: AbortSignal | null,
  /** Split each serialised line into pieces to exercise chunk-boundary handling. */
  splitEvery = 7,
): ReadableStream<Uint8Array> {
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pieces: string[] = [];
  for (const l of lines) {
    const s = JSON.stringify(l) + '\n';
    for (let j = 0; j < s.length; j += splitEvery) pieces.push(s.slice(j, j + splitEvery));
  }
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted) {
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          resolve();
          return;
        }
        if (i >= pieces.length) {
          controller.close();
          resolve();
          return;
        }
        const push = () => {
          if (signal?.aborted) {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          } else {
            controller.enqueue(enc.encode(pieces[i++]!));
          }
          resolve();
        };
        if (delayMs > 0) timer = setTimeout(push, delayMs);
        else push();
      });
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });
}

export function createFakeOllama(initial: FakeOllamaOptions = {}): FakeOllama {
  let opts: FakeOllamaOptions = { running: true, version: '0.12.3', models: [], chunkDelayMs: 0, ...initial };
  const chatRequests: FakeOllama['chatRequests'] = [];
  const pulls: string[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    if (!opts.running) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const path = new URL(url).pathname;
    if (path === '/api/version') {
      return new Response(JSON.stringify({ version: opts.version }), { status: 200 });
    }
    if (path === '/api/tags') {
      return new Response(
        JSON.stringify({
          models: (opts.models ?? []).map((m) => ({
            name: m.name,
            size: m.size ?? 1_000_000_000,
            modified_at: '2026-09-01T00:00:00Z',
            details: { parameter_size: m.parameter_size ?? '7B', family: m.family ?? 'llama' },
          })),
        }),
        { status: 200 },
      );
    }
    if (path === '/api/chat') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: ChatMessage[];
        options: Record<string, unknown>;
      };
      chatRequests.push(body);
      if (opts.chatStatus && opts.chatStatus !== 200) {
        return new Response(
          opts.chatErrorBody ?? JSON.stringify({ error: `model "${body.model}" not found` }),
          {
            status: opts.chatStatus,
          },
        );
      }
      const chunks = (opts.reply ?? (() => ['Hello', ' world']))(body.messages, body.model);
      const lines: Array<Record<string, unknown>> = [];
      chunks.forEach((c, idx) => {
        if (opts.streamErrorAfter && idx === opts.streamErrorAfter.chunks) {
          lines.push({ error: opts.streamErrorAfter.error });
        }
        lines.push({ model: body.model, message: { role: 'assistant', content: c }, done: false });
      });
      const limit = typeof body.options?.num_predict === 'number' ? body.options.num_predict : undefined;
      const reason = opts.doneReason ?? (limit && chunks.join('').length > limit ? 'length' : 'stop');
      lines.push({
        model: body.model,
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: reason,
      });
      return new Response(ndjsonStream(lines, opts.chunkDelayMs ?? 0, init?.signal), { status: 200 });
    }
    if (path === '/api/pull') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      pulls.push(body.model);
      return new Response(
        ndjsonStream(
          [
            { status: 'pulling manifest' },
            { status: 'downloading', total: 100, completed: 50 },
            { status: 'success' },
          ],
          0,
          init?.signal,
        ),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  };

  return {
    fetch: fetchImpl,
    chatRequests,
    pulls,
    set(next) {
      opts = { ...opts, ...next };
    },
  };
}
