import * as vscode from 'vscode';
import type { IndexedFile, WorkspaceSource } from './ContextRetriever';
import { IgnoreMatcher } from './IgnoreMatcher';
import {
  DEFAULT_EXCLUDE_GLOB,
  FULL_CONTENT_SEARCH_LIMIT,
  MAX_INDEX_FILES,
  MAX_READ_BYTES,
  isIndexablePath,
  looksBinary,
} from './fileFilters';
import { toSafeRelativePath } from './References';
import type { Logger } from '../utils/logger';
import { describeForLog } from '../utils/errors';

interface CacheEntry {
  mtime: number;
  text: string | undefined;
}

const CACHE_LIMIT = 300;
const SYMBOL_TIMEOUT_MS = 1500;

/**
 * Lightweight, local, lazily-built index of the workspace's source files.
 * - Built on first use (never on activation) and rebuilt only when files are created/deleted.
 * - Skips default ignored directories, binaries, generated files and .gitignore'd paths.
 * - Reads file contents on demand with a small mtime-validated cache.
 * Nothing is uploaded anywhere.
 */
export class WorkspaceIndexer implements WorkspaceSource, vscode.Disposable {
  private files: IndexedFile[] | undefined;
  private uriByRel = new Map<string, vscode.Uri>();
  private building: Promise<IndexedFile[]> | undefined;
  private truncated = false;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private dirtyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly logger: Logger) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate((uri) => this.onStructureChanged(uri), null, this.disposables);
    watcher.onDidDelete((uri) => this.onStructureChanged(uri), null, this.disposables);
    watcher.onDidChange((uri) => this.onContentChanged(uri), null, this.disposables);
    this.disposables.push(watcher);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()));
  }

  dispose(): void {
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    for (const d of this.disposables) d.dispose();
  }

  isLarge(): boolean {
    return this.truncated || (this.files?.length ?? 0) > FULL_CONTENT_SEARCH_LIMIT;
  }

  /** Starts indexing in the background (used when the chat view opens). */
  warmUp(): void {
    if (vscode.workspace.workspaceFolders?.length) void this.listFiles().catch(() => undefined);
  }

  async listFiles(signal?: AbortSignal): Promise<IndexedFile[]> {
    if (this.files) return this.files;
    if (!this.building) {
      this.building = this.build(signal).finally(() => {
        this.building = undefined;
      });
    }
    return this.building;
  }

  async readFile(relPath: string): Promise<string | undefined> {
    const uri = this.resolve(relPath);
    if (!uri) return undefined;
    const key = uri.toString();

    // Prefer the editor buffer so unsaved changes are what the candidate sees.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (open) return open.getText().length > MAX_READ_BYTES ? undefined : open.getText();

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
    if (stat.type & vscode.FileType.Directory || stat.size > MAX_READ_BYTES) return undefined;
    const cached = this.cache.get(key);
    if (cached && cached.mtime === stat.mtime) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.text;
    }
    let text: string | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = looksBinary(bytes) ? undefined : new TextDecoder('utf-8').decode(bytes);
    } catch (err) {
      this.logger.debug(`Could not read ${relPath}: ${describeForLog(err)}`);
      text = undefined;
    }
    this.cache.set(key, { mtime: stat.mtime, text });
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return text;
  }

  async findSymbolFiles(query: string, signal?: AbortSignal): Promise<string[]> {
    if (!query.trim()) return [];
    const lookup = vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      query,
    );
    const timeout = new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), SYMBOL_TIMEOUT_MS);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve(undefined);
      });
    });
    const symbols = await Promise.race([
      lookup.then(
        (s) => s,
        () => undefined,
      ),
      timeout,
    ]);
    if (!symbols) return [];
    const out = new Set<string>();
    for (const s of symbols.slice(0, 50)) {
      const rel = this.toRelative(s.location.uri);
      if (rel && this.uriByRel.has(rel)) out.add(rel);
    }
    return [...out].slice(0, 5);
  }

  /** Workspace-relative path for a URI inside the workspace, or undefined. */
  toRelative(uri: vscode.Uri): string | undefined {
    if (!vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
  }

  /** Resolves a workspace-relative path to a URI that is guaranteed to be inside the workspace. */
  resolve(relPath: string): vscode.Uri | undefined {
    const safe = toSafeRelativePath(relPath);
    if (!safe) return undefined;
    const indexed = this.uriByRel.get(safe);
    if (indexed) return indexed;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) return undefined;
    if (folders.length === 1) return vscode.Uri.joinPath(folders[0]!.uri, safe);
    const [first, ...rest] = safe.split('/');
    const folder = folders.find((f) => f.name === first);
    return folder && rest.length ? vscode.Uri.joinPath(folder.uri, ...rest) : undefined;
  }

  invalidate(): void {
    this.files = undefined;
    this.uriByRel.clear();
    this.cache.clear();
  }

  private onStructureChanged(uri: vscode.Uri): void {
    const rel = this.toRelative(uri);
    if (!rel || !this.files) return;
    if (!isIndexablePath(rel) && !rel.endsWith('.gitignore')) return;
    // Debounce bursts (git checkout, npm install) into a single rebuild on next use.
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = setTimeout(() => {
      this.files = undefined;
      this.uriByRel.clear();
    }, 1000);
  }

  private onContentChanged(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
    if (uri.path.endsWith('/.gitignore')) this.onStructureChanged(uri);
  }

  private async build(signal?: AbortSignal): Promise<IndexedFile[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.files = [];
      return this.files;
    }
    const started = Date.now();
    const cts = new vscode.CancellationTokenSource();
    signal?.addEventListener('abort', () => cts.cancel(), { once: true });
    try {
      const ignore = await this.loadGitignores(folders, cts.token);
      const uris = await vscode.workspace.findFiles(
        '**/*',
        DEFAULT_EXCLUDE_GLOB,
        MAX_INDEX_FILES + 1,
        cts.token,
      );
      this.truncated = uris.length > MAX_INDEX_FILES;
      const multiRoot = folders.length > 1;
      const files: IndexedFile[] = [];
      const byRel = new Map<string, vscode.Uri>();
      for (const uri of uris.slice(0, MAX_INDEX_FILES)) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) continue;
        const folderRel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        if (!isIndexablePath(folderRel)) continue;
        if (ignore.get(folder.uri.toString())?.ignores(folderRel)) continue;
        const rel = multiRoot ? `${folder.name}/${folderRel}` : folderRel;
        files.push({ relPath: rel, size: 0 });
        byRel.set(rel, uri);
      }
      files.sort((a, b) => a.relPath.localeCompare(b.relPath));
      this.files = files;
      this.uriByRel = byRel;
      this.logger.info(
        `Indexed ${files.length} files in ${Date.now() - started} ms${this.truncated ? ' (truncated)' : ''}`,
      );
      return files;
    } finally {
      cts.dispose();
    }
  }

  private async loadGitignores(
    folders: readonly vscode.WorkspaceFolder[],
    token: vscode.CancellationToken,
  ): Promise<Map<string, IgnoreMatcher>> {
    const matchers = new Map<string, IgnoreMatcher>();
    for (const f of folders) matchers.set(f.uri.toString(), new IgnoreMatcher());
    let gitignores: vscode.Uri[];
    try {
      gitignores = await vscode.workspace.findFiles('**/.gitignore', DEFAULT_EXCLUDE_GLOB, 500, token);
    } catch {
      return matchers;
    }
    for (const uri of gitignores) {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) continue;
      try {
        const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
        const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        const base = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        matchers.get(folder.uri.toString())?.add(text, base);
      } catch {
        // Unreadable .gitignore: skip.
      }
    }
    return matchers;
  }
}
