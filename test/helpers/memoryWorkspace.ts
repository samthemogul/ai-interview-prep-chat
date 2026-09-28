import type { IndexedFile, WorkspaceSource } from '../../src/context/ContextRetriever';

/** An in-memory workspace for retrieval and context tests. */
export class MemoryWorkspace implements WorkspaceSource {
  reads: string[] = [];
  large = false;

  constructor(private readonly files: Record<string, string>) {}

  async listFiles(): Promise<IndexedFile[]> {
    return Object.keys(this.files)
      .sort()
      .map((relPath) => ({ relPath, size: this.files[relPath]!.length }));
  }

  async readFile(relPath: string): Promise<string | undefined> {
    this.reads.push(relPath);
    return this.files[relPath];
  }

  isLarge(): boolean {
    return this.large;
  }
}

export const SAMPLE_REPO: Record<string, string> = {
  'src/server.ts': [
    "import express from 'express';",
    "import { ordersRouter } from './routes/orders';",
    "import { authMiddleware } from './middleware/auth';",
    '',
    'const app = express();',
    'app.use(authMiddleware);',
    "app.use('/orders', ordersRouter);",
    'app.listen(3000);',
  ].join('\n'),
  'src/middleware/auth.ts': [
    "import { verifyToken } from '../auth/AuthService';",
    '',
    'export function authMiddleware(req, res, next) {',
    '  const token = req.headers.authorization;',
    '  if (!verifyToken(token)) return res.status(401).end();',
    '  next();',
    '}',
  ].join('\n'),
  'src/auth/AuthService.ts': [
    'export class AuthService {',
    '  login(user: string, password: string) {',
    '    return user.length > 0 && password.length > 8;',
    '  }',
    '}',
    '',
    'export function verifyToken(token?: string): boolean {',
    "  return typeof token === 'string' && token.startsWith('Bearer ');",
    '}',
  ].join('\n'),
  'src/routes/orders.ts': [
    "import { Router } from 'express';",
    "import { pool } from '../db/pool';",
    '',
    'export const ordersRouter = Router();',
    "ordersRouter.get('/', async (_req, res) => {",
    "  const rows = await pool.query('SELECT * FROM orders');",
    '  res.json(rows);',
    '});',
  ].join('\n'),
  'src/db/pool.ts': [
    'export class ConnectionPool {',
    '  private free: Connection[] = [];',
    '  async acquire(): Promise<Connection> {',
    '    while (this.free.length === 0) await sleep(10);',
    '    return this.free.pop()!;',
    '  }',
    '  release(c: Connection) {',
    '    this.free.push(c);',
    '  }',
    '  async query(sql: string) {',
    '    const conn = await this.acquire();',
    '    const result = await conn.execute(sql);',
    '    this.release(conn);',
    '    return result;',
    '  }',
    '}',
    'export const pool = new ConnectionPool();',
  ].join('\n'),
  'README.md': '# Orders service\n\nA small demo service.',
  'test/orders.test.ts': "import { ordersRouter } from '../src/routes/orders';\n// tests",
};
