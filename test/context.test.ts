import { describe, expect, it } from 'vitest';
import { parseReferences, resolveFileReference, toSafeRelativePath } from '../src/context/References';
import {
  ContextRetriever,
  extractImportTargets,
  extractSnippets,
  matchImportTargets,
  scorePath,
  summarizeTree,
  tokenizeQuery,
} from '../src/context/ContextRetriever';
import { buildContext, type ContextRequest } from '../src/context/ContextBuilder';
import { fileContextItem, truncateText, withLineNumbers } from '../src/context/FileContext';
import { selectionContextItem } from '../src/context/SelectionContext';
import {
  diagnosticsContextItem,
  selectDiagnostics,
  type DiagnosticEntry,
} from '../src/context/DiagnosticsContext';
import { MemoryWorkspace, SAMPLE_REPO } from './helpers/memoryWorkspace';

describe('file references', () => {
  it('parses all reference forms and rewrites them for the model', () => {
    const r = parseReferences(
      'Explain @file:src/server.ts and @file "my file.ts" with @selection, @workspace and @diagnostics.',
    );
    expect(r.files).toEqual(['src/server.ts', 'my file.ts']);
    expect(r.selection && r.workspace && r.diagnostics).toBe(true);
    expect(r.text).toBe(
      'Explain src/server.ts and my file.ts with the selected code, this workspace and the current diagnostics.',
    );
  });

  it('supports "@file name" and trailing punctuation', () => {
    const r = parseReferences('what does @file server.cpp do?');
    expect(r.files).toEqual(['server.cpp']);
  });

  it('ignores emails and unknown mentions', () => {
    const r = parseReferences('mail me at a@b.com or ping @someone');
    expect(r.files).toEqual([]);
    expect(r.text).toBe('mail me at a@b.com or ping @someone');
  });

  it('refuses paths that escape the workspace', () => {
    expect(toSafeRelativePath('../etc/passwd')).toBeUndefined();
    expect(toSafeRelativePath('/etc/passwd')).toBeUndefined();
    expect(toSafeRelativePath('C:\\Windows\\win.ini')).toBeUndefined();
    expect(toSafeRelativePath('~/.ssh/id_rsa')).toBeUndefined();
    expect(toSafeRelativePath('./src\\a.ts')).toBe('src/a.ts');
  });

  it('resolves unique suffixes and reports ambiguity', () => {
    const idx = ['src/server.ts', 'src/auth/index.ts', 'src/db/index.ts'];
    expect(resolveFileReference('server.ts', idx).match).toBe('src/server.ts');
    expect(resolveFileReference('index.ts', idx).match).toBeUndefined();
    expect(resolveFileReference('index.ts', idx).candidates).toHaveLength(2);
  });
});

describe('file, selection and diagnostic context extraction', () => {
  it('numbers lines and truncates at line boundaries', () => {
    expect(withLineNumbers('a\nb', 9)).toBe(' 9 | a\n10 | b');
    const t = truncateText('line1\nline2\nline3\nline4', 14);
    expect(t.truncated).toBe(true);
    expect(t.text).toBe('line1\nline2');
  });

  it('builds a file item with language and truncation marker', () => {
    const item = fileContextItem('src/a.ts', 'x'.repeat(5000), 1000);
    expect(item.language).toBe('typescript');
    expect(item.truncated).toBe(true);
    expect(item.content).toContain('[file truncated');
    expect(item.content.length).toBeLessThan(1100);
  });

  it('labels selections with their line range', () => {
    const item = selectionContextItem(
      { relPath: 'src/a.ts', startLine: 4, endLine: 6, text: 'a\nb\nc' },
      1000,
    )!;
    expect(item.label).toBe('src/a.ts:4-6 (selection)');
    expect(item.content.split('\n')[0]).toBe('4 | a');
    expect(
      selectionContextItem({ relPath: 'a', startLine: 1, endLine: 1, text: '   ' }, 100),
    ).toBeUndefined();
  });

  it('collects errors and warnings with file and line', () => {
    const entries: DiagnosticEntry[] = [
      {
        relPath: 'b.ts',
        line: 3,
        column: 1,
        severity: 'warning',
        message: 'unused  var',
        source: 'ts',
        code: '6133',
      },
      {
        relPath: 'a.ts',
        line: 10,
        column: 5,
        severity: 'error',
        message: "Cannot find name 'x'.",
        source: 'ts',
        code: '2304',
      },
      { relPath: 'a.ts', line: 1, column: 1, severity: 'hint', message: 'hint' },
    ];
    expect(selectDiagnostics(entries).map((d) => d.severity)).toEqual(['error', 'warning']);
    const item = diagnosticsContextItem(entries);
    expect(item.label).toBe('Diagnostics (1 errors, 1 warnings)');
    expect(item.content).toContain("ERROR a.ts:10:5 [ts 2304] Cannot find name 'x'.");
    expect(item.content).toContain('WARNING b.ts:3:1 [ts 6133] unused var');
  });
});

describe('context retrieval', () => {
  it('tokenises questions into useful search terms', () => {
    const t = tokenizeQuery('Where is authentication handled in the RequestHandler?');
    expect(t).toContain('authentication');
    expect(t).toContain('auth');
    expect(t).toContain('request');
    expect(t).not.toContain('where');
    expect(t).not.toContain('handled');
  });

  it('scores paths by name matches', () => {
    expect(scorePath('src/auth/AuthService.ts', ['auth'])).toBeGreaterThan(
      scorePath('src/server.ts', ['auth']),
    );
    expect(scorePath('src/resources/x.ts', ['res'])).toBe(0);
  });

  it('extracts windows around matches within the budget', () => {
    const content = Array.from({ length: 100 }, (_, i) =>
      i === 50 ? 'function verifyToken() {}' : `line ${i}`,
    ).join('\n');
    const snippets = extractSnippets(content, ['verifytoken'], 2000, 3);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]!.startLine).toBe(48);
    expect(snippets[0]!.text).toContain('51 | function verifyToken');
  });

  it('finds the files related to a question', async () => {
    const ws = new MemoryWorkspace(SAMPLE_REPO);
    const snippets = await new ContextRetriever(ws).retrieve('Where is authentication handled?', {
      maxFiles: 3,
      maxChars: 4000,
    });
    const files = [...new Set(snippets.map((s) => s.relPath))];
    expect(files.slice(0, 2).sort()).toEqual(['src/auth/AuthService.ts', 'src/middleware/auth.ts']);
  });

  it('finds database connection code', async () => {
    const ws = new MemoryWorkspace(SAMPLE_REPO);
    const snippets = await new ContextRetriever(ws).retrieve(
      'What files are related to database connections?',
      { maxFiles: 2, maxChars: 4000 },
    );
    expect(snippets[0]!.relPath).toBe('src/db/pool.ts');
  });

  it('respects file and character limits', async () => {
    const ws = new MemoryWorkspace(SAMPLE_REPO);
    const snippets = await new ContextRetriever(ws).retrieve('orders pool auth token express', {
      maxFiles: 2,
      maxChars: 600,
    });
    expect(new Set(snippets.map((s) => s.relPath)).size).toBeLessThanOrEqual(2);
    expect(snippets.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(600);
  });

  it('summarises the tree without file contents', () => {
    const tree = summarizeTree(Object.keys(SAMPLE_REPO).map((relPath) => ({ relPath, size: 0 })));
    expect(tree).toContain('src/ (5 files)');
    expect(tree).toContain('README.md');
    expect(tree).not.toContain('express');
  });

  it('follows relative imports', () => {
    const targets = extractImportTargets('src/server.ts', SAMPLE_REPO['src/server.ts']!);
    expect(targets).toEqual(['src/routes/orders', 'src/middleware/auth']);
    expect(matchImportTargets(targets, Object.keys(SAMPLE_REPO))).toEqual([
      'src/routes/orders.ts',
      'src/middleware/auth.ts',
    ]);
  });
});

describe('context building and size limits', () => {
  const baseReq = (text: string, over: Partial<ContextRequest> = {}): ContextRequest => ({
    refs: parseReferences(text),
    includeCurrentFile: false,
    includeSelection: false,
    includeDiagnostics: false,
    retrieve: true,
    ...over,
  });
  const deps = (ws: MemoryWorkspace, over: Record<string, unknown> = {}) => {
    const d = {
      source: ws,
      retriever: new ContextRetriever(ws),
      editor: { openFiles: [] as string[] },
      getDiagnostics: () => [] as DiagnosticEntry[],
      maxContextFiles: 5,
      maxContextCharacters: 6000,
    };
    return { ...d, ...over } as Parameters<typeof buildContext>[1];
  };

  it('includes explicit files first and never exceeds the character budget', async () => {
    const ws = new MemoryWorkspace({ ...SAMPLE_REPO, 'src/big.ts': 'x\n'.repeat(20000) });
    const bundle = await buildContext(
      baseReq('explain @file:src/big.ts'),
      deps(ws, { maxContextCharacters: 3000 }),
    );
    expect(bundle.items[0]!.relPath).toBe('src/big.ts');
    expect(bundle.items[0]!.truncated).toBe(true);
    expect(bundle.totalChars).toBeLessThanOrEqual(3100);
  });

  it('never sends the whole repository', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      files[`src/mod${i}.ts`] = `export const handler${i} = () => 'orders';\n`.repeat(20);
    }
    const ws = new MemoryWorkspace(files);
    const bundle = await buildContext(baseReq('where are orders handled'), deps(ws));
    expect(bundle.items.length).toBeLessThanOrEqual(5 * 4);
    expect(new Set(bundle.items.map((i) => i.relPath)).size).toBeLessThanOrEqual(5);
    expect(bundle.totalChars).toBeLessThanOrEqual(6000);
  });

  it('refuses references outside the workspace and explains missing files', async () => {
    const ws = new MemoryWorkspace(SAMPLE_REPO);
    const bundle = await buildContext(
      baseReq('look at @file:../../etc/passwd and @file:nope.ts', { retrieve: false }),
      deps(ws),
    );
    expect(bundle.items).toHaveLength(0);
    expect(bundle.notes.join(' ')).toMatch(/outside the workspace/);
    expect(bundle.notes.join(' ')).toMatch(/Couldn't read `nope.ts`/);
    expect(ws.reads).not.toContain('../../etc/passwd');
  });

  it('adds selection, current file, diagnostics and workspace tree when asked', async () => {
    const ws = new MemoryWorkspace(SAMPLE_REPO);
    const bundle = await buildContext(
      baseReq('what is wrong with @selection in @workspace? @diagnostics', { includeCurrentFile: true }),
      deps(ws, {
        editor: {
          openFiles: ['src/db/pool.ts'],
          activeFile: { relPath: 'src/db/pool.ts', content: SAMPLE_REPO['src/db/pool.ts']! },
          selection: { relPath: 'src/db/pool.ts', startLine: 10, endLine: 14, text: 'async query(sql) {}' },
        },
        getDiagnostics: () => [
          { relPath: 'src/db/pool.ts', line: 4, column: 1, severity: 'error', message: 'boom' },
        ],
      }),
    );
    expect(bundle.items.map((i) => i.kind).slice(0, 4)).toEqual([
      'selection',
      'current-file',
      'diagnostics',
      'workspace',
    ]);
    expect(bundle.sources[0]).toBe('src/db/pool.ts:10-14 (selection)');
  });

  it('notes when there is no selection or open file', async () => {
    const ws = new MemoryWorkspace(SAMPLE_REPO);
    const bundle = await buildContext(
      baseReq('explain @selection', { includeCurrentFile: true, retrieve: false }),
      deps(ws),
    );
    expect(bundle.notes).toEqual([
      'No code is selected, so no selection was included.',
      'No file is open in the editor, so no current file was included.',
    ]);
  });

  it('mentions large repositories', async () => {
    const ws = new MemoryWorkspace(SAMPLE_REPO);
    ws.large = true;
    const bundle = await buildContext(baseReq('hi'), deps(ws));
    expect(bundle.notes.join(' ')).toMatch(/repository is large/);
  });
});
