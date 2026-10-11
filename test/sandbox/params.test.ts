// Issue #708: a template is a base skeleton, and each launch fills in its parameters within what the template allows.
// Pure: src/sandbox/params.ts. Through the HTTP route: test/integration/sandbox-lifecycle.test.ts.
//
// Feature: launch parameters within a template's limits
//   Scenario: a launch that names nothing gets the template's defaults
//   Scenario: a launch may name less or more, up to the template's max
//   Scenario: more than the max is refused, naming the parameter and the max
//   Scenario: a secret outside the template's approved secrets is refused
//   Scenario: a profile the template does not declare is refused
//   Scenario: a launch gets the template's tools, or names fewer of them; a tool outside them is refused (issue #716)
//   Scenario: a box of no template may name any tool the hopper adds
//   Scenario: a box of no template gets the hopper's defaults
//   Scenario: a template's limits must have each default within its max
//   Scenario: a record's launch scope is its resolved secrets and its one profile; a box of no template has none
import { describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/sandboxes.ts';
import { DEFAULT_LIMITS, launchScopeOf, limitsProblem, resolveParams } from '../../src/sandbox/params.ts';

const kube = {
  name: 'kube', gives: ['KUBE_TOKEN', 'AWS_KEY'], profiles: ['read/cluster/prod'],
  limits: { cpus: { default: 1, max: 2 }, memoryMb: { default: 1024, max: 4096 }, ttlMinutes: { default: 60, max: 480 } },
};

describe('launch parameters', () => {
  it('a launch that names nothing gets the template\'s defaults', () => {
    expect(resolveParams(kube, {})).toEqual({ ok: true, params: { secrets: ['KUBE_TOKEN', 'AWS_KEY'], cpus: 1, memoryMb: 1024, ttlMinutes: 60 } });
  });

  it('a launch may name less or more, up to the template\'s max', () => {
    expect(resolveParams(kube, { secrets: ['KUBE_TOKEN'], cpus: 2, memoryMb: 512, ttlMinutes: 480, profile: 'read/cluster/prod' })).toEqual({
      ok: true, params: { secrets: ['KUBE_TOKEN'], cpus: 2, memoryMb: 512, ttlMinutes: 480, profile: 'read/cluster/prod' },
    });
  });

  it('more than the max is refused, naming the parameter and the max', () => {
    expect(resolveParams(kube, { cpus: 3 })).toEqual({ ok: false, error: 'cpus 3 is more than the template kube allows: at most 2' });
    expect(resolveParams(kube, { memoryMb: 8192 })).toEqual({ ok: false, error: 'memoryMb 8192 is more than the template kube allows: at most 4096' });
    expect(resolveParams(kube, { ttlMinutes: 481 })).toEqual({ ok: false, error: 'ttlMinutes 481 is more than the template kube allows: at most 480' });
  });

  it('zero or less is refused', () => {
    expect(resolveParams(kube, { cpus: 0 })).toEqual({ ok: false, error: 'cpus must be more than 0' });
    expect(resolveParams(kube, { ttlMinutes: -1 })).toEqual({ ok: false, error: 'ttlMinutes must be more than 0' });
  });

  it('a secret outside the template\'s approved secrets is refused', () => {
    expect(resolveParams(kube, { secrets: ['KUBE_TOKEN', 'GH_TOKEN'] })).toEqual({
      ok: false, error: 'the template kube does not give GH_TOKEN: it gives KUBE_TOKEN, AWS_KEY',
    });
  });

  it('a profile the template does not declare is refused', () => {
    expect(resolveParams(kube, { profile: 'write/cluster/prod' })).toEqual({
      ok: false, error: 'the template kube has no operation profile write/cluster/prod: it has read/cluster/prod',
    });
  });

  it('a launch gets the template\'s tools, or names fewer of them; a tool outside them is refused (issue #716)', () => {
    const tools = { ...kube, tools: ['aws', 'kubectl'] };
    expect(resolveParams(tools, {})).toMatchObject({ ok: true, params: { tools: ['aws', 'kubectl'] } });
    expect(resolveParams(tools, { tools: ['kubectl', 'kubectl'] })).toMatchObject({ ok: true, params: { tools: ['kubectl'] } });
    expect(resolveParams(tools, { tools: [] })).toEqual({ ok: true, params: { secrets: kube.gives, cpus: 1, memoryMb: 1024, ttlMinutes: 60 } });
    expect(resolveParams(tools, { tools: ['helm'] })).toEqual({ ok: false, error: 'the template kube does not add helm: it adds aws, kubectl' });
    expect(resolveParams(kube, { tools: ['helm'] })).toEqual({ ok: false, error: 'the template kube does not add helm: it adds no tool' });
  });

  it('a box of no template may name any tool the hopper adds', () => {
    expect(resolveParams(undefined, { tools: ['terraform', 'aws'] })).toMatchObject({ ok: true, params: { tools: ['aws', 'terraform'] } });
    expect(resolveParams(undefined, { tools: ['nmap'] })).toEqual({ ok: false, error: 'nmap is not a tool the hopper adds to a box: it adds aws, helm, kubectl, terraform' });
  });

  it('a box of no template gets the hopper\'s defaults, and no time limit', () => {
    expect(resolveParams(undefined, {})).toEqual({
      ok: true, params: { secrets: [], cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default },
    });
    expect(resolveParams(undefined, { cpus: DEFAULT_LIMITS.cpus.max + 1 })).toEqual({
      ok: false, error: `cpus ${DEFAULT_LIMITS.cpus.max + 1} is more than a box allows: at most ${DEFAULT_LIMITS.cpus.max}`,
    });
    expect(resolveParams(undefined, { ttlMinutes: 30 })).toEqual({
      ok: true, params: { secrets: [], cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default, ttlMinutes: 30 },
    });
    expect(resolveParams(undefined, { secrets: ['X'] })).toEqual({ ok: false, error: 'a box of no template gives no secret: X' });
  });

  it('a template with no limits gets the hopper\'s defaults', () => {
    expect(resolveParams({ ...kube, limits: undefined }, {})).toEqual({
      ok: true, params: { secrets: kube.gives, cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default },
    });
  });

  it('a template\'s limits must have each default within its max', () => {
    expect(limitsProblem(kube.limits)).toBeUndefined();
    expect(limitsProblem({ cpus: { default: 4, max: 2 } })).toBe('cpus: the default 4 is more than the max 2');
    expect(limitsProblem({ memoryMb: { default: 0, max: 2 } })).toBe('memoryMb: the default must be more than 0');
    expect(limitsProblem({ ttlMinutes: { default: 600, max: 60 } })).toBe('ttlMinutes: the default 600 is more than the max 60');
    expect(limitsProblem({ ttlMinutes: { max: 60 } })).toBeUndefined();
  });

  it('a record\'s launch scope is its resolved secrets and its one profile; a box of no template has none', () => {
    const record = (o: Partial<SandboxRecord>): SandboxRecord => ({
      id: 'r1', userId: 'u', name: 'hopper-sandbox-kube', agent: 'claude', image: 'example.org/kube:1', params: { secrets: ['KUBE_TOKEN'], cpus: 1, memoryMb: 1024 },
      runtime: 'podman', machine: 'local', containerId: 'c1', volume: 'v', keepHome: true, state: 'ready', createdAt: '2026-10-11T00:00:00Z', address: 'http://hopper:1', ...o,
    });
    const template = { name: 'kube', version: '1' };
    expect(launchScopeOf(record({ template }))).toEqual({ secrets: ['KUBE_TOKEN'] });
    expect(launchScopeOf(record({ template, params: { secrets: [], cpus: 1, memoryMb: 1, profile: 'read/namespace/lab/web' } })))
      .toEqual({ secrets: [], profile: { operation: 'read', asset: { kind: 'namespace', name: 'lab/web' } } });
    // A box taken on from before the records has no template: its template, if it joined with one, decides alone.
    expect(launchScopeOf(record({}))).toBeUndefined();
    expect(launchScopeOf(undefined)).toBeUndefined();
  });
});
