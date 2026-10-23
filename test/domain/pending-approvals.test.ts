// Issue #2088: pending approvals, pure — the intake orgs of the job repositories, a waiting run's row from GitHub's
// answers (only the environments the connection can approve), and the stale mark (a newer waiting run of the same
// repository and environment), with the rows in their order.
import { describe, expect, it } from 'vitest';
import { intakeOrgs, markStale, pendingApprovalOf, type PendingApproval } from '../../src/domain/types.ts';

const run = (id: number, o: Record<string, unknown> = {}) => ({
  id, name: 'promote', display_title: `Promote build ${id}`, html_url: `https://github.com/acme/ledger/actions/runs/${id}`,
  created_at: '2026-10-08T10:00:00Z', ...o,
});
const env = (name: string, can: boolean, at = '2026-10-08T10:05:00Z') => ({ environment: { name }, current_user_can_approve: can, wait_timer_started_at: at });

describe('intakeOrgs', () => {
  it('the owners of the job repositories, once each, in lower case, sorted', () => {
    expect(intakeOrgs(['Acme/ledger', 'acme/identity', 'Widget-Co/widgets', 'acme/iac'])).toEqual(['acme', 'widget-co']);
    expect(intakeOrgs([])).toEqual([]);
  });
});

describe('pendingApprovalOf', () => {
  it('a run with an environment the connection can approve: its row, only those environments', () => {
    expect(pendingApprovalOf('acme/ledger', run(7), [env('production-approval', true), env('audit', false)])).toEqual({
      repo: 'acme/ledger', runId: 7, workflow: 'promote', title: 'Promote build 7', environments: ['production-approval'],
      waitingSince: '2026-10-08T10:05:00Z', url: 'https://github.com/acme/ledger/actions/runs/7',
    });
  });

  it('a run that waits only on environments someone else approves is no row', () => {
    expect(pendingApprovalOf('acme/ledger', run(7), [env('production-approval', false)])).toBeUndefined();
    expect(pendingApprovalOf('acme/ledger', run(7), [])).toBeUndefined();
  });

  it('waiting since: the earliest wait of its environments, else when the run was made; the run name when it has no title', () => {
    const two = [env('iac-apply-staging', true, '2026-10-08T11:00:00Z'), env('iac-apply-prod', true, '2026-10-08T10:30:00Z')];
    expect(pendingApprovalOf('acme/iac', run(9), two)?.waitingSince).toBe('2026-10-08T10:30:00Z');
    expect(pendingApprovalOf('acme/iac', run(9), two)?.environments).toEqual(['iac-apply-prod', 'iac-apply-staging']);
    const plain = pendingApprovalOf('acme/iac', run(9, { display_title: undefined }), [{ environment: { name: 'x' }, current_user_can_approve: true }]);
    expect(plain).toMatchObject({ title: 'promote', waitingSince: '2026-10-08T10:00:00Z' });
  });
});

describe('markStale', () => {
  const row = (repo: string, runId: number, environments: string[], waitingSince: string): Omit<PendingApproval, 'stale'> => ({
    repo, runId, workflow: 'w', title: `t${runId}`, environments, waitingSince, url: `u${runId}`,
  });

  it('an older waiting run is stale when a newer one waits on the same repository and environment', () => {
    const rows = markStale([
      row('acme/ledger', 5, ['production-approval'], '2026-10-08T10:00:00Z'),
      row('acme/ledger', 9, ['production-approval'], '2026-10-19T09:00:00Z'),
      row('acme/identity', 3, ['production-approval'], '2026-10-18T09:00:00Z'),
    ]);
    expect(rows.map((r) => [r.repo, r.runId, r.stale])).toEqual([
      ['acme/identity', 3, false], ['acme/ledger', 9, false], ['acme/ledger', 5, true],
    ]);
  });

  it('a run stays fresh while one of its environments has no newer run; the same environment name in another repository counts not', () => {
    const rows = markStale([
      row('acme/iac', 1, ['iac-apply-staging', 'iac-apply-prod'], '2026-10-18T09:00:00Z'),
      row('acme/iac', 2, ['iac-apply-staging'], '2026-10-18T10:00:00Z'),
      row('acme/other', 3, ['iac-apply-prod'], '2026-10-18T11:00:00Z'),
    ]);
    expect(rows.every((r) => !r.stale)).toBe(true);
  });

  it('fresh rows first, the longest waiting first; then the stale ones', () => {
    const rows = markStale([
      row('a/r', 1, ['e'], '2026-10-01T00:00:00Z'), row('a/r', 2, ['e'], '2026-10-02T00:00:00Z'),
      row('b/r', 3, ['e'], '2026-10-03T00:00:00Z'), row('c/r', 4, ['e'], '2026-10-01T12:00:00Z'),
    ]);
    expect(rows.map((r) => r.runId)).toEqual([4, 2, 3, 1]);
  });
});
