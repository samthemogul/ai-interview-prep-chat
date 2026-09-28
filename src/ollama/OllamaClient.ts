import { UserFacingError, isAbortError } from '../utils/errors';
import { linkSignals } from '../utils/cancellation';
import type { Logger } from '../utils/logger';
import { nullLogger } from '../utils/logger';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  parameterSize?: string;
  family?: string;
  modifiedAt?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  contextWindow: number;
  /** Maximum tokens to generate (Ollama `num_predict`). */
  maxTokens?: number;
  /** Called with Ollama's `done_reason` ("stop", "length", …) when generation finishes. */
  onDone?: (doneReason: string | undefined) => void;
}

export type ConnectionStatus =
  { state: 'running'; version: string } | { state: 'unreachable'; detail: string };

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

const PROBE_TIMEOUT_MS = 2500;
const LIST_TIMEOUT_MS = 5000;
/** Loading a model into memory can take a while; this bounds the time to the first byte. */
const FIRST_BYTE_TIMEOUT_MS = 120_000;
/**
 * How long Ollama keeps the model in memory after a request. Its default is 5 minutes, so
 * after a short pause every question paid the model load time again.
 */
export const KEEP_ALIVE = '30m';

/**
 * Client for the local Ollama HTTP API. It only ever talks to the configured endpoint
 * and never executes anything; model output is returned as plain text.
 */
export class OllamaClient {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
    private readonly logger: Logger = nullLogger,
  ) {}

  get baseUrl(): string {
    return this.endpoint;
  }

  /** Probes the server. Never throws. */
  async checkConnection(signal?: AbortSignal): Promise<ConnectionStatus> {
    try {
      const res = await this.fetchImpl(`${this.endpoint}/api/version`, {
        signal: linkSignals([signal], PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { state: 'unreachable', detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { version?: unknown };
      return { state: 'running', version: typeof body.version === 'string' ? body.version : 'unknown' };
    } catch (err) {
      return { state: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(signal?: AbortSignal): Promise<OllamaModel[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}/api/tags`, {
        signal: linkSignals([signal], LIST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UserFacingError('ollama-not-running', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw new UserFacingError('ollama-not-running', `GET /api/tags -> HTTP ${res.status}`);
    const body = (await res.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) return [];
    const models: OllamaModel[] = [];
    for (const m of body.models as Array<Record<string, unknown>>) {
      const name = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : undefined;
      if (!name) continue;
      const details = (m.details ?? {}) as Record<string, unknown>;
      models.push({
        name,
        sizeBytes: typeof m.size === 'number' ? m.size : 0,
        parameterSize: typeof details.parameter_size === 'string' ? details.parameter_size : undefined,
        family: typeof details.family === 'string' ? details.family : undefined,
        modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : undefined,
      });
    }
    return models;
  }

  /**
   * Streams a chat completion. Yields content deltas as they arrive.
   * Aborting `signal` stops the HTTP request and ends the iteration with an AbortError.
   */
  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<string, void, void> {
    const firstByte = new AbortController();
    const timer = setTimeout(() => firstByte.abort(), FIRST_BYTE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          keep_alive: KEEP_ALIVE,
          options: {
            temperature: req.temperature,
            num_ctx: req.contextWindow,
            ...(req.maxTokens ? { num_predict: req.maxTokens } : {}),
          },
        }),
        signal: linkSignals([signal, firstByte.signal]),
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal.aborted) throw abortError();
      if (isAbortError(err)) {
        throw new UserFacingError('generation-failed', 'Timed out waiting for the model');
      }
      throw new UserFacingError('ollama-not-running', err instanceof Error ? err.message : String(err));
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await safeText(res);
      if (res.status === 404 || /not found/i.test(text)) {
        throw new UserFacingError('model-unavailable', `model "${req.model}": ${text.slice(0, 200)}`);
      }
      throw new UserFacingError('generation-failed', `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.body) throw new UserFacingError('generation-failed', 'Empty response body');

    try {
      for await (const obj of readNdjson(res.body, signal)) {
        if (typeof obj.error === 'string') {
          if (/not found/i.test(obj.error)) throw new UserFacingError('model-unavailable', obj.error);
          throw new UserFacingError('generation-failed', obj.error);
        }
        const message = obj.message as { content?: unknown } | undefined;
        if (message && typeof message.content === 'string' && message.content.length > 0) {
          yield message.content;
        }
        if (obj.done === true) {
          req.onDone?.(typeof obj.done_reason === 'string' ? obj.done_reason : undefined);
          return;
        }
      }
    } catch (err) {
      if (signal.aborted) throw abortError();
      throw err;
    }
    this.logger.debug('Stream ended without a done marker');
  }

  /**
   * Loads the model into memory ahead of the first question (a request without a prompt
   * only loads it). Never throws.
   */
  async warmUp(model: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: KEEP_ALIVE }),
        signal: linkSignals([], FIRST_BYTE_TIMEOUT_MS),
      });
      await safeText(res);
    } catch (err) {
      this.logger.debug(`Warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Downloads a model. Only called after explicit user confirmation. */
  async pullModel(name: string, onProgress: (p: PullProgress) => void, signal: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw abortError();
      throw new UserFacingError('ollama-not-running', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok || !res.body) {
      throw new UserFacingError(
        'generation-failed',
        `pull failed: HTTP ${res.status} ${await safeText(res)}`,
      );
    }
    for await (const obj of readNdjson(res.body, signal)) {
      if (typeof obj.error === 'string') throw new UserFacingError('generation-failed', obj.error);
      onProgress({
        status: typeof obj.status === 'string' ? obj.status : '',
        completed: typeof obj.completed === 'number' ? obj.completed : undefined,
        total: typeof obj.total === 'number' ? obj.total : undefined,
      });
    }
  }
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Parses a newline-delimited JSON stream, handling objects split across chunks. */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const parsed = parseLine(line);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const parsed = parseLine(buffer.trim());
    if (parsed) yield parsed;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // The consumer stopped early: close the connection so Ollama stops generating.
    if (!finished) reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line) return undefined;
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
