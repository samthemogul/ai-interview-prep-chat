import { describe, expect, it } from 'vitest';
import { ProseLimiter, limitProse, wantsDetail } from '../src/interview/Brevity';

function stream(text: string, size: number): string {
  const l = new ProseLimiter({ chatMode: 'ask' });
  let out = '';
  for (let i = 0; i < text.length; i += size) out += l.push(text.slice(i, i + size));
  return out + l.finish();
}

const LONG = [
  "Here's the new endpoint. It looks up one user by id.",
  '',
  '```python',
  '@app.get("/users/{id}")',
  'def get_user(id: str):',
  '    return users.find_one({"_id": id})',
  '```',
  '',
  '### Explanation',
  '1. The decorator registers a GET route.',
  '2. `find_one` returns a single document.',
  '',
  'Let me know if you need anything else!',
].join('\n');

describe('ProseLimiter (display cleanup only)', () => {
  it('keeps the answer and code, drops labelled sections and filler', () => {
    const out = limitProse(LONG, { chatMode: 'agent' });
    expect(out).toContain("Here's the new endpoint. It looks up one user by id.");
    expect(out).toContain('def get_user(id: str):');
    expect(out).not.toContain('Explanation');
    expect(out).not.toContain('decorator registers');
    expect(out).not.toContain('Let me know');
  });

  it('never truncates ordinary prose by length', () => {
    const out = limitProse('One. Two. Three. Four. Five. Six. Seven.', { chatMode: 'agent' });
    expect(out).toBe('One. Two. Three. Four. Five. Six. Seven.');
  });

  it('keeps prose that follows a code block', () => {
    const out = limitProse(
      'Added it.\n\n```py\nx = 1\n```\n\nCall it with an id. It returns None when missing.',
      {
        chatMode: 'agent',
      },
    );
    expect(out).toContain('Call it with an id. It returns None when missing.');
  });

  it('gives the same result however the stream is chunked', () => {
    const whole = stream(LONG, LONG.length);
    for (const size of [1, 3, 7, 40]) expect(stream(LONG, size)).toBe(whole);
  });

  it('passes edit placeholders through and resets a section at them', () => {
    const out = limitProse('### Explanation\nblah\n%%EDIT:abc%%\nDone.', { chatMode: 'agent' });
    expect(out).toContain('%%EDIT:abc%%');
    expect(out).toContain('Done.');
    expect(out).not.toContain('blah');
  });

  it('detects a request for detail', () => {
    expect(wantsDetail('explain in detail how routing works')).toBe(true);
    expect(wantsDetail('add an endpoint')).toBe(false);
  });
});
