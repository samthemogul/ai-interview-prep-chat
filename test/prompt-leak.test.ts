import { describe, expect, it } from 'vitest';
import { PromptLeakFilter } from '../src/interview/PromptLeak';

function run(text: string, size: number): { out: string; tripped: boolean } {
  const f = new PromptLeakFilter();
  let out = '';
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  out += f.finish();
  return { out, tripped: f.tripped };
}

describe('PromptLeakFilter', () => {
  it('passes a normal answer through unchanged', () => {
    const t =
      'Here is the endpoint.\n\n```python\n@app.get("/x")\ndef x():\n    return 1\n```\n\nCall it with GET /x.';
    const { out, tripped } = run(t, 7);
    expect(tripped).toBe(false);
    expect(out).toBe(t);
  });

  it('cuts at </workspace_context> and drops everything after', () => {
    const t =
      'Added it.\n@app.delete("/x")\n</workspace_context>\n\nCandidate’s message:\nadd a put endpoint';
    const { out, tripped } = run(t, 5);
    expect(tripped).toBe(true);
    expect(out).toContain('Added it.');
    expect(out).not.toContain('workspace_context');
    expect(out).not.toContain('put endpoint');
  });

  it("cuts at Candidate's message: even without the tag", () => {
    const t = "Here is the code.\n\nCandidate's message:\nadd a delete endpoint";
    const { out, tripped } = run(t, 3);
    expect(tripped).toBe(true);
    expect(out.trim()).toBe('Here is the code.');
  });

  it('cuts at a reproduced context heading before bogus edits form', () => {
    const t = 'Sure.\n\nRelevant snippet: .env.example:1-3\n```\nMONGODB_URL=\n```';
    const { out, tripped } = run(t, 4);
    expect(tripped).toBe(true);
    expect(out).not.toContain('MONGODB_URL');
    expect(out).not.toContain('Relevant snippet');
  });

  it('detects a marker split across chunks', () => {
    const t = 'text before </workspace' + '_context> junk after';
    const { out, tripped } = run(t, 1);
    expect(tripped).toBe(true);
    expect(out.trimEnd()).toBe('text before');
    expect(out).not.toContain('junk');
  });

  it('does not hold back the tail of a normal answer', () => {
    const { out } = run('all good here', 100);
    expect(out).toBe('all good here');
  });
});
