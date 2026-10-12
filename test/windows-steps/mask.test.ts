// Issue #731: the log a job reads of its Windows step has each vault secret's value masked, also across chunks.
import { describe, expect, it } from 'vitest';
import { MASK, maskSecrets } from '../../src/windows-steps/index.ts';

const run = (values: string[], chunks: string[]): string[] => {
  const out: string[] = [];
  const m = maskSecrets(values, (c) => out.push(c));
  for (const c of chunks) m.write(c);
  m.end();
  return out;
};

describe('the masked step log', () => {
  it('passes the log through as it is when the step has no secret', () => {
    expect(run([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('masks a value in one chunk, and one split across chunks', () => {
    expect(run(['s3cret-value'], ['key s3cret-value ok\n']).join('')).toBe(`key ${MASK} ok\n`);
    expect(run(['s3cret-value'], ['key s3c', 'ret-va', 'lue ok\n']).join('')).toBe(`key ${MASK} ok\n`);
  });

  it('holds back only a tail that could start a value, and gives it at the end', () => {
    const out = run(['s3cret-value'], ['line one\n', 'ends with s3']);
    expect(out[0]).toBe('line one\n');
    expect(out.join('')).toBe('line one\nends with s3');
  });

  it('masks the longer of two values that overlap', () => {
    expect(run(['abc', 'abcdef'], ['x abcdef y abc\n']).join('')).toBe(`x ${MASK} y ${MASK}\n`);
  });
});
