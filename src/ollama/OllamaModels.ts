import type { OllamaModel } from './OllamaClient';

/** Suggested small models for the guided download flow. Sizes are approximate. */
export interface SuggestedModel {
  name: string;
  approxSize: string;
  description: string;
}

export const SUGGESTED_MODELS: SuggestedModel[] = [
  {
    name: 'qwen2.5-coder:7b',
    approxSize: '~4.7 GB',
    description: 'Strong code understanding; good default on machines with 16 GB RAM.',
  },
  {
    name: 'llama3.2:3b',
    approxSize: '~2.0 GB',
    description: 'General-purpose and fast; fine on 8 GB RAM.',
  },
  {
    name: 'qwen2.5-coder:1.5b',
    approxSize: '~1.0 GB',
    description: 'Very small and fast; answers are less detailed.',
  },
];

/** Names that indicate an embedding-only model, which cannot chat. */
const EMBEDDING_HINTS = /(embed|bge-|minilm|nomic-embed|mxbai-embed|all-minilm|snowflake-arctic-embed)/i;

export function isLikelyChatModel(model: OllamaModel): boolean {
  return !EMBEDDING_HINTS.test(model.name) && !EMBEDDING_HINTS.test(model.family ?? '');
}

/** Chat-capable models first, then alphabetical. */
export function sortModels(models: OllamaModel[]): OllamaModel[] {
  return [...models].sort((a, b) => {
    const ca = isLikelyChatModel(a) ? 0 : 1;
    const cb = isLikelyChatModel(b) ? 0 : 1;
    return ca - cb || a.name.localeCompare(b.name);
  });
}

/**
 * Chooses the model to use: the configured one if still installed; otherwise the first
 * chat-capable model. Returns `missing` when the configured model has disappeared.
 */
export function resolveModel(
  configured: string,
  models: OllamaModel[],
): { model: string | undefined; missing: boolean } {
  if (models.length === 0) return { model: undefined, missing: configured !== '' };
  if (configured) {
    const exact = models.find((m) => m.name === configured);
    if (exact) return { model: exact.name, missing: false };
    // "llama3.2" should match "llama3.2:latest".
    const tagged = models.find((m) => m.name === `${configured}:latest`);
    if (tagged) return { model: tagged.name, missing: false };
    return { model: undefined, missing: true };
  }
  const first = sortModels(models).find(isLikelyChatModel);
  return { model: first?.name, missing: false };
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Ollama model names: letters, digits, dots, dashes, underscores, slashes and one tag. */
export function isValidModelName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._\-/]{0,127}(:[a-zA-Z0-9._-]{1,64})?$/.test(name.trim());
}
