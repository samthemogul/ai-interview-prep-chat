import { describe, expect, it } from 'vitest';
import { IgnoreMatcher } from '../src/context/IgnoreMatcher';
import { isIndexablePath, languageForPath, looksBinary } from '../src/context/fileFilters';

describe('workspace filtering', () => {
  it.each([
    ['node_modules/react/index.js', false],
    ['packages/app/node_modules/x/y.js', false],
    ['.git/config', false],
    ['dist/extension.js', false],
    ['build/out.o', false],
    ['target/debug/app', false],
    ['.venv/lib/site.py', false],
    ['src/__pycache__/mod.cpython-312.pyc', false],
    ['coverage/lcov.info', false],
    ['vendor/lib.go', false],
    ['assets/logo.png', false],
    ['bin/tool.exe', false],
    ['static/app.min.js', false],
    ['package-lock.json', false],
    ['api/service.pb.go', false],
    ['src/generated/client.ts', false],
    ['src/server.ts', true],
    ['server.cpp', true],
    ['app/models/user.py', true],
    ['docs/architecture.md', true],
  ])('%s -> %s', (p, expected) => {
    expect(isIndexablePath(p)).toBe(expected);
  });

  it('detects binary content by NUL bytes', () => {
    expect(looksBinary(new Uint8Array([72, 105, 0, 1]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode('plain text'))).toBe(false);
  });

  it('maps file extensions to code fence languages', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript');
    expect(languageForPath('server.cpp')).toBe('cpp');
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
  });
});

describe('.gitignore handling', () => {
  const m = new IgnoreMatcher().add(
    [
      '# comment',
      '*.log',
      '/secrets.env',
      'tmp/',
      'docs/**/*.pdf',
      '**/cache',
      '!keep.log',
      'build-*',
      'config/local.[jt]s',
    ].join('\n'),
  );

  it.each([
    ['app.log', true],
    ['nested/deep/app.log', true],
    ['keep.log', false],
    ['secrets.env', true],
    ['nested/secrets.env', false],
    ['tmp/file.ts', true],
    ['src/tmp/file.ts', true],
    ['docs/a/b/c.pdf', true],
    ['docs/readme.md', false],
    ['src/cache/x.json', true],
    ['build-2024/x.ts', true],
    ['config/local.js', true],
    ['config/local.ts', true],
    ['config/local.py', false],
    ['src/index.ts', false],
  ])('%s ignored: %s', (p, expected) => {
    expect(m.ignores(p)).toBe(expected);
  });

  it('only applies directory patterns to directories and their contents', () => {
    const d = new IgnoreMatcher().add('logs/');
    expect(d.ignores('logs', true)).toBe(true);
    expect(d.ignores('logs/a.txt')).toBe(true);
    expect(d.ignores('logs')).toBe(false);
  });

  it('scopes rules from nested .gitignore files to their directory', () => {
    const n = new IgnoreMatcher().add('*.gen.ts', 'packages/api');
    expect(n.ignores('packages/api/src/x.gen.ts')).toBe(true);
    expect(n.ignores('packages/web/src/x.gen.ts')).toBe(false);
  });

  it('cannot re-include a file whose parent directory is ignored', () => {
    const n = new IgnoreMatcher().add('out/\n!out/keep.ts');
    expect(n.ignores('out/keep.ts')).toBe(true);
  });
});
