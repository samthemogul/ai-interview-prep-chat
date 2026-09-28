import { describe, expect, it } from 'vitest';
import { OllamaClient, readNdjson } from '../src/ollama/OllamaClient';
import { detectOllama, candidateInstallPaths, type DetectorEnv } from '../src/ollama/OllamaDetector';
import { UserFacingError } from '../src/utils/errors';
import { createFakeOllama } from './helpers/fakeOllama';

const ENDPOINT = 'http://localhost:11434';

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('Ollama availability detection', () => {
  it('reports running with the server version', async () => {
    const fake = createFakeOllama({ version: '0.12.3' });
    const status = await new OllamaClient(ENDPOINT, fake.fetch).checkConnection();
    expect(status).toEqual({ state: 'running', version: '0.12.3' });
  });

  it('reports unreachable instead of throwing when the server is down', async () => {
    const fake = createFakeOllama({ running: false });
    const status = await new OllamaClient(ENDPOINT, fake.fetch).checkConnection();
    expect(status.state).toBe('unreachable');
  });

  const env = (existing: string[], platform: NodeJS.Platform = 'linux'): DetectorEnv => ({
    platform,
    env: { PATH: '/usr/bin:/home/me/bin' },
    homedir: '/home/me',
    exists: async (p) => existing.includes(p),
  });

  it('distinguishes "installed but not running" from "not installed"', async () => {
    const down = async () => ({ state: 'unreachable' as const, detail: 'ECONNREFUSED' });
    expect(await detectOllama(ENDPOINT, down, env(['/home/me/bin/ollama']))).toEqual({
      state: 'installed-not-running',
    });
    expect(await detectOllama(ENDPOINT, down, env([]))).toEqual({ state: 'not-installed' });
  });

  it('does not guess about installation for remote endpoints', async () => {
    const down = async () => ({ state: 'unreachable' as const, detail: 'timeout' });
    expect(await detectOllama('http://gpu-box.lan:11434', down, env([]))).toEqual({
      state: 'unreachable-remote',
    });
  });

  it('checks the usual install locations per platform', () => {
    expect(candidateInstallPaths(env([], 'darwin'))).toContain('/Applications/Ollama.app');
    const win = candidateInstallPaths({
      ...env([], 'win32'),
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', Path: 'C:\\bin' },
    });
    expect(win).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama.exe');
    expect(win).toContain('C:\\bin\\ollama.exe');
  });
});

describe('model discovery', () => {
  it('parses /api/tags', async () => {
    const fake = createFakeOllama({
      models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000, parameter_size: '7.6B' }],
    });
    const models = await new OllamaClient(ENDPOINT, fake.fetch).listModels();
    expect(models).toEqual([
      expect.objectContaining({ name: 'qwen2.5-coder:7b', sizeBytes: 4_700_000_000, parameterSize: '7.6B' }),
    ]);
  });

  it('turns connection failures into a user-facing error', async () => {
    const fake = createFakeOllama({ running: false });
    await expect(new OllamaClient(ENDPOINT, fake.fetch).listModels()).rejects.toMatchObject({
      code: 'ollama-not-running',
    });
  });
});

describe('streaming chat', () => {
  it('streams content deltas and sends num_ctx and temperature', async () => {
    const fake = createFakeOllama({ reply: () => ['Hel', 'lo ', 'there'] });
    const client = new OllamaClient(ENDPOINT, fake.fetch);
    const chunks = await collect(
      client.chatStream(
        { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, contextWindow: 8192 },
        new AbortController().signal,
      ),
    );
    expect(chunks.join('')).toBe('Hello there');
    expect(fake.chatRequests[0]!.options).toEqual({ temperature: 0.3, num_ctx: 8192 });
  });

  it('maps a missing model to model-unavailable', async () => {
    const fake = createFakeOllama({ chatStatus: 404 });
    const client = new OllamaClient(ENDPOINT, fake.fetch);
    const run = collect(
      client.chatStream(
        { model: 'gone', messages: [], temperature: 0, contextWindow: 2048 },
        new AbortController().signal,
      ),
    );
    await expect(run).rejects.toMatchObject({ code: 'model-unavailable' });
  });

  it('surfaces errors reported mid-stream', async () => {
    const fake = createFakeOllama({
      reply: () => ['a', 'b', 'c'],
      streamErrorAfter: { chunks: 1, error: 'out of memory' },
    });
    const client = new OllamaClient(ENDPOINT, fake.fetch);
    const run = collect(
      client.chatStream(
        { model: 'm', messages: [], temperature: 0, contextWindow: 2048 },
        new AbortController().signal,
      ),
    );
    await expect(run).rejects.toBeInstanceOf(UserFacingError);
  });

  it('stops promptly when cancelled and ends with an AbortError', async () => {
    const fake = createFakeOllama({
      reply: () => Array.from({ length: 200 }, (_, i) => `t${i} `),
      chunkDelayMs: 2,
    });
    const client = new OllamaClient(ENDPOINT, fake.fetch);
    const ac = new AbortController();
    const received: string[] = [];
    const run = (async () => {
      for await (const c of client.chatStream(
        { model: 'm', messages: [], temperature: 0, contextWindow: 2048 },
        ac.signal,
      )) {
        received.push(c);
        if (received.length === 3) ac.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(received.length).toBeLessThan(10);
  });
});

describe('readNdjson', () => {
  it('reassembles objects split across chunks and ignores junk lines', async () => {
    const enc = new TextEncoder();
    const parts = ['{"a":', '1}\n{"b"', ':2}\nnot json\n', '{"c":3}'];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const out: unknown[] = [];
    for await (const o of readNdjson(body)) out.push(o);
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe('model download', () => {
  it('reports pull progress', async () => {
    const fake = createFakeOllama();
    const progress: string[] = [];
    await new OllamaClient(ENDPOINT, fake.fetch).pullModel(
      'llama3.2:3b',
      (p) => progress.push(p.status),
      new AbortController().signal,
    );
    expect(fake.pulls).toEqual(['llama3.2:3b']);
    expect(progress).toContain('success');
  });
});
