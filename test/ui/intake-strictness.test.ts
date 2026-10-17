// Intake strictness in the UI (issue #655 part 3), pure: the overrides as lines a person edits, and what each level means.
import { describe, expect, it } from 'vitest';
import { formatOverrides, parseOverrides, STRICTNESS_TEXT } from '../../ui/src/model/intake-strictness.ts';

describe('the intake strictness panel', () => {
  it('writes the overrides one per line, repositories after sources', () => {
    expect(formatOverrides({ default: 'standard', sources: { manual: 'open' }, repos: { 'octo/tools': 'strict' } })).toBe('manual open\nocto/tools strict');
    expect(formatOverrides({ default: 'standard', sources: {}, repos: {} })).toBe('');
  });

  it('reads a line with a slash as a repository, else as a source; repositories lowercased', () => {
    expect(parseOverrides('manual open\n\n  Octo/Tools   closed  ')).toEqual({ ok: true, sources: { manual: 'open' }, repos: { 'octo/tools': 'closed' } });
  });

  it('refuses a line it cannot read, and says which', () => {
    expect(parseOverrides('manual loose')).toEqual({ ok: false, error: 'Line 1: "manual loose" — write a source or owner/name, then open, standard, strict or closed' });
    expect(parseOverrides('manual open\nocto/tools')).toEqual({ ok: false, error: 'Line 2: "octo/tools" — write a source or owner/name, then open, standard, strict or closed' });
  });

  it('says what each strictness lets run', () => {
    expect(STRICTNESS_TEXT.standard).toBe('Standard: a job runs when its item is from a trusted origin or a person approved it.');
    expect(STRICTNESS_TEXT.closed).toBe('Closed: only items you wrote yourself and that were assigned to you run.');
  });
});
