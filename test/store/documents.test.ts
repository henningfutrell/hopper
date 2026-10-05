// Config documents (design.md "Config documents"): plugins.yaml, rules.md and auth.yaml are
// named texts in the store, each replaced whole against its version.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('config documents', () => {
  it('a document not written yet reads undefined, version missing', () => {
    const s = t.open(t.url());
    expect(s.documents.read('plugins.yaml')).toBeUndefined();
    expect(s.documents.version('plugins.yaml')).toBe('missing');
    s.close();
  });

  it('writes against missing, then only against the version it was read at', () => {
    const s = t.open(t.url());
    expect(s.documents.write('rules.md', 'be kind\n', 'missing')).toBe(true);
    expect(s.documents.read('rules.md')).toBe('be kind\n');
    expect(s.documents.version('rules.md')).toBe(sha('be kind\n'));
    expect(s.documents.write('rules.md', 'stale', 'missing')).toBe(false);
    expect(s.documents.write('rules.md', 'stale', sha('other'))).toBe(false);
    expect(s.documents.read('rules.md')).toBe('be kind\n');
    expect(s.documents.write('rules.md', 'be brief\n', sha('be kind\n'))).toBe(true);
    expect(s.documents.read('rules.md')).toBe('be brief\n');
    s.close();
  });

  it('documents are independent and survive a reopen; auth.yaml is the instance\'s, the others a user\'s', () => {
    const url = t.url();
    const s = t.open(url, fixedClock());
    s.documents.write('plugins.yaml', 'version: 1\n', 'missing');
    s.close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    instance.documents.write('auth.yaml', 'version: 1\n', 'missing');
    instance.close();
    const again = t.open(url);
    expect(again.documents.read('plugins.yaml')).toBe('version: 1\n');
    expect(again.documents.read('rules.md')).toBeUndefined();
    expect(() => again.documents.read('auth.yaml' as 'rules.md')).toThrow(/no config document auth.yaml here/);
    again.close();
    const instanceAgain = openInstanceStore({ url, clock: fixedClock() });
    expect(instanceAgain.documents.read('auth.yaml')).toBe('version: 1\n');
    expect(() => instanceAgain.documents.read('plugins.yaml' as 'auth.yaml')).toThrow(/no config document plugins.yaml here/);
    instanceAgain.close();
  });

  it('a write is refused when another store replaced the document after it was read', () => {
    const url = t.url();
    const a = t.open(url);
    const b = t.open(url);
    a.documents.write('rules.md', 'one', 'missing');
    const seen = a.documents.version('rules.md');
    expect(b.documents.write('rules.md', 'two', seen)).toBe(true);
    expect(a.documents.write('rules.md', 'three', seen)).toBe(false);
    expect(b.documents.write('rules.md', 'four', 'missing')).toBe(false);
    expect(a.documents.read('rules.md')).toBe('two');
    a.close();
    b.close();
  });

  it('a write inside a transaction that rolls back leaves the document as it was', () => {
    const s = t.open(t.url());
    s.documents.write('rules.md', 'a', 'missing');
    expect(() => s.tx(() => { s.documents.write('rules.md', 'b', sha('a')); throw new Error('no'); })).toThrow('no');
    expect(s.documents.read('rules.md')).toBe('a');
    s.close();
  });
});
