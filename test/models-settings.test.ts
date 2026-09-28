import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  isLikelyChatModel,
  isValidModelName,
  resolveModel,
  sortModels,
} from '../src/ollama/OllamaModels';
import type { OllamaModel } from '../src/ollama/OllamaClient';
import { isLocalEndpoint, normalizeEndpoint, normalizeSettings } from '../src/settings/settings';

const m = (name: string): OllamaModel => ({ name, sizeBytes: 1 });

describe('model selection', () => {
  const models = [m('nomic-embed-text:latest'), m('qwen2.5-coder:7b'), m('llama3.2:latest')];

  it('keeps the configured model when installed', () => {
    expect(resolveModel('qwen2.5-coder:7b', models)).toEqual({ model: 'qwen2.5-coder:7b', missing: false });
  });

  it('matches an untagged name to :latest', () => {
    expect(resolveModel('llama3.2', models)).toEqual({ model: 'llama3.2:latest', missing: false });
  });

  it('flags a configured model that is no longer installed', () => {
    expect(resolveModel('mistral:7b', models)).toEqual({ model: undefined, missing: true });
  });

  it('picks the first chat model when nothing is configured, never an embedding model', () => {
    expect(resolveModel('', models).model).toBe('llama3.2:latest');
    expect(isLikelyChatModel(m('nomic-embed-text:latest'))).toBe(false);
  });

  it('reports nothing when no models are installed', () => {
    expect(resolveModel('', [])).toEqual({ model: undefined, missing: false });
  });

  it('sorts chat models first', () => {
    expect(sortModels(models).map((x) => x.name)).toEqual([
      'llama3.2:latest',
      'qwen2.5-coder:7b',
      'nomic-embed-text:latest',
    ]);
  });

  it('validates model names before downloading', () => {
    expect(isValidModelName('qwen2.5-coder:7b')).toBe(true);
    expect(isValidModelName('library/llama3.2')).toBe(true);
    expect(isValidModelName('rm -rf /')).toBe(false);
    expect(isValidModelName('')).toBe(false);
  });

  it('formats sizes', () => {
    expect(formatBytes(4_700_000_000)).toBe('4.4 GB');
    expect(formatBytes(0)).toBe('');
  });
});

describe('settings', () => {
  it('applies defaults and clamps values', () => {
    const s = normalizeSettings({ maxContextFiles: 999, temperature: -1, mode: 'bogus', contextWindow: 10 });
    expect(s.maxContextFiles).toBe(20);
    expect(s.temperature).toBe(0);
    expect(s.mode).toBe('guarded');
    expect(s.contextWindow).toBe(2048);
    expect(s.saveTranscripts).toBe(true);
    expect(s.autoIncludeCurrentFile).toBe(false);
  });

  it('normalises and validates the endpoint', () => {
    expect(normalizeEndpoint('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeEndpoint('file:///etc/passwd')).toBeUndefined();
    expect(normalizeEndpoint('not a url')).toBeUndefined();
  });

  it('knows which endpoints are local', () => {
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalEndpoint('http://[::1]:11434')).toBe(true);
    expect(isLocalEndpoint('http://10.0.0.5:11434')).toBe(false);
  });
});
