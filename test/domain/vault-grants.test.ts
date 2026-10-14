// What a vault grant covers, as a person reads it (issue #1124, design.md "Vault grants"): the item's title, repository and
// link, its newest job and that job's status, and whether the grant is stale — no job of the item at work or waiting —;
// and how the grant was made: Grant (the UI, an API token or `hopper vault grant`) or a direct job's submission that
// authorized the vault, with the operator CLI's command when it was made there.
import { describe, expect, it } from 'vitest';
import type { DirectJob } from '../../src/domain/direct-jobs.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';
import { grantView, type VaultGrant } from '../../src/domain/vault-grants.ts';

const ISSUE = 'https://github.com/octo-org/hello/issues/9';
const job = (status: JobStatus, over: Partial<Job> = {}): Job => ({
  id: 'job-2', status, spec: { goal: 'the goal', payload: {} },
  source: { source: 'github', kind: 'issue', key: ISSUE, url: ISSUE, title: 'Fix the login', repo: 'octo-org/hello', number: 9 },
  ...over,
} as unknown as Job);
const grant = (over: Partial<VaultGrant> = {}): VaultGrant => ({ key: ISSUE, job: 'job-1', by: 'alice', at: '2026-10-11T11:00:00.000Z', ...over });
const direct = (over: Partial<DirectJob> = {}): DirectJob => ({
  id: 'd1', title: 'Rotate the lab key', brief: 'b', labels: [], authorizations: ['vault'], repo: 'octo-org/lab',
  submittedBy: { person: 'operator CLI', via: 'cli' }, submittedAt: '2026-10-11T10:00:00.000Z', ...over,
});

describe('grantView', () => {
  it('an issue\'s grant names its title, repository, link, newest job and that job\'s status', () => {
    expect(grantView(grant(), { newest: job('running') })).toEqual({
      ...grant(), made: 'grant',
      item: { title: 'Fix the login', repo: 'octo-org/hello', url: ISSUE, job: 'job-2', status: 'running', stale: false },
    });
  });

  it('is stale when the item\'s newest job ended, or no job of it is kept', () => {
    for (const s of ['finished', 'failed', 'cancelled', 'rejected'] as const) expect(grantView(grant(), { newest: job(s) }).item.stale).toBe(true);
    for (const s of ['queued', 'held', 'waiting_answer', 'parked'] as const) expect(grantView(grant(), { newest: job(s) }).item.stale).toBe(false);
    expect(grantView(grant(), {}).item).toEqual({ title: ISSUE, stale: true });
  });

  it('a direct job\'s grant names the direct job\'s title and repository, and its submission made it', () => {
    const key = 'direct:d1';
    const newest = job('finished', { source: { source: 'direct', kind: 'direct', key } });
    expect(grantView(grant({ key, by: 'operator CLI' }), { newest, direct: direct() })).toEqual({
      ...grant({ key, by: 'operator CLI' }), made: 'submit', via: 'cli', command: 'hopper job submit --authorize vault',
      item: { title: 'Rotate the lab key', repo: 'octo-org/lab', job: 'job-2', status: 'finished', stale: true },
    });
    expect(grantView(grant({ key, by: 'alice' }), { newest, direct: direct({ submittedBy: { person: 'alice', via: 'ui' } }) })).toMatchObject({ made: 'submit', via: 'ui' });
  });

  it('a grant the operator CLI made names its command; a direct job that did not authorize the vault was granted after', () => {
    expect(grantView(grant({ by: 'operator CLI' }), { newest: job('running') })).toMatchObject({ made: 'grant', via: 'cli', command: 'hopper vault grant job-1' });
    const key = 'direct:d1';
    expect(grantView(grant({ key, by: 'alice' }), { direct: direct({ authorizations: [] }) })).toMatchObject({ made: 'grant', item: { title: 'Rotate the lab key' } });
  });

  it('a job of no source is named by its goal', () => {
    expect(grantView(grant({ key: 'job-2' }), { newest: job('running', { source: undefined }) }).item).toEqual({ title: 'the goal', job: 'job-2', status: 'running', stale: false });
  });
});
