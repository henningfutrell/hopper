// Issue #2088: one user's pending approvals — each connected account's intake orgs read in the background, the view
// answered from what was read last and never from GitHub, the stale mark over every account's runs, the kept answers
// given back to the next read, and a failed read that keeps what was read before with why. The reader is a fake at its seam.
import { describe, expect, it, vi } from 'vitest';
import type { PendingApproval } from '../../src/domain/types.ts';
import { createPendingApprovals, FRESH_MS } from '../../src/pending-approvals/service.ts';
import type { ApprovalsGitHub } from '../../src/pending-approvals/github.ts';
import type { ConditionalAnswers } from '../../src/repo-checks/conditional.ts';

type Row = Omit<PendingApproval, 'stale'>;
const row = (repo: string, runId: number, environment: string, waitingSince: string): Row => ({
  repo, runId, workflow: 'promote', title: `Promote ${runId}`, environments: [environment], waitingSince, url: `https://github.example/runs/${runId}`,
});

/** GitHub answers 304 to everything: an answer the read was given back is answered from what was kept. */
const unchanged = async () => { throw Object.assign(new Error('Not Modified'), { status: 304 }); };

function fakeReader(answer: () => Promise<{ approvals: Row[]; problems: { where: string; error: string }[] }>) {
  const asked: { orgs: readonly string[]; given: unknown }[] = [];
  const api: ApprovalsGitHub = {
    async waiting(orgs, answers: ConditionalAnswers) {
      // The answer kept from the read before, if the read was given it; then this read keeps one for the next.
      const given = await answers.get(unchanged, 'GET /user/repos', { page: 1 }).catch(() => undefined);
      asked.push({ orgs, given });
      answers.keep('GET /user/repos {"page":1}', { etag: '"e1"', data: ['kept'] });
      return answer();
    },
  };
  return { api, asked };
}

describe('pending approvals (issue #2088)', () => {
  it('reads each account\'s intake orgs, marks the stale runs over all of them, and answers from what it read', async () => {
    let now = Date.parse('2026-10-19T12:00:00Z');
    const one = fakeReader(async () => ({ approvals: [row('acme/ledger', 5, 'production-approval', '2026-10-08T10:00:00Z'), row('acme/ledger', 9, 'production-approval', '2026-10-19T09:00:00Z')], problems: [] }));
    const two = fakeReader(async () => ({ approvals: [row('widget-co/widgets', 41, 'production-approval', '2026-10-18T09:00:00Z'), row('acme/ledger', 9, 'production-approval', '2026-10-19T09:00:00Z')], problems: [{ where: 'widget-co/infra', error: 'GitHub answered 403' }] }));
    const s = createPendingApprovals({
      sources: () => [
        { account: 'github', api: one.api, repos: ['acme/ledger', 'Acme/iac'] },
        { account: 'github-2', api: two.api, repos: ['widget-co/widgets'] },
      ],
      now: () => now, log: () => undefined,
    });
    expect(s.view()).toEqual({ approvals: [], orgs: ['acme', 'widget-co'], problems: [] });
    await s.tick();
    expect(one.asked.map((a) => a.orgs)).toEqual([['acme']]);
    expect(two.asked.map((a) => a.orgs)).toEqual([['widget-co']]);
    const v = s.view();
    expect(v.checkedAt).toBe('2026-10-19T12:00:00.000Z');
    // The run both accounts reach is one row.
    expect(v.approvals.map((a) => [a.runId, a.stale])).toEqual([[41, false], [9, false], [5, true]]);
    expect(v.problems).toEqual([{ where: 'widget-co/infra', error: 'GitHub answered 403' }]);

    // Not due yet: no read. Due: read with the answers kept from the read before.
    now += FRESH_MS - 1;
    await s.tick();
    expect(one.asked).toHaveLength(1);
    now += 1;
    await s.tick();
    expect(one.asked[0]!.given).toBeUndefined();
    expect(one.asked[1]!.given).toEqual(['kept']);
  });

  it('a failed read keeps the account\'s approvals read before, and says why', async () => {
    let fail = false;
    let now = 0;
    const r = fakeReader(async () => { if (fail) throw new Error('GitHub answered 502'); return { approvals: [row('acme/ledger', 9, 'production-approval', '2026-10-19T09:00:00Z')], problems: [] }; });
    const lines: string[] = [];
    const s = createPendingApprovals({ sources: () => [{ account: 'github', api: r.api, repos: ['acme/ledger'] }], now: () => now, log: (l) => lines.push(l) });
    await s.tick();
    fail = true;
    now += FRESH_MS;
    await s.tick();
    const v = s.view();
    expect(v.approvals.map((a) => a.runId)).toEqual([9]);
    expect(v.problems).toEqual([{ where: 'github', error: 'GitHub answered 502' }]);
    expect(lines.join('\n')).toContain('GitHub answered 502');
  });

  it('an account with no connection is a problem; one with no job repository reads nothing', async () => {
    const r = fakeReader(async () => ({ approvals: [], problems: [] }));
    const s = createPendingApprovals({
      sources: () => [{ account: 'github', problem: 'GitHub is not connected' }, { account: 'github-2', api: r.api, repos: [] }],
      now: () => 0, log: () => undefined,
    });
    await s.tick();
    expect(r.asked).toEqual([]);
    expect(s.view()).toMatchObject({ approvals: [], orgs: [], problems: [{ where: 'github', error: 'GitHub is not connected' }] });
  });

  it('one read at a time: a tick while one runs joins it, and the view says it reads', async () => {
    let release: (() => void) | undefined;
    const r = fakeReader(() => new Promise((ok) => { release = () => ok({ approvals: [], problems: [] }); }));
    const s = createPendingApprovals({ sources: () => [{ account: 'github', api: r.api, repos: ['acme/ledger'] }], now: () => 0, log: () => undefined });
    const a = s.tick(), b = s.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(s.view().reading).toBe(true);
    release!();
    await Promise.all([a, b]);
    expect(r.asked).toHaveLength(1);
    expect(s.view().reading).toBeUndefined();
  });
});
