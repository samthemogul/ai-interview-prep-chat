/**
 * Tiny, dependency-free syntax highlighter. It recognises comments, strings, numbers,
 * keywords and function calls for common languages. Output is always HTML-escaped.
 */
import { escapeHtml } from './escape';

const KEYWORDS = new Set(
  // JS/TS
  (
    'abstract as async await break case catch class const continue debugger declare default delete do else enum ' +
    'export extends false finally for from function get if implements import in instanceof interface is keyof let ' +
    'new null of private protected public readonly return set static super switch this throw true try type typeof ' +
    'undefined var void while with yield ' +
    // Python
    'and def del elif except global lambda nonlocal not or pass raise None True False self async ' +
    // Go / Rust / C-family / Java / C#
    'func go defer chan map range struct package select fallthrough goto fn impl mut pub use mod crate trait where ' +
    'match loop unsafe ref move dyn int long short float double char bool boolean byte unsigned signed sizeof ' +
    'typedef union extern register volatile inline template typename namespace using virtual override final ' +
    'throws native synchronized transient string var val object companion when internal open lateinit'
  ).split(/\s+/),
);

const HASH_COMMENT_LANGS = new Set([
  'python',
  'py',
  'ruby',
  'rb',
  'bash',
  'sh',
  'shell',
  'zsh',
  'yaml',
  'yml',
  'toml',
  'r',
  'perl',
  'makefile',
  'dockerfile',
  'elixir',
  'ex',
  'powershell',
  'ps1',
]);
const DASH_COMMENT_LANGS = new Set(['sql', 'lua', 'haskell', 'hs']);

type Token = { cls?: string; text: string };

export function highlight(code: string, lang: string): string {
  if (code.length > 60_000) return escapeHtml(code);
  const l = lang.toLowerCase();
  const hash = HASH_COMMENT_LANGS.has(l);
  const dash = DASH_COMMENT_LANGS.has(l);
  const slash = !hash || l === 'php';
  const tokens: Token[] = [];
  let i = 0;
  const push = (text: string, cls?: string) => tokens.push({ text, cls });

  while (i < code.length) {
    const rest = code.slice(i);
    let m: RegExpExecArray | null;

    if (slash && rest.startsWith('//')) {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? code.length : end;
      push(code.slice(i, stop), 'tok-comment');
      i = stop;
      continue;
    }
    if (slash && rest.startsWith('/*')) {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? code.length : end + 2;
      push(code.slice(i, stop), 'tok-comment');
      i = stop;
      continue;
    }
    if ((hash && rest.startsWith('#')) || (dash && rest.startsWith('--'))) {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? code.length : end;
      push(code.slice(i, stop), 'tok-comment');
      i = stop;
      continue;
    }
    if ((m = /^("""[\s\S]*?"""|'''[\s\S]*?''')/.exec(rest)) && (l === 'python' || l === 'py')) {
      push(m[0], 'tok-string');
      i += m[0].length;
      continue;
    }
    if ((m = /^("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)/.exec(rest))) {
      push(m[0], 'tok-string');
      i += m[0].length;
      continue;
    }
    if ((m = /^(0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?[fFlLuU]*)\b/.exec(rest))) {
      push(m[0], 'tok-number');
      i += m[0].length;
      continue;
    }
    if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
      const word = m[0];
      const after = code.slice(i + word.length).match(/^\s*\(/);
      if (KEYWORDS.has(word)) push(word, 'tok-keyword');
      else if (after) push(word, 'tok-function');
      else if (/^[A-Z][A-Za-z0-9]*$/.test(word) && word.length > 1) push(word, 'tok-type');
      else push(word);
      i += word.length;
      continue;
    }
    push(code[i]!);
    i++;
  }
  return tokens
    .map((t) => (t.cls ? `<span class="${t.cls}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text)))
    .join('');
}
