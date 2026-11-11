// Scope grants (issue #2923, design.md "Scope grants"): a person's grant of a job's ask is kept for its scope — the box's
// template or the Windows host, and the job's repository —; each later job it grants is folded under it, the newest kept.
import { describe, expect, it } from 'vitest';
import type { Job, JobStatus } from '../../src/domain/types.ts';
import { SCOPE_JOBS_KEPT, scopeBy, scopeGrantView, scopeKeyOf, scopeOf, withJob, type VaultScopeGrant } from '../../src/domain/vault-scope-grants.ts';

const job = (id: string, status: JobStatus, repo?: string): Job => ({
  id, status, spec: { goal: `goal ${id}`, payload: {} }, ...(repo ? { source: { source: 'github', kind: 'issue', key: `k-${id}`, title: `title ${id}`, repo } } : {}),
} as unknown as Job);
const grant = (over: Partial<VaultScopeGrant> = {}): VaultScopeGrant => ({ key: 'template kube, repo octo-org/hello', template: 'kube', repo: 'octo-org/hello', by: 'alice', at: '2026-11-11T10:00:00.000Z', jobs: ['j1'], ...over });

describe('the scope of an ask', () => {
  it('is the template or the Windows host, and the job\'s repository', () => {
    expect(scopeOf(job('j1', 'running', 'octo-org/hello'), { template: 'kube' })).toEqual({ repo: 'octo-org/hello', template: 'kube' });
    expect(scopeOf(job('j1', 'running'), { windowsHost: 'win-1' })).toEqual({ windowsHost: 'win-1' });
  });

  it('is kept by one key for each place and repository', () => {
    expect(scopeKeyOf({ template: 'kube', repo: 'octo-org/hello' })).toBe('template kube, repo octo-org/hello');
    expect(scopeKeyOf({ windowsHost: 'win-1' })).toBe('windows host win-1, repo (none)');
    expect(scopeKeyOf({ template: 'kube', repo: 'octo-org/other' })).not.toBe(scopeKeyOf({ template: 'kube', repo: 'octo-org/hello' }));
  });
});

describe('the jobs of a scope grant', () => {
  it('adds a job once, and keeps the newest', () => {
    expect(withJob(grant(), 'j1')).toBeUndefined();
    expect(withJob(grant(), 'j2')?.jobs).toEqual(['j1', 'j2']);
    const full = grant({ jobs: Array.from({ length: SCOPE_JOBS_KEPT }, (_, i) => `j${i}`) });
    expect(withJob(full, 'new')?.jobs).toEqual([...full.jobs.slice(1), 'new']);
  });

  it('are folded under its row newest first, with how many wait or are at work', () => {
    const jobs = new Map([['j1', job('j1', 'finished', 'octo-org/hello')], ['j2', job('j2', 'running', 'octo-org/hello')]]);
    expect(scopeGrantView(grant({ jobs: ['j1', 'j2', 'gone'] }), (id) => jobs.get(id))).toEqual({
      ...grant(), live: 1,
      jobs: [{ job: 'gone', ended: true }, { job: 'j2', title: 'title j2', status: 'running', ended: false }, { job: 'j1', title: 'title j1', status: 'finished', ended: true }],
    });
  });

  it('a later job it grants names the person who granted it', () => {
    expect(scopeBy(grant())).toBe('scope grant by alice');
  });
});
