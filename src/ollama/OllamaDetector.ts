import * as path from 'node:path';
import type { ConnectionStatus } from './OllamaClient';
import { isLocalEndpoint } from '../settings/settings';

export type OllamaAvailability =
  | { state: 'running'; version: string }
  | { state: 'installed-not-running' }
  | { state: 'not-installed' }
  /** A non-local endpoint we can't reach; we can't tell whether Ollama is installed there. */
  | { state: 'unreachable-remote' };

export interface DetectorEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  exists: (p: string) => Promise<boolean>;
}

/**
 * Well-known install locations. Detection only checks whether files exist; it never runs
 * the Ollama binary or any other process.
 */
export function candidateInstallPaths(e: DetectorEnv): string[] {
  const exe = e.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const pathSep = e.platform === 'win32' ? ';' : ':';
  const join = e.platform === 'win32' ? path.win32.join : path.posix.join;
  const pathVar = e.env.PATH ?? e.env.Path ?? '';
  const fromPath = pathVar
    .split(pathSep)
    .filter(Boolean)
    .map((dir) => join(dir, exe));

  const known: string[] = [];
  if (e.platform === 'darwin') {
    known.push('/Applications/Ollama.app', join(e.homedir, 'Applications', 'Ollama.app'));
    known.push('/usr/local/bin/ollama', '/opt/homebrew/bin/ollama');
  } else if (e.platform === 'win32') {
    const local = e.env.LOCALAPPDATA ?? join(e.homedir, 'AppData', 'Local');
    known.push(join(local, 'Programs', 'Ollama', 'ollama.exe'));
  } else {
    known.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama');
  }
  return [...new Set([...known, ...fromPath])];
}

export async function isOllamaInstalled(e: DetectorEnv): Promise<boolean> {
  for (const p of candidateInstallPaths(e)) {
    if (await e.exists(p)) return true;
  }
  return false;
}

/** Combines the HTTP probe with a filesystem check to explain *why* Ollama isn't usable. */
export async function detectOllama(
  endpoint: string,
  probe: () => Promise<ConnectionStatus>,
  e: DetectorEnv,
): Promise<OllamaAvailability> {
  const status = await probe();
  if (status.state === 'running') return { state: 'running', version: status.version };
  if (!isLocalEndpoint(endpoint)) return { state: 'unreachable-remote' };
  return (await isOllamaInstalled(e)) ? { state: 'installed-not-running' } : { state: 'not-installed' };
}
