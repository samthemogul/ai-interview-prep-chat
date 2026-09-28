/**
 * A small .gitignore matcher covering the common syntax: comments, negation (!),
 * directory-only patterns (trailing /), anchored patterns (containing /), *, ?, ** and
 * character classes. Rules from .gitignore files in subdirectories are scoped to them.
 */
interface Rule {
  base: string; // directory the .gitignore lives in, '' for the root, no trailing slash
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

export class IgnoreMatcher {
  private readonly rules: Rule[] = [];

  /** Adds the rules from one .gitignore file located at `baseDir` (workspace-relative). */
  add(contents: string, baseDir = ''): this {
    const base = baseDir.replace(/^\/+|\/+$/g, '');
    for (const rawLine of contents.split(/\r?\n/)) {
      const rule = parseRule(rawLine, base);
      if (rule) this.rules.push(rule);
    }
    return this;
  }

  get size(): number {
    return this.rules.length;
  }

  /** True if `relPath` (a file, or a directory when isDir) is ignored, including via a parent dir. */
  ignores(relPath: string, isDir = false): boolean {
    const clean = relPath.replace(/^\/+|\/+$/g, '');
    if (!clean || this.rules.length === 0) return false;
    const parts = clean.split('/');
    // A file inside an ignored directory is ignored (git cannot re-include it either).
    for (let i = 1; i < parts.length; i++) {
      if (this.matchSingle(parts.slice(0, i).join('/'), true)) return true;
    }
    return this.matchSingle(clean, isDir);
  }

  private matchSingle(p: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      let target: string;
      if (rule.base) {
        if (!p.startsWith(rule.base + '/')) continue;
        target = p.slice(rule.base.length + 1);
      } else {
        target = p;
      }
      const subject = rule.anchored ? target : target.slice(target.lastIndexOf('/') + 1);
      if (rule.regex.test(subject)) ignored = !rule.negate;
    }
    return ignored;
  }
}

function parseRule(rawLine: string, base: string): Rule | undefined {
  let line = rawLine.replace(/\r$/, '');
  if (!line.trim() || line.startsWith('#')) return undefined;
  // Trailing spaces are ignored unless escaped.
  line = line.replace(/(?<!\\)\s+$/, '');
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) return undefined;
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  if (line.startsWith('**/')) {
    // "**/foo" matches "foo" at any depth: equivalent to an unanchored pattern.
    const rest = line.slice(3);
    if (!rest.includes('/')) {
      return { base, negate, dirOnly, anchored: false, regex: new RegExp(`^${globToRegex(rest)}$`) };
    }
  }
  return { base, negate, dirOnly, anchored, regex: new RegExp(`^${globToRegex(line)}$`) };
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const prevSlash = i === 0 || glob[i - 1] === '/';
        const nextSlash = glob[i + 2] === '/';
        if (prevSlash && nextSlash) {
          out += '(?:.*/)?';
          i += 2;
        } else if (prevSlash && i + 2 === glob.length) {
          out += '.*';
          i += 1;
        } else {
          out += '[^/]*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i + 1) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      } else {
        out += '\\[';
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      out += escapeRegex(glob[i + 1]!);
      i += 1;
    } else {
      out += escapeRegex(c);
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
