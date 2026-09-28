import { describe, expect, it } from 'vitest';
import { applyBlock } from '../src/agent/placeBlock';
import { fuzzy, splitTopLevel } from '../src/agent/chunks';
import { summarizeEdit } from '../src/agent/applyEdit';

// The user's pyserver.py.
const FILE = [
  'import os',
  'from fastapi import FastAPI',
  'from pydantic import BaseModel',
  'from pymongo import MongoClient',
  'from dotenv import load_dotenv',
  '',
  'load_dotenv()',
  '',
  'app = FastAPI()',
  'client = MongoClient(os.environ["MONGODB_URL"])',
  'db = client["uhl"]',
  'users = db["users"]',
  '',
  '',
  'class User(BaseModel):',
  '    name: str',
  '    email: str',
  '',
  '',
  'def serialize(mongo_result):',
  '    mongo_result["id"] = str(mongo_result.pop("_id"))',
  '    return mongo_result',
  '',
  '',
  '@app.get("/", status_code=200)',
  'def get_all_users():',
  '    result = users.find()',
  '    all_users = []',
  '    for user in result:',
  '        all_users.append(serialize(user))',
  '    return all_users',
  '',
  '',
  '@app.post("/create", status_code=201)',
  'def create_user(user: User):',
  '    result = users.insert_one(user.model_dump())',
  '    user = users.find_one({ "_id": result.inserted_id})',
  '    return { "message": "User has been added", "user": serialize(user)}',
  '',
  '',
  '# class Handler(BaseHTTPRequestHandler):',
  '#     def do_GET(self):',
  '#         self.send_response(200)',
  '',
].join('\n');

// What a small model produced for "add an endpoint to get one user": the whole file again,
// with rewritten imports and setup, and the new endpoint in the middle.
const WHOLE_FILE_REPLY = [
  'from fastapi import FastAPI, HTTPException',
  'from pydantic import BaseModel',
  'import pymongo',
  'from bson import ObjectId',
  '',
  'app = FastAPI()',
  'client = pymongo.MongoClient("mongodb://localhost:27017/")',
  'db = client["uhl"]',
  'users = db["users"]',
  '',
  'class User(BaseModel):',
  '    name: str',
  '    email: str',
  '',
  'def serialize(mongo_result):',
  '    mongo_result["id"] = str(mongo_result.pop("_id"))',
  '    return mongo_result',
  '',
  '@app.get("/", status_code=200)',
  'def get_all_users():',
  '    result = users.find()',
  '    all_users = []',
  '    for user in result:',
  '        all_users.append(serialize(user))',
  '    return all_users',
  '',
  '@app.post("/create", status_code=201)',
  'def create_user(user: User):',
  '    result = users.insert_one(user.model_dump())',
  "    user = users.find_one({'_id': result.inserted_id})",
  '    return {"message": "User has been added", "user": serialize(user)}',
  '',
  '# New endpoint to get a single user by id',
  '@app.get("/users/{user_id}", status_code=200)',
  'def get_user(user_id: str):',
  '    # Look up the user by their ObjectId',
  '    user = users.find_one({"_id": ObjectId(user_id)})',
  '    if not user:',
  '        raise HTTPException(status_code=404, detail="User not found")',
  '    return serialize(user)',
  '',
  '# class Handler(BaseHTTPRequestHandler):',
  '#     def do_GET(self):',
  '#         self.send_response(200)',
].join('\n');

const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('whole-file replies: only the affected parts are applied', () => {
  const r = applyBlock(FILE, WHOLE_FILE_REPLY, { request: 'add an endpoint to get a single user by id' });
  const c = r.ok ? r.content : '';

  it('adds the new endpoint once, after create_user and before the commented code', () => {
    expect(r.ok).toBe(true);
    expect(count(c, 'def get_user(')).toBe(1);
    expect(c.indexOf('def get_user(')).toBeGreaterThan(c.indexOf('def create_user('));
    expect(c.indexOf('def get_user(')).toBeLessThan(c.indexOf('# class Handler'));
  });

  it('does not duplicate imports, setup, existing functions or commented code', () => {
    for (const s of [
      'def get_all_users(',
      'def create_user(',
      'def serialize(',
      'class User(',
      'app = FastAPI()',
      'db = client["uhl"]',
      '# class Handler',
    ]) {
      expect(count(c, s), s).toBe(1);
    }
    expect(c).not.toContain('import pymongo');
    expect(c).not.toContain('pymongo.MongoClient');
    expect(c).toContain('client = MongoClient(os.environ["MONGODB_URL"])');
  });

  it('merges only the imports the new code uses', () => {
    expect(c).toContain('from fastapi import FastAPI, HTTPException\n');
    expect(count(c, 'from fastapi import')).toBe(1);
    expect(c).toContain('from bson import ObjectId');
    // New imports go after the existing ones.
    expect(c.indexOf('from bson import ObjectId')).toBeGreaterThan(c.indexOf('from dotenv import'));
    expect(c.indexOf('from bson import ObjectId')).toBeLessThan(c.indexOf('load_dotenv()'));
  });

  it('drops comments the model added and keeps the rest of the file byte for byte', () => {
    expect(c).not.toContain('# New endpoint');
    expect(c).not.toContain('# Look up the user');
    const withoutNew = c
      .replace(', HTTPException', '')
      .replace('from bson import ObjectId\n', '')
      .replace(/\n\n\n@app\.get\("\/users\/\{user_id\}"[\s\S]*?return serialize\(user\)/, '');
    expect(withoutNew).toBe(FILE);
  });

  it('describes a small edit and says what it left alone', () => {
    const sum = r.ok ? summarizeEdit(r.searchLines, r.replaceLines) : undefined;
    expect(sum?.removed).toBe(1);
    expect(sum?.added).toBe(10);
    expect(r.ok && r.note).toContain('`client`');
  });
});

describe('whole-file replies that change existing code', () => {
  it('applies a requested change to an existing function and nothing else', () => {
    const reply = WHOLE_FILE_REPLY.split('\n')
      .slice(0, 31)
      .join('\n')
      .replace('"user": serialize(user)}', '"user": serialize(user), "id": str(result.inserted_id)}');
    const r = applyBlock(FILE, reply, { request: 'make create_user also return the id' });
    expect(r.ok).toBe(true);
    const c = r.ok ? r.content : '';
    expect(c).toContain('"id": str(result.inserted_id)}');
    expect(c).not.toContain('pymongo.MongoClient');
    expect(count(c, 'def create_user(')).toBe(1);
    expect(count(c, 'from fastapi import')).toBe(1);
  });

  it('leaves an existing function alone when a new one is added and it was not asked for', () => {
    const reply = WHOLE_FILE_REPLY.replace(
      '    result = users.find()\n    all_users = []\n    for user in result:\n        all_users.append(serialize(user))\n    return all_users',
      '    return [serialize(u) for u in users.find()]',
    );
    const r = applyBlock(FILE, reply, { request: 'add an endpoint to get one user' });
    const c = r.ok ? r.content : '';
    expect(c).toContain('all_users.append(serialize(user))');
    expect(r.ok && r.note).toContain('`get_all_users`');
  });

  it('treats a whole-file echo as no change', () => {
    const r = applyBlock(FILE, WHOLE_FILE_REPLY.split('\n').slice(0, 31).join('\n'), {
      request: 'add an endpoint',
    });
    expect(r.ok).toBe(false);
  });
});

describe('chunk helpers', () => {
  it('splits a file into top-level chunks', () => {
    const chunks = splitTopLevel(WHOLE_FILE_REPLY.split('\n'))!;
    expect(chunks.map((c) => c.kind)).toEqual([
      'import',
      'import',
      'import',
      'import',
      'assign',
      'assign',
      'assign',
      'assign',
      'def',
      'def',
      'def',
      'def',
      'def',
      'comment',
    ]);
    expect(chunks.filter((c) => c.kind === 'def').map((c) => c.name)).toEqual([
      'User',
      'serialize',
      'get_all_users',
      'create_user',
      'get_user',
    ]);
  });

  it('compares code loosely', () => {
    expect(fuzzy("find_one({ '_id': x})")).toBe(fuzzy('find_one({"_id": x})'));
  });

  it('keeps comments when asked for them', () => {
    const r = applyBlock(
      FILE,
      '# get one user\n@app.get("/users/{id}")\ndef get_user(id: str):\n    return None',
      {
        keepComments: true,
      },
    );
    expect(r.ok && r.content).toContain('# get one user');
  });
});

describe('whole-file replies in TypeScript', () => {
  const TS = [
    "import express from 'express';",
    "import { readUsers } from './db';",
    '',
    'const app = express();',
    '',
    "app.get('/users', async (_req, res) => {",
    '  res.json(await readUsers());',
    '});',
    '',
    'export function start(port: number) {',
    '  app.listen(port);',
    '}',
    '',
  ].join('\n');

  it('merges a named import and inserts only the new route', () => {
    const reply = [
      "import express from 'express';",
      "import { readUsers, readUser } from './db';",
      '',
      'const app = express();',
      '',
      "app.get('/users', async (_req, res) => {",
      '  res.json(await readUsers());',
      '});',
      '',
      '// Get one user',
      "app.get('/users/:id', async (req, res) => {",
      '  res.json(await readUser(req.params.id));',
      '});',
      '',
      'export function start(port: number) {',
      '  app.listen(port);',
      '}',
    ].join('\n');
    const r = applyBlock(TS, reply, { request: 'add a route to get one user' });
    expect(r.ok).toBe(true);
    const c = r.ok ? r.content : '';
    expect(c).toContain("import { readUsers, readUser } from './db';");
    expect(count(c, "app.get('/users'")).toBe(1);
    expect(count(c, "app.get('/users/:id'")).toBe(1);
    expect(count(c, 'export function start')).toBe(1);
    expect(count(c, 'const app = express()')).toBe(1);
    expect(c).not.toContain('// Get one user');
    expect(c.indexOf("'/users/:id'")).toBeLessThan(c.indexOf('export function start'));
    expect(c.indexOf("'/users/:id'")).toBeGreaterThan(c.indexOf("app.get('/users',"));
  });
});
