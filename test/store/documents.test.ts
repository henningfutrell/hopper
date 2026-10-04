// Config documents (design.md "Config documents"): plugins.yaml, webhooks.yaml and rules.md are
// named texts in the store, each replaced whole against its version.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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

  it('documents are independent and survive a reopen', () => {
    const url = t.url();
    const s = t.open(url, fixedClock());
    s.documents.write('plugins.yaml', 'version: 1\n', 'missing');
    s.documents.write('webhooks.yaml', 'version: 1\nwebhooks: []\n', 'missing');
    s.close();
    const again = t.open(url);
    expect(again.documents.read('plugins.yaml')).toBe('version: 1\n');
    expect(again.documents.read('webhooks.yaml')).toBe('version: 1\nwebhooks: []\n');
    expect(again.documents.read('rules.md')).toBeUndefined();
    again.close();
  });

  it('a write inside a transaction that rolls back leaves the document as it was', () => {
    const s = t.open(t.url());
    s.documents.write('rules.md', 'a', 'missing');
    expect(() => s.tx(() => { s.documents.write('rules.md', 'b', sha('a')); throw new Error('no'); })).toThrow('no');
    expect(s.documents.read('rules.md')).toBe('a');
    s.close();
  });
});
