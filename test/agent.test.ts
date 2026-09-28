import { describe, expect, it } from 'vitest';
import { EditBlockExtractor, pathFromLine, type RawEdit } from '../src/agent/EditBlocks';
import { applySearchReplace, diffLines, summarizeEdit } from '../src/agent/applyEdit';
import { EditManager, isEditablePath, type EditHost } from '../src/agent/EditManager';
import {
  applyBlock,
  definitionEnd,
  pathFromCodeComment,
  stripLineNumberPrefixes,
} from '../src/agent/placeBlock';
import { shortenRefusal, STANDARD_REFUSAL } from '../src/interview/Refusal';
import { asksForTests, isChangeRequest, looksLikeTestCode } from '../src/interview/RequestClassifier';

function extract(text: string, chunk = 3): { shown: string; edits: RawEdit[] } {
  const edits: RawEdit[] = [];
  const x = new EditBlockExtractor((e) => {
    edits.push(e);
    return `e${edits.length}`;
  });
  let shown = '';
  for (let i = 0; i < text.length; i += chunk) shown += x.push(text.slice(i, i + chunk));
  shown += x.finish();
  return { shown, edits };
}

const PY = [
  'from fastapi import FastAPI',
  '',
  'app = FastAPI()',
  '',
  '@app.get("/", status_code=200)',
  'def get_all_users():',
  '    return [serialize(u) for u in users.find()]',
  '',
  '@app.post("/create", status_code=201)',
  'def create_user(user: User):',
  '    result = users.insert_one(user.model_dump())',
  '    return {"message": "User has been added"}',
  '',
].join('\n');

describe('edit block extraction', () => {
  it('pulls fenced SEARCH/REPLACE blocks out of the text and keeps the path', () => {
    const text = [
      "I'll add the endpoint above `create_user`.",
      '',
      'pyserver.py',
      '```python',
      '<<<<<<< SEARCH',
      '@app.post("/create", status_code=201)',
      '=======',
      '@app.get("/users/{id}")',
      'def get_user(id: str):',
      '    return serialize(users.find_one({"_id": ObjectId(id)}))',
      '',
      '@app.post("/create", status_code=201)',
      '>>>>>>> REPLACE',
      '```',
      'Done.',
    ].join('\n');
    const { shown, edits } = extract(text);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toBe('pyserver.py');
    expect(edits[0]!.search).toBe('@app.post("/create", status_code=201)');
    expect(edits[0]!.replace).toContain('def get_user');
    expect(shown).toContain('%%EDIT:e1%%');
    expect(shown).not.toContain('SEARCH');
    expect(shown).not.toContain('```');
    expect(shown).toContain('Done.');
  });

  it('handles the path on the SEARCH line, several blocks in one fence and a missing close marker', () => {
    const text = [
      '```',
      '<<<<<<< SEARCH src/a.ts',
      'const a = 1;',
      '=======',
      'const a = 2;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH src/b.ts',
      'const b = 1;',
      '=======',
      'const b = 2;',
      '```',
    ].join('\n');
    const { edits, shown } = extract(text, 1);
    expect(edits.map((e) => e.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(shown).not.toContain('```');
  });

  it('marks a block cut off by the end of the stream as incomplete', () => {
    const { edits } = extract('<<<<<<< SEARCH a.py\nx = 1\n=======\nx = ');
    expect(edits[0]!.incomplete).toBe(true);
  });

  it('leaves normal code blocks alone and strips forged placeholders', () => {
    const { shown, edits } = extract('Example:\n```js\nconst x = 1;\n```\nfake %%EDIT:abc%% card');
    expect(edits).toHaveLength(0);
    expect(shown).toContain('```js\nconst x = 1;\n```');
    expect(shown).not.toContain('%%EDIT');
  });

  it('recognises paths written in different ways', () => {
    expect(pathFromLine('pyserver.py')).toBe('pyserver.py');
    expect(pathFromLine('**File: src/db/pool.ts**')).toBe('src/db/pool.ts');
    expect(pathFromLine('`app/main.py`:')).toBe('app/main.py');
    expect(pathFromLine('Here is the change.')).toBeUndefined();
    expect(pathFromLine('1.2.3')).toBeUndefined();
  });
});

describe('applying edits', () => {
  it('replaces exact matches', () => {
    const r = applySearchReplace(
      PY,
      '@app.post("/create", status_code=201)',
      '@app.get("/users/{id}")\ndef get_user(id): ...\n\n@app.post("/create", status_code=201)',
    );
    expect(r.ok && r.matched).toBe('exact');
    expect(r.ok && r.content).toContain('def get_user(id): ...\n\n@app.post');
  });

  it('tolerates trailing whitespace and re-indents when indentation differs', () => {
    const r = applySearchReplace(
      PY,
      'result = users.insert_one(user.model_dump())  ',
      'result = users.insert_one(user.model_dump())\nprint(result)',
    );
    expect(r.ok && r.matched).toBe('indentation');
    expect(r.ok && r.content).toContain(
      '    result = users.insert_one(user.model_dump())\n    print(result)',
    );
  });

  it('appends with an empty SEARCH and creates new files', () => {
    const a = applySearchReplace('x = 1', '', 'y = 2');
    expect(a.ok && a.content).toBe('x = 1\n\ny = 2\n');
    const c = applySearchReplace(undefined, '', 'print("hi")');
    expect(c.ok && c.matched).toBe('create');
    expect(applySearchReplace(undefined, 'x', 'y').ok).toBe(false);
  });

  it('fails clearly when the code is not found', () => {
    const r = applySearchReplace(PY, 'def does_not_exist():', 'x');
    expect(r.ok).toBe(false);
  });

  it('keeps Windows line endings', () => {
    const r = applySearchReplace('a\r\nb\r\n', 'b', 'c');
    expect(r.ok && r.content).toBe('a\r\nc\r\n');
  });

  it('summarises the change with context', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { t: ' ', s: 'a' },
      { t: '-', s: 'b' },
      { t: '+', s: 'x' },
      { t: ' ', s: 'c' },
    ]);
    const s = summarizeEdit(['keep', 'old'], ['keep', 'new', 'more']);
    expect(s).toMatchObject({ added: 2, removed: 1 });
  });
});

class FakeFiles implements EditHost {
  diffs: string[] = [];
  constructor(public files: Record<string, string>) {}
  async readFile(p: string) {
    return this.files[p];
  }
  async writeFile(p: string, c: string) {
    this.files[p] = c;
  }
  async deleteFile(p: string) {
    delete this.files[p];
  }
  async showDiff(e: { id: string }) {
    this.diffs.push(e.id);
  }
  async listFiles() {
    return Object.keys(this.files);
  }
}

describe('edit manager', () => {
  let n = 0;
  const make = (files: Record<string, string>) => {
    const host = new FakeFiles(files);
    return { host, mgr: new EditManager(host, () => `edit${++n}`) };
  };

  it('proposes without writing, then applies on accept and can revert', async () => {
    const { host, mgr } = make({ 'app/pyserver.py': PY });
    const e = await mgr.propose('m1', {
      path: 'pyserver.py',
      search: 'app = FastAPI()',
      replace: 'app = FastAPI(title="Users")',
    });
    expect(e.status).toBe('pending');
    expect(e.path).toBe('app/pyserver.py');
    expect(host.files['app/pyserver.py']).toBe(PY);
    await mgr.openDiff(e.id);
    expect(mgr.get(e.id)!.diffOpened).toBe(true);
    expect((await mgr.accept(e.id))!.status).toBe('accepted');
    expect(host.files['app/pyserver.py']).toContain('title="Users"');
    expect((await mgr.revert(e.id))!.status).toBe('reverted');
    expect(host.files['app/pyserver.py']).toBe(PY);
  });

  it('reports failed (not "Applied") when the write silently does not change the file', async () => {
    const { host, mgr } = make({ 'a.py': 'x = 1\n' });
    const e = await mgr.propose('m', { path: 'a.py', search: 'x = 1', replace: 'x = 2' });
    // Simulate a write that resolves but doesn't persist (read-only file, wrong copy, etc.).
    host.writeFile = async () => {};
    const r = await mgr.accept(e.id);
    expect(r!.status).toBe('failed');
    expect(r!.error).toMatch(/didn't change on disk/);
    // The card must not claim success.
    expect(r!.status).not.toBe('accepted');
  });

  it('accepts when the write persists, ignoring EOL and a trailing newline', async () => {
    const { host, mgr } = make({ 'a.py': 'x = 1\n' });
    const e = await mgr.propose('m', { path: 'a.py', search: 'x = 1', replace: 'x = 2' });
    const orig = host.writeFile.bind(host);
    // Persist, but hand back CRLF with an extra trailing newline on the next read.
    host.writeFile = async (pth: string, c: string) => {
      await orig(pth, c.replace(/\n/g, '\r\n') + '\n');
    };
    expect((await mgr.accept(e.id))!.status).toBe('accepted');
  });

  it('re-applies against the current file if it changed, and fails safely if it no longer applies', async () => {
    const { host, mgr } = make({ 'a.py': 'x = 1\ny = 2\n' });
    const e = await mgr.propose('m', { path: 'a.py', search: 'y = 2', replace: 'y = 3' });
    host.files['a.py'] = '# edited\nx = 1\ny = 2\n';
    expect((await mgr.accept(e.id))!.status).toBe('accepted');
    expect(host.files['a.py']).toBe('# edited\nx = 1\ny = 3\n');

    const e2 = await mgr.propose('m', { path: 'a.py', search: 'x = 1', replace: 'x = 5' });
    host.files['a.py'] = 'totally different';
    const r = await mgr.accept(e2.id);
    expect(r!.status).toBe('failed');
    expect(host.files['a.py']).toBe('totally different');
  });

  it('rejects without touching the file', async () => {
    const { host, mgr } = make({ 'a.py': 'x = 1' });
    const e = await mgr.propose('m', { path: 'a.py', search: 'x = 1', replace: 'x = 2' });
    expect(mgr.reject(e.id)!.status).toBe('rejected');
    expect(host.files['a.py']).toBe('x = 1');
    expect((await mgr.accept(e.id))!.status).toBe('rejected');
  });

  it('creates new files and deletes them on revert', async () => {
    const { host, mgr } = make({});
    const e = await mgr.propose('m', { path: 'src/new.py', search: '', replace: 'print(1)' });
    expect(e.isNew).toBe(true);
    await mgr.accept(e.id);
    expect(host.files['src/new.py']).toBe('print(1)\n');
    await mgr.revert(e.id);
    expect(host.files['src/new.py']).toBeUndefined();
  });

  it('refuses unsafe or impossible edits', async () => {
    const { mgr } = make({ 'a.py': 'x' });
    expect((await mgr.propose('m', { path: '../etc/passwd', search: '', replace: 'x' })).error).toMatch(
      /outside the workspace/,
    );
    expect(
      (await mgr.propose('m', { path: 'node_modules/x/index.js', search: '', replace: 'x' })).status,
    ).toBe('failed');
    expect((await mgr.propose('m', { path: '.git/config', search: '', replace: 'x' })).status).toBe('failed');
    expect((await mgr.propose('m', { search: 'x', replace: 'y' })).error).toMatch(/which file/);
    expect((await mgr.propose('m', { path: 'a.py', search: 'x', replace: 'x' })).error).toMatch(/not change/);
    expect(
      (await mgr.propose('m', { path: 'a.py', search: 'x', replace: 'y', incomplete: true })).error,
    ).toMatch(/ended/);
    expect(isEditablePath('src/logo.png')).toBe(false);
  });

  it('uses the fallback path when the model names no file', async () => {
    const { mgr } = make({ 'only.py': 'x = 1' });
    const e = await mgr.propose('m', { search: 'x = 1', replace: 'x = 2' }, 'only.py');
    expect(e).toMatchObject({ status: 'pending', path: 'only.py', inferredPath: true });
  });
});

// ---------------------------------------------------------------------------------------
// 0.2.1: plain code blocks, refusals, request classification

const SERVER = [
  'from fastapi import FastAPI',
  '',
  'app = FastAPI()',
  '',
  '@app.get("/", status_code=200)',
  'def get_all_users():',
  '    return [serialize(u) for u in users.find()]',
  '',
  '@app.post("/create", status_code=201)',
  'def create_user(user: User):',
  '    result = users.insert_one(user.model_dump())',
  '    return {"message": "User has been added"}',
  '',
  '',
  '# class Handler(BaseHTTPRequestHandler):',
  '#     def do_GET(self):',
  '#         pass',
  '',
].join('\n');

describe('placing plain code blocks', () => {
  it('inserts a new route after the last route, not after commented-out code', () => {
    const r = applyBlock(
      SERVER,
      '@app.get("/users/{id}")\ndef get_user(id: str):\n    return serialize(users.find_one({"_id": id}))',
    );
    expect(r.ok).toBe(true);
    const c = r.ok ? r.content : '';
    expect(c.indexOf('def get_user')).toBeGreaterThan(c.indexOf('def create_user'));
    expect(c.indexOf('def get_user')).toBeLessThan(c.indexOf('# class Handler'));
  });

  it('replaces an existing function when the block redefines it', () => {
    const r = applyBlock(
      SERVER,
      '@app.post("/create", status_code=201)\ndef create_user(user: User):\n    result = users.insert_one(user.model_dump())\n    return {"message": "User has been added", "id": str(result.inserted_id)}',
    );
    expect(r.ok && r.content.match(/def create_user/g)?.length).toBe(1);
    expect(r.ok && r.content).toContain('"id": str(result.inserted_id)');
    expect(r.ok && r.searchLines).toHaveLength(4);
  });

  it('finds the function by name even if its decorator changed', () => {
    const r = applyBlock(
      SERVER,
      '@app.get("/users", status_code=200)\ndef get_all_users():\n    return list(users.find())',
    );
    expect(r.ok && r.content).toContain('@app.get("/users", status_code=200)');
    expect(r.ok && r.content).not.toContain('@app.get("/", status_code=200)');
  });

  it('treats echoed existing or commented-out code as no change', () => {
    const r1 = applyBlock(SERVER, '# class Handler(BaseHTTPRequestHandler):\n#     def do_GET(self):');
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.reason).toMatch(/^NOOP/);
    const r2 = applyBlock(SERVER, 'def get_all_users():\n    return [serialize(u) for u in users.find()]');
    expect(!r2.ok && r2.reason).toMatch(/^NOOP/);
  });

  it('handles brace-delimited languages', () => {
    const ts =
      'export function a() {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\n\nexport function b() {\n  return 3;\n}\n';
    expect(definitionEnd(ts.split('\n'), 0)).toBe(5);
    const r = applyBlock(ts, 'export function a() {\n  return 42;\n}');
    expect(r.ok && r.content).toBe(
      'export function a() {\n  return 42;\n}\n\nexport function b() {\n  return 3;\n}\n',
    );
  });

  it('strips copied line numbers and reads the path from a comment', () => {
    expect(stripLineNumberPrefixes(['78 | def f():', '79 |     pass'])).toEqual(['def f():', '    pass']);
    expect(stripLineNumberPrefixes(['x = 1 | 2'])).toEqual(['x = 1 | 2']);
    expect(pathFromCodeComment('# pyserver.py:78-84')).toBe('pyserver.py');
    expect(pathFromCodeComment('// src/routes/users.ts')).toBe('src/routes/users.ts');
    expect(pathFromCodeComment('# just a comment')).toBeUndefined();
  });
});

describe('extracting plain code blocks in Agent mode', () => {
  const run = (text: string, capture: boolean) => {
    const edits: RawEdit[] = [];
    const x = new EditBlockExtractor(
      (e) => {
        edits.push(e);
        return `e${edits.length}`;
      },
      { captureCodeBlocks: capture },
    );
    let shown = '';
    for (let i = 0; i < text.length; i += 4) shown += x.push(text.slice(i, i + 4));
    return { shown: shown + x.finish(), edits };
  };

  it('captures code blocks but leaves shell commands as text', () => {
    const { shown, edits } = run(
      'pyserver.py\n```python\ndef f():\n    pass\n```\nCheck with:\n```sh\ncurl localhost:8000\n```\n',
      true,
    );
    expect(edits).toEqual([
      { path: 'pyserver.py', search: '', replace: '', code: 'def f():\n    pass', lang: 'python' },
    ]);
    expect(shown).toContain('```sh\ncurl localhost:8000\n```');
  });

  it('leaves code blocks alone when capture is off', () => {
    const { shown, edits } = run('```python\ndef f():\n    pass\n```\n', false);
    expect(edits).toHaveLength(0);
    expect(shown).toContain('def f():');
  });

  it('drops blocks the callback rejects', () => {
    const x = new EditBlockExtractor(() => null, { captureCodeBlocks: true });
    const out = x.push('```python\ndef test_x():\n    assert 1\n```\nafter\n') + x.finish();
    expect(out).not.toContain('test_x');
    expect(out).toContain('after');
  });
});

describe('short guarded refusals', () => {
  it('keeps a refusal and one guiding question, dropping steps and explanations', () => {
    const out = shortenRefusal(
      "To implement a GET endpoint, we need to modify get_all_users.\n\n1. Add a parameter.\n2. Use find_one.\n\nI can't write this for you. Which pymongo method returns a single document?",
    );
    expect(out).toBe("I can't write this for you. Which pymongo method returns a single document?");
  });

  it('falls back to a standard refusal and hint when the model only explained', () => {
    const out = shortenRefusal(
      'To implement a GET one user endpoint, we need to modify get_all_users. Then add get_user.',
    );
    expect(out.startsWith(STANDARD_REFUSAL)).toBe(true);
    expect(out).not.toContain('get_all_users');
  });
});

describe('request helpers', () => {
  it.each([
    ['add a get one user endpoint', true],
    ['create a get one user endpoint', true],
    ['fix the timeout in the pool', true],
    ['how does find_one work?', false],
    ['what does serialize do', false],
    ['explain the request flow', false],
    ['/implement sum the prices', true],
  ])('isChangeRequest(%s) = %s', (t, expected) => {
    expect(isChangeRequest(t)).toBe(expected);
  });

  it('detects test code and test requests', () => {
    expect(looksLikeTestCode('def test_get_user():\n    assert x')).toBe(true);
    expect(looksLikeTestCode("describe('x', () => {})")).toBe(true);
    expect(looksLikeTestCode('def get_user(id):\n    return 1')).toBe(false);
    expect(asksForTests('add a test for the endpoint')).toBe(true);
    expect(asksForTests('add a get one user endpoint')).toBe(false);
  });
});

describe('placement safety (regression)', () => {
  const POOL = [
    'export class ConnectionPool {',
    '  async query(sql) {',
    '    const conn = await this.acquire();',
    '    const r = await conn.execute(sql);',
    '    this.release(conn);',
    '    return r;',
    '  }',
    '}',
    '',
  ].join('\n');

  it('never replaces a whole class with an echoed partial snippet', () => {
    const r = applyBlock(
      POOL,
      '// src/db/pool.ts:1-2\n1 | export class ConnectionPool {\n2 |   async query(sql) {',
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^NOOP/);
  });

  it('refuses unbalanced or drastically shorter replacements', () => {
    const unbalanced = applyBlock(POOL, 'export class ConnectionPool {\n  async query(sql) {\n    return 1;');
    expect(unbalanced.ok).toBe(false);
    const py = 'def big():\n' + Array.from({ length: 12 }, (_, i) => `    x${i} = ${i}`).join('\n') + '\n';
    const shorter = applyBlock(py, 'def big():\n    return 1');
    expect(!shorter.ok && shorter.reason).toMatch(/incomplete/);
  });

  it('still replaces a complete rewritten method', () => {
    const r = applyBlock(
      POOL,
      'export class ConnectionPool {\n  async query(sql) {\n    const conn = await this.acquire();\n    try {\n      return await conn.execute(sql);\n    } finally {\n      this.release(conn);\n    }\n  }\n}',
    );
    expect(r.ok && r.content).toContain('} finally {');
    expect(r.ok && r.content.match(/class ConnectionPool/g)?.length).toBe(1);
  });
});
