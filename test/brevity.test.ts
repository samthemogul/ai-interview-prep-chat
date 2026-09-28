import { describe, expect, it } from 'vitest';
import { ProseLimiter, limitProse, wantsDetail } from '../src/interview/Brevity';

function stream(text: string, budget: number | undefined, size: number): string {
  const l = new ProseLimiter({ chatMode: 'ask', budget });
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
  'This is useful because you often need a single user. It also keeps things simple. You can test it with curl.',
  '',
  'Let me know if you need anything else!',
].join('\n');

describe('ProseLimiter', () => {
  it('keeps code, drops explanation sections and filler, and caps prose', () => {
    const out = limitProse(LONG, { chatMode: 'agent', budget: 3 });
    expect(out).toContain("Here's the new endpoint. It looks up one user by id.");
    expect(out).toContain('def get_user(id: str):');
    expect(out).not.toContain('Explanation');
    expect(out).not.toContain('decorator registers');
    expect(out).not.toContain('Let me know');
    // Prose after an explanation heading is part of that section.
    expect(out).not.toContain('This is useful');
  });

  it('gives the same result however the stream is chunked', () => {
    const whole = stream(LONG, 3, LONG.length);
    for (const size of [1, 3, 7, 40]) expect(stream(LONG, 3, size)).toBe(whole);
  });

  it('streams long lines before the newline arrives', () => {
    const l = new ProseLimiter({ chatMode: 'ask', budget: 5 });
    expect(l.push('The function reads the list and adds the prices')).not.toBe('');
  });

  it('uses the remaining budget for prose after code', () => {
    const out = limitProse(
      'Added it.\n\n```py\nx = 1\n```\n\nCall it with an id. It returns None when missing. More.',
      {
        chatMode: 'agent',
        budget: 3,
      },
    );
    expect(out).toContain('Call it with an id. It returns None when missing.');
    expect(out).not.toContain('More.');
  });

  it('cuts a long paragraph at the budget', () => {
    const out = limitProse('One. Two. Three. Four. Five. Six. Seven.', { chatMode: 'ask', budget: 5 });
    expect(out).toBe('One. Two. Three. Four. Five.');
  });

  it('counts list items as sentences', () => {
    const out = limitProse('- a\n- b\n- c\n- d', { chatMode: 'agent', budget: 3 });
    expect(out).toBe('- a\n- b\n- c');
  });

  it('applies no budget when the user asked for detail', () => {
    expect(wantsDetail('explain in detail how routing works')).toBe(true);
    expect(wantsDetail('add an endpoint')).toBe(false);
    const out = limitProse('One. Two. Three. Four. Five. Six. Seven.', { chatMode: 'ask' });
    expect(out).toBe('One. Two. Three. Four. Five. Six. Seven.');
  });

  it('passes edit placeholders through after the budget', () => {
    const out = limitProse('One. Two. Three. Four.\n%%EDIT:abc%%\n', { chatMode: 'agent', budget: 2 });
    expect(out).toBe('One. Two.\n%%EDIT:abc%%');
  });

  it('does not treat e.g. or file names as sentence ends', () => {
    const out = limitProse('Open app.py, e.g. the router. Then run it. Done.', {
      chatMode: 'ask',
      budget: 2,
    });
    expect(out).toBe('Open app.py, e.g. the router. Then run it.');
  });
});
