/**
 * Streaming extraction of file edits from model output (Agent mode).
 *
 * The model proposes changes as SEARCH/REPLACE blocks, optionally inside a code fence and
 * optionally preceded by the file path:
 *
 *     pyserver.py
 *     ```python
 *     <<<<<<< SEARCH
 *     @app.post("/create", status_code=201)
 *     =======
 *     @app.get("/users/{id}")
 *     def get_user(id: str): ...
 *
 *     @app.post("/create", status_code=201)
 *     >>>>>>> REPLACE
 *     ```
 *
 * Blocks are removed from the visible text and replaced by a placeholder line that the UI
 * renders as an edit card. Nothing here touches files.
 */

export interface RawEdit {
  /** Path as written by the model, if any (unvalidated). */
  path?: string;
  search: string;
  replace: string;
  /** True when the stream ended before the block was complete. */
  incomplete?: boolean;
}

/** Placeholder line inserted into the message text where an edit card belongs. */
export const EDIT_PLACEHOLDER_RE = /^%%EDIT:([\w-]+)%%$/;
export const editPlaceholder = (id: string): string => `%%EDIT:${id}%%`;

const SEARCH_RE = /^\s*<{5,9}\s*SEARCH\b[:\s]*(.*?)\s*$/i;
const DIVIDER_RE = /^\s*={5,9}\s*$/;
const REPLACE_RE = /^\s*>{5,9}\s*REPLACE\b.*$/i;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*([^\s`]*)\s*$/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/** Extracts a file path from a line such as "pyserver.py", "**File: src/a.ts**" or "`a.py`:". */
export function pathFromLine(line: string): string | undefined {
  const t = line
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^[*_`"']+|[*_`"':]+$/g, '')
    .replace(/^(?:file(?:name)?|path|in|edit(?:ing)?|update|modify)\s*[:-]?\s*/i, '')
    .replace(/^[*_`"']+|[*_`"':]+$/g, '')
    .trim();
  return /^[\w@.\-/\\]+\.[A-Za-z0-9]{1,10}$/.test(t) && !/^\d+(\.\d+)+$/.test(t) ? t : undefined;
}

type State = 'text' | 'search' | 'replace';

export class EditBlockExtractor {
  private pending = '';
  private released = 0;
  private state: State = 'text';
  private heldFence: string | undefined;
  private expectCloseFence = false;
  private lastTextLine = '';
  private path: string | undefined;
  private fenced = false;
  private searchLines: string[] = [];
  private replaceLines: string[] = [];
  private count = 0;

  /** `onEdit` receives each complete block and returns the placeholder id to insert. */
  constructor(private readonly onEdit: (edit: RawEdit) => string) {}

  get editCount(): number {
    return this.count;
  }

  push(chunk: string): string {
    this.pending += chunk;
    let out = '';
    let nl: number;
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl);
      const already = this.released;
      this.pending = this.pending.slice(nl + 1);
      this.released = 0;
      out += this.processLine(line, already, true);
    }
    if (this.canReleasePartial()) {
      out += this.pending.slice(this.released);
      this.released = this.pending.length;
    }
    return out;
  }

  finish(): string {
    let out = '';
    if (this.pending) {
      const line = this.pending;
      const already = this.released;
      this.pending = '';
      this.released = 0;
      out += this.processLine(line, already, false);
    }
    if (this.heldFence !== undefined) {
      out += `${this.heldFence}\n`;
      this.heldFence = undefined;
    }
    if (this.state !== 'text') {
      // The stream stopped mid-block: report it so the UI can show it as incomplete.
      out += this.emit(true);
    }
    return out;
  }

  private canReleasePartial(): boolean {
    if (this.state !== 'text' || this.heldFence !== undefined) return false;
    if (this.pending.length <= this.released) return false;
    const t = this.pending.trimStart();
    if (!t || /^[`~<=>%]/.test(t)) return false;
    return !this.pending.includes('%%');
  }

  private processLine(line: string, already: number, hadNewline: boolean): string {
    const nl = hadNewline ? '\n' : '';

    if (this.state === 'search') {
      if (DIVIDER_RE.test(line)) this.state = 'replace';
      else this.searchLines.push(line);
      return '';
    }
    if (this.state === 'replace') {
      if (REPLACE_RE.test(line)) return this.emit(false);
      // Some models forget the closing marker and close the fence instead.
      if (this.fenced && FENCE_CLOSE_RE.test(line)) {
        const out = this.emit(false);
        this.expectCloseFence = false;
        return out;
      }
      this.replaceLines.push(line);
      return '';
    }

    // state === 'text'
    const search = SEARCH_RE.exec(line);
    if (this.heldFence !== undefined) {
      const fence = this.heldFence;
      this.heldFence = undefined;
      if (search) return this.startBlock(search[1], true, fence);
      const rest = this.processLine(line, 0, hadNewline);
      return `${fence}\n${rest}`;
    }
    if (this.expectCloseFence) {
      if (FENCE_CLOSE_RE.test(line)) {
        this.expectCloseFence = false;
        return '';
      }
      if (search) return this.startBlock(search[1], true);
      if (line.trim()) this.expectCloseFence = false;
    }
    if (search) return this.startBlock(search[1], false);
    if (FENCE_OPEN_RE.test(line) && already === 0) {
      this.heldFence = line;
      return '';
    }
    // Never let the model forge an edit card.
    const safe = line.replace(/%%EDIT:[\w-]*%%/g, '');
    if (safe.trim()) this.lastTextLine = safe;
    return safe.slice(already) + nl;
  }

  private startBlock(pathOnSearchLine: string | undefined, fenced: boolean, fenceLine?: string): string {
    const fromFence = fenceLine ? FENCE_OPEN_RE.exec(fenceLine) : null;
    this.path =
      pathFromLine(pathOnSearchLine ?? '') ??
      pathFromLine(fromFence?.[3] ?? '') ??
      pathFromLine(fromFence?.[2] ?? '') ??
      pathFromLine(this.lastTextLine);
    this.fenced = fenced;
    this.searchLines = [];
    this.replaceLines = [];
    this.state = 'search';
    return '';
  }

  private emit(incomplete: boolean): string {
    const edit: RawEdit = {
      path: this.path,
      search: this.searchLines.join('\n'),
      replace: this.replaceLines.join('\n'),
      incomplete: incomplete || undefined,
    };
    this.state = 'text';
    this.expectCloseFence = this.fenced;
    this.count++;
    const id = this.onEdit(edit);
    return `\n${editPlaceholder(id)}\n\n`;
  }
}
