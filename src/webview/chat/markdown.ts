/**
 * A small, dependency-free Markdown renderer for chat messages.
 *
 * Security: every piece of text is HTML-escaped. Raw HTML in model output is shown as text,
 * links are rendered as non-clickable text (the URL stays visible), and images are never
 * loaded. This keeps untrusted model output inert inside the webview.
 */
import { highlight } from './highlight';
import { escapeHtml } from './escape';

export { escapeHtml };

/** Heuristic for inline code that names a workspace file, optionally with :line. */
const FILE_REF_RE = /^(?:\.\/)?((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?:[-:]\d+)?)?$/;

export function fileRefFrom(code: string): { path: string; line?: number } | undefined {
  const m = FILE_REF_RE.exec(code.trim());
  if (!m) return undefined;
  const p = m[1]!;
  // Avoid things like "e.g" or "v1.2" or "obj.method" without a path or a typical extension.
  if (
    !p.includes('/') &&
    !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|scala|json|ya?ml|toml|md|sql|sh|css|scss|html|vue|svelte|dart|lua|ex|exs|proto|gradle|xml|txt|cfg|ini|env)$/i.test(
      p,
    )
  ) {
    return undefined;
  }
  return { path: p, line: m[2] ? Number(m[2]) : undefined };
}

function renderInline(text: string): string {
  // Swap inline code for placeholders so emphasis can span it and code is never formatted.
  const codes: string[] = [];
  const withPlaceholders = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, body: string) => {
    const code = body.replace(/^ (.*) $/, '$1');
    const ref = fileRefFrom(code);
    codes.push(
      ref
        ? `<code class="file-link" data-path="${escapeHtml(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ''} title="Open ${escapeHtml(ref.path)}" tabindex="0" role="link">${escapeHtml(code)}</code>`
        : `<code>${escapeHtml(code)}</code>`,
    );
    return `\uE000${codes.length - 1}\uE000`;
  });
  return formatText(withPlaceholders).replace(
    /\uE000(\d+)\uE000/g,
    (_m, n: string) => codes[Number(n)] ?? '',
  );
}

function formatText(raw: string): string {
  let s = escapeHtml(raw);
  // Images: never load; show alt text.
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
    (_m, alt: string) => `<span class="muted">[image: ${alt || 'untitled'}]</span>`,
  );
  // Links: show text and URL, but don't make them clickable.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, t: string, url: string) =>
    t === url ? `<span class="link-text">${url}</span>` : `${t} <span class="link-text">(${url})</span>`,
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return s;
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

function renderList(items: ListItem[]): string {
  // Build nested lists from indentation.
  let html = '';
  const stack: Array<{ indent: number; ordered: boolean }> = [];
  for (const item of items) {
    while (stack.length && item.indent < stack[stack.length - 1]!.indent) {
      html += stack.pop()!.ordered ? '</li></ol>' : '</li></ul>';
    }
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      stack.push({ indent: item.indent, ordered: item.ordered });
      html += item.ordered ? '<ol><li>' : '<ul><li>';
    } else {
      html += '</li><li>';
    }
    html += renderInline(item.text);
  }
  while (stack.length) html += stack.pop()!.ordered ? '</li></ol>' : '</li></ul>';
  return html;
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('|');
}

export interface RenderOptions {
  /** True while streaming: an unclosed code fence is still shown as code. */
  streaming?: boolean;
}

let codeBlockCounter = 0;

export function renderMarkdown(src: string, _opts: RenderOptions = {}): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1]!;
      const lang = (fence[2] ?? '').toLowerCase();
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
        code.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence (or run past the end while streaming)
      const id = `cb${++codeBlockCounter}`;
      out.push(
        `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(lang || 'text')}</span>` +
          `<button class="icon-btn copy-code" data-code-id="${id}" title="Copy code" aria-label="Copy code"><span class="codicon codicon-copy"></span></button></div>` +
          `<pre><code id="${id}" class="lang-${escapeHtml(lang)}">${highlight(code.join('\n'), lang)}</code></pre></div>`,
      );
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(6, heading[1]!.length + 2); // keep headings compact in a sidebar
      out.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      flushPara();
      const quote: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      flushPara();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '',
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const cell = (tag: string, c: string, j: number) =>
        `<${tag}${aligns[j] ? ` style="text-align:${aligns[j]}"` : ''}>${renderInline(c)}</${tag}>`;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${header.map((c, j) => cell('th', c, j)).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${header.map((_, j) => cell('td', r[j] ?? '', j)).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }

    const listRe = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      flushPara();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = listRe.exec(l);
        if (m) {
          items.push({ indent: m[1]!.replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]!), text: m[3]! });
          i++;
        } else if (l.trim() && /^\s{2,}\S/.test(l) && items.length) {
          items[items.length - 1]!.text += ' ' + l.trim();
          i++;
        } else {
          break;
        }
      }
      out.push(renderList(items));
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

const LIST_LINE = /^\s*(?:[-*+]|\d{1,3}[.)])\s|^\s{2,}\S/;

/**
 * End of the longest prefix of `text` that can be rendered on its own: it ends at a blank
 * line outside code blocks, and isn't in the middle of a list (splitting a list would
 * restart its numbering).
 */
export function stablePrefixEnd(text: string): number {
  const lines = text.split('\n');
  let inFence = false;
  let fence = '';
  let offset = 0;
  let best = 0;
  let prevNonBlank = '';
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    const start = offset;
    offset += line.length + 1;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!inFence) {
        inFence = true;
        fence = f[1]!;
      } else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length && !line.trim().slice(f[1]!.length)) {
        inFence = false;
      }
    }
    if (inFence) continue;
    if (line.trim()) {
      prevNonBlank = line;
      continue;
    }
    // A blank line: a boundary if the next line is complete and neither side is a list.
    const next = lines.slice(i + 1, -1).find((l) => l.trim());
    if (next === undefined || LIST_LINE.test(next) || LIST_LINE.test(prevNonBlank)) continue;
    if (/^\s*\|/.test(next) || /^\s{0,3}>/.test(next)) continue;
    best = start;
  }
  return best;
}
