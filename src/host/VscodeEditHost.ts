import * as vscode from 'vscode';
import type { EditHost } from '../agent/EditManager';
import type { WorkspaceIndexer } from '../context/WorkspaceIndexer';
import { PROPOSED_EDIT_SCHEME } from '../constants';

/** Files larger than this are not edited by the agent. */
const MAX_EDIT_BYTES = 1024 * 1024;

/**
 * File access for Agent mode, on top of the VS Code API.
 * - Reads prefer the open editor buffer, so unsaved changes are respected.
 * - Writes go through a WorkspaceEdit (so Undo works) and are then saved.
 * - Proposed content is served read-only for the diff view and never written until accepted.
 */
export class VscodeEditHost implements EditHost, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly proposed = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor(private readonly indexer: WorkspaceIndexer) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(PROPOSED_EDIT_SCHEME, this);
  }

  dispose(): void {
    this.registration.dispose();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.proposed.get(uri.query) ?? '';
  }

  async listFiles(): Promise<string[]> {
    return (await this.indexer.listFiles()).map((f) => f.relPath);
  }

  async readFile(relPath: string): Promise<string | undefined> {
    const uri = this.uriFor(relPath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
    if (stat.type & vscode.FileType.Directory) throw new Error(`${relPath} is a folder.`);
    if (stat.size > MAX_EDIT_BYTES) throw new Error(`${relPath} is too large to edit.`);
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const uri = this.uriFor(relPath);
    const edit = new vscode.WorkspaceEdit();
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    if (exists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      edit.replace(uri, full, content);
    } else {
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), content);
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Couldn't apply the edit to ${relPath}.`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await doc.save();
  }

  async deleteFile(relPath: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(this.uriFor(relPath), { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(edit);
  }

  async showDiff(e: {
    id: string;
    path: string;
    original: string;
    proposed: string;
    isNew: boolean;
  }): Promise<void> {
    this.proposed.set(e.id, e.proposed);
    this.proposed.set(`${e.id}-original`, e.original);
    const right = vscode.Uri.from({ scheme: PROPOSED_EDIT_SCHEME, path: `/${e.path}`, query: e.id });
    // Left side is the file as it was when the edit was proposed.
    const left = vscode.Uri.from({
      scheme: PROPOSED_EDIT_SCHEME,
      path: `/${e.path}`,
      query: `${e.id}-original`,
    });
    const name = e.path.split('/').pop() ?? e.path;
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${name} ${e.isNew ? '(new file)' : ''} ↔ Proposed edit`.replace('  ', ' '),
      { preview: true },
    );
  }

  async closeDiff(id: string): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputTextDiff &&
          t.input.modified.scheme === PROPOSED_EDIT_SCHEME &&
          t.input.modified.query === id,
      );
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  private uriFor(relPath: string): vscode.Uri {
    const uri = this.indexer.resolve(relPath);
    if (!uri) throw new Error(`${relPath} is not inside the workspace.`);
    return uri;
  }
}
