import type { ChatMode, InterviewMode } from '../interview/InterviewMode';

export interface Settings {
  ollamaEndpoint: string;
  model: string;
  mode: InterviewMode;
  chatMode: ChatMode;
  maxContextFiles: number;
  maxContextCharacters: number;
  contextWindow: number;
  autoIncludeCurrentFile: boolean;
  includeDiagnostics: boolean;
  temperature: number;
  saveTranscripts: boolean;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaEndpoint: 'http://localhost:11434',
  model: '',
  mode: 'guarded',
  chatMode: 'ask',
  maxContextFiles: 5,
  maxContextCharacters: 12000,
  contextWindow: 8192,
  autoIncludeCurrentFile: false,
  includeDiagnostics: false,
  temperature: 0.2,
  saveTranscripts: true,
  debugLogging: false,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalises the trailing slash and validates the scheme. Returns undefined when invalid. */
export function normalizeEndpoint(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

/** True for endpoints on this machine; used to warn when code would leave the machine. */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Turns raw configuration values into validated settings with sensible bounds. */
export function normalizeSettings(raw: Partial<Record<keyof Settings, unknown>>): Settings {
  const d = DEFAULT_SETTINGS;
  const endpointRaw = typeof raw.ollamaEndpoint === 'string' ? raw.ollamaEndpoint : d.ollamaEndpoint;
  return {
    ollamaEndpoint: normalizeEndpoint(endpointRaw) ?? endpointRaw.trim(),
    model: typeof raw.model === 'string' ? raw.model.trim() : d.model,
    mode: raw.mode === 'normal' ? 'normal' : 'guarded',
    chatMode: raw.chatMode === 'plan' || raw.chatMode === 'agent' ? raw.chatMode : 'ask',
    maxContextFiles: clampInt(raw.maxContextFiles, 0, 20, d.maxContextFiles),
    maxContextCharacters: clampInt(raw.maxContextCharacters, 1000, 200000, d.maxContextCharacters),
    contextWindow: clampInt(raw.contextWindow, 2048, 131072, d.contextWindow),
    autoIncludeCurrentFile: raw.autoIncludeCurrentFile === true,
    includeDiagnostics: raw.includeDiagnostics === true,
    temperature: clampNum(raw.temperature, 0, 2, d.temperature),
    saveTranscripts: raw.saveTranscripts !== false,
    debugLogging: raw.debugLogging === true,
  };
}
