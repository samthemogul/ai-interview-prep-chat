import { describe, expect, it } from 'vitest';
import { fileRefFrom, renderMarkdown, stablePrefixEnd } from '../src/webview/chat/markdown';
import { highlight } from '../src/webview/chat/highlight';

describe('markdown rendering', () => {
  it('renders headings, lists, tables, quotes and inline code', () => {
    const html = renderMarkdown(
      [
        '## Title',
        '',
        '- one',
        '  - nested',
        '- two with `code`',
        '',
        '1. first',
        '2. second',
        '',
        '| a | b |',
        '|---|:-:|',
        '| 1 | 2 |',
        '',
        '> quoted **bold**',
      ].join('\n'),
    );
    expect(html).toContain('<h4>Title</h4>');
    expect(html).toContain(
      '<ul><li>one<ul><li>nested</li></ul></li><li>two with <code>code</code></li></ul>',
    );
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<th style="text-align:center">b</th>');
    expect(html).toContain('<blockquote><p>quoted <strong>bold</strong></p></blockquote>');
  });

  it('renders fenced code with a language label, highlighting and a copy button, but no apply button', () => {
    const html = renderMarkdown('```python\ndef f():\n    return "x"  # hi\n```');
    expect(html).toContain('<span class="code-lang">python</span>');
    expect(html).toContain('<span class="tok-keyword">def</span>');
    expect(html).toContain('<span class="tok-string">&quot;x&quot;</span>');
    expect(html).toContain('<span class="tok-comment"># hi</span>');
    expect(html).toContain('copy-code');
    expect(html).not.toMatch(/apply|insert/i);
  });

  it('keeps an unclosed fence as code while streaming', () => {
    expect(renderMarkdown('```js\nconst a = 1;', { streaming: true })).toContain('<pre><code');
  });

  it('escapes HTML from the model so nothing executes', () => {
    const html = renderMarkdown(
      '<img src=x onerror=alert(1)> <script>alert(1)</script> `<b>`\n\n```html\n<script>x</script>\n```',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never makes links clickable or loads images', () => {
    const html = renderMarkdown('[click](javascript:alert(1)) and ![pic](http://evil/x.png)');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(html).toContain('javascript:alert(1)');
    expect(html).toContain('[image: pic]');
  });

  it('turns file paths in inline code into workspace file links', () => {
    expect(fileRefFrom('src/db/pool.ts:42')).toEqual({ path: 'src/db/pool.ts', line: 42 });
    expect(fileRefFrom('server.cpp')).toEqual({ path: 'server.cpp', line: undefined });
    expect(fileRefFrom('e.g')).toBeUndefined();
    expect(fileRefFrom('obj.method')).toBeUndefined();
    expect(renderMarkdown('see `src/db/pool.ts:12`')).toContain(
      'class="file-link" data-path="src/db/pool.ts" data-line="12"',
    );
  });

  it('lets emphasis span inline code', () => {
    expect(renderMarkdown('*what if `x()` throws?*')).toContain('<em>what if <code>x()</code> throws?</em>');
  });

  it('highlights without breaking on unterminated strings', () => {
    expect(highlight('const s = "abc', 'ts')).toContain('tok-string');
  });
});

describe('incremental rendering boundaries', () => {
  const strip = (h: string) => h.replace(/cb\d+/g, 'cb');

  it('renders a prefix plus tail the same as the whole text', () => {
    const text =
      'Intro paragraph.\n\n```python\nx = 1\n\ny = 2\n```\n\nMiddle text here.\n\n1. one\n\n2. two\n\nAfter the list.\n\nTail being wri';
    const end = stablePrefixEnd(text);
    expect(end).toBeGreaterThan(0);
    const split = renderMarkdown(text.slice(0, end)) + renderMarkdown(text.slice(end));
    expect(strip(split).replace(/\n/g, '')).toBe(strip(renderMarkdown(text)).replace(/\n/g, ''));
  });

  it('never splits inside a code block or a list', () => {
    const inCode = 'Hi.\n\n```js\nconst a = 1;\n\nconst b = 2;\n';
    expect(inCode.slice(0, stablePrefixEnd(inCode))).toBe('Hi.\n');
    const list = '1. one\n\n2. two\n\n3. thr';
    expect(stablePrefixEnd(list)).toBe(0);
  });
});
