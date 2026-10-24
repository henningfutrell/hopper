// Issue #716, item 1: what a job's template request is read as — its needs, the template's name — and what the read
// policy holds. Pure.
import { describe, expect, it } from 'vitest';
import { inReadPolicy, readPolicyProblem } from '../../src/domain/read-policy.ts';
import { catalogText } from '../../src/skills/catalog.ts';
import { needsOf, requestedName } from '../../src/skills/template-request.ts';

describe('a template request\'s needs (issue #716)', () => {
  it('reads each need as <operation>/<kind>/<asset>, split by spaces, commas or lines; the same need once', () => {
    expect(needsOf('read/cluster/lab, write/namespace/lab/web\nread/aws-role/123456789012/ReadOnly read/cluster/lab')).toEqual([
      { operation: 'read', asset: { kind: 'cluster', name: 'lab' } },
      { operation: 'write', asset: { kind: 'namespace', name: 'lab/web' } },
      { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/ReadOnly' } },
    ]);
  });

  it('refuses what it cannot read, and says why', () => {
    expect(needsOf(undefined)).toMatch(/^name what the work needs/);
    expect(needsOf('  ')).toMatch(/^name what the work needs/);
    expect(needsOf('delete/cluster/lab')).toContain('the operation is one of read, write, sync, apply');
    expect(needsOf('read/planet/mars')).toContain('the asset kind is one of');
    expect(needsOf('read/cluster')).toContain('write each need as <operation>/<kind>/<asset>');
    expect(needsOf('read/cluster/la b')).toContain('write each need as <operation>/<kind>/<asset>');
    expect(needsOf(Array.from({ length: 17 }, (_, i) => `read/cluster/c${i}`).join(' '))).toContain('at most 16');
  });

  it('names the template from the needs alone: the same needs in any order, the same name', () => {
    const a = needsOf('read/cluster/lab read/aws-account/1') as never;
    const b = needsOf('read/aws-account/1,read/cluster/lab') as never;
    expect(requestedName(a)).toMatch(/^asked-[0-9a-f]{12}$/);
    expect(requestedName(a)).toBe(requestedName(b));
    expect(requestedName(a)).not.toBe(requestedName(needsOf('write/cluster/lab read/aws-account/1') as never));
  });

  it('the catalog names the request and stays short', () => {
    expect(catalogText()).toContain('sandbox-template:');
    // Issue #1007 added need-step, issue #1905 topology, issue #1909 orchestrate, issue #2167 park: the catalog stays short, one line per skill.
    expect(catalogText().length).toBeLessThan(1300);
  });
});

describe('the read policy (issue #716)', () => {
  const policy = { assets: ['cluster/lab', 'namespace/lab/*', 'aws-account/*', 'aws-role/123/Read*'] };
  it('holds an asset named exactly, or under an entry that ends in *', () => {
    expect(inReadPolicy(policy, { kind: 'cluster', name: 'lab' })).toBe(true);
    expect(inReadPolicy(policy, { kind: 'cluster', name: 'lab2' })).toBe(false);
    expect(inReadPolicy(policy, { kind: 'cluster', name: 'prod' })).toBe(false);
    expect(inReadPolicy(policy, { kind: 'namespace', name: 'lab/web' })).toBe(true);
    expect(inReadPolicy(policy, { kind: 'namespace', name: 'prod/web' })).toBe(false);
    expect(inReadPolicy(policy, { kind: 'aws-account', name: '123456789012' })).toBe(true);
    expect(inReadPolicy(policy, { kind: 'aws-role', name: '123/ReadOnly' })).toBe(true);
    expect(inReadPolicy(policy, { kind: 'aws-role', name: '123/Admin' })).toBe(false);
    expect(inReadPolicy(undefined, { kind: 'cluster', name: 'lab' })).toBe(false);
  });

  it('refuses an entry it cannot read', () => {
    expect(readPolicyProblem(['cluster/lab', 'aws-account/*'])).toBeUndefined();
    expect(readPolicyProblem(['planet/mars'])).toContain('the asset kind is one of');
    expect(readPolicyProblem(['cluster'])).toContain('<kind>/<asset>');
    expect(readPolicyProblem(['*'])).toContain('<kind>/<asset>');
    expect(readPolicyProblem(['cluster/la*b'])).toContain('only at the end');
    expect(readPolicyProblem(Array.from({ length: 65 }, (_, i) => `cluster/c${i}`))).toContain('at most 64');
  });
});
