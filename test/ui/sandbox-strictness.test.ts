// Sandbox strictness in the UI (issue #655 part 8), pure: the template lines a person edits, and what each level means.
import { describe, expect, it } from 'vitest';
import { formatTemplates, parseTemplates, SANDBOX_STRICTNESS_TEXT } from '../../ui/src/model/sandbox-strictness.ts';

describe('the sandbox strictness panel', () => {
  it('writes the templates one per line', () => {
    expect(formatTemplates({ default: 'standard', radius: {}, templates: { 'aws-prod': 'locked', 'utility-view': 'relaxed' } })).toBe('aws-prod locked\nutility-view relaxed');
    expect(formatTemplates({ default: 'standard', radius: {}, templates: {} })).toBe('');
  });

  it('reads a template name, then its strictness; empty lines skipped', () => {
    expect(parseTemplates('aws-prod locked\n\n  utility-view   relaxed  ')).toEqual({ ok: true, templates: { 'aws-prod': 'locked', 'utility-view': 'relaxed' } });
  });

  it('refuses a line it cannot read, and says which', () => {
    expect(parseTemplates('aws-prod loose')).toEqual({ ok: false, error: 'Line 1: "aws-prod loose" — write a template name, then relaxed, standard, strict or locked' });
    expect(parseTemplates('aws-prod locked\nutility-view')).toEqual({ ok: false, error: 'Line 2: "utility-view" — write a template name, then relaxed, standard, strict or locked' });
  });

  it('says what each strictness asks of a person', () => {
    expect(SANDBOX_STRICTNESS_TEXT.strict).toBe('Strict: a person approves each run of a medium or high blast radius template.');
    expect(SANDBOX_STRICTNESS_TEXT.locked).toBe('Locked: a person approves each run.');
  });
});
