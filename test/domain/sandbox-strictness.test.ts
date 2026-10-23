// Issue #655 part 8: sandbox strictness (brake 2), pure. It sets, per template and per blast radius level, which sandbox
// runs gate 2 may approve with no person.
//
// Feature: sandbox strictness
//   Scenario: the most specific setting wins
//     Then a template's own strictness wins over its radius level's, and that over the default
//   Scenario: what each strictness asks of a person
//     Then relaxed and standard ask for nobody; strict asks for a person for medium, high and an unrated radius; locked always
import { describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX_STRICTNESS, personBrake, sandboxBrakeOf, sandboxBrakeText, type SandboxStrictness } from '../../src/domain/sandbox-strictness.ts';

const S: SandboxStrictness = { default: 'standard', radius: { high: 'strict' }, templates: { 'aws-prod': 'locked', 'utility-view': 'relaxed' } };

describe('sandbox strictness (issue #655, brake 2)', () => {
  it('a template wins over its radius level, and that over the default', () => {
    expect(sandboxBrakeOf(S, { name: 'aws-prod', radius: { level: 'low' } })).toEqual({ strictness: 'locked', at: { template: 'aws-prod' } });
    expect(sandboxBrakeOf(S, { name: 'utility-view', radius: { level: 'high' } })).toEqual({ strictness: 'relaxed', at: { template: 'utility-view' } });
    expect(sandboxBrakeOf(S, { name: 'other', radius: { level: 'high' } })).toEqual({ strictness: 'strict', at: { radius: 'high' } });
    expect(sandboxBrakeOf(S, { name: 'other', radius: { level: 'medium' } })).toEqual({ strictness: 'standard', at: 'default' });
    expect(sandboxBrakeOf(S, undefined)).toEqual({ strictness: 'standard', at: 'default' });
    expect(DEFAULT_SANDBOX_STRICTNESS).toEqual({ default: 'standard', radius: {}, templates: {} });
  });

  it('relaxed and standard ask for nobody; strict for medium, high or unrated; locked always', () => {
    const only = (strictness: SandboxStrictness['default']): SandboxStrictness => ({ default: strictness, radius: {}, templates: {} });
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(personBrake(only('relaxed'), { name: 't', radius: { level } })).toBeUndefined();
      expect(personBrake(only('standard'), { name: 't', radius: { level } })).toBeUndefined();
      expect(personBrake(only('locked'), { name: 't', radius: { level } })).toEqual({ strictness: 'locked', at: 'default' });
    }
    expect(personBrake(only('strict'), { name: 't', radius: { level: 'low' } })).toBeUndefined();
    expect(personBrake(only('strict'), { name: 't', radius: { level: 'medium' } })).toEqual({ strictness: 'strict', at: 'default' });
    expect(personBrake(only('strict'), undefined)).toEqual({ strictness: 'strict', at: 'default' });
    expect(personBrake(only('locked'), undefined)).toEqual({ strictness: 'locked', at: 'default' });
  });

  it('says where the brake was set', () => {
    expect(sandboxBrakeText({ strictness: 'locked', at: { template: 'aws-prod' } })).toBe('sandbox strictness locked for the template aws-prod');
    expect(sandboxBrakeText({ strictness: 'strict', at: { radius: 'high' } })).toBe('sandbox strictness strict for high blast radius');
    expect(sandboxBrakeText({ strictness: 'strict', at: 'default' })).toBe('sandbox strictness strict by default');
  });
});
