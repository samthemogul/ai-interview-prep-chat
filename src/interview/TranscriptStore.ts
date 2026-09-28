import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { TranscriptSession } from './Transcript';

/**
 * Persists transcripts as JSON files inside the extension's own storage folder on this
 * machine. Nothing here performs network access.
 */
export class TranscriptStore {
  /** Writes are serialised so overlapping saves can never interleave or lose events. */
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly dir: string) {}

  private fileFor(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid transcript id');
    return path.join(this.dir, `${id}.json`);
  }

  async save(session: TranscriptSession): Promise<void> {
    const file = this.fileFor(session.id);
    // Snapshot now so later mutations by the caller don't change what this save writes.
    const json = JSON.stringify(session, null, 2);
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${++this.seq}.tmp`;
      await fs.writeFile(tmp, json, 'utf8');
      await fs.rename(tmp, file);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async load(id: string): Promise<TranscriptSession | undefined> {
    try {
      const raw = await fs.readFile(this.fileFor(id), 'utf8');
      const parsed = JSON.parse(raw) as TranscriptSession;
      return parsed.version === 1 && Array.isArray(parsed.events) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Newest first. */
  async list(): Promise<TranscriptSession[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const sessions: TranscriptSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const s = await this.load(name.slice(0, -5));
      if (s && s.events.length) sessions.push(s);
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteAll(): Promise<number> {
    await this.queue;
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      await fs.rm(path.join(this.dir, name), { force: true });
      if (name.endsWith('.json')) n++;
    }
    return n;
  }
}
