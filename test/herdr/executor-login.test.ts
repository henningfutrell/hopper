// Issue #476: herdr-claude and a job's login. The login goes to the logins (renewable: the job can be asked for
// a new code), never a question; no progress line carries its code; Claude going on completes it. After a
// restart, the job waits on: the URL and code are read back from the screen, and nothing is reported anew.
import { describe, expect, it } from 'vitest';
import type { RunLogins } from '../../src/domain/ports.ts';
import type { LoginReport } from '../../src/domain/types.ts';
import { contextFor, jobWith, setup, until } from './support.ts';

const AUTH = {
  output: ['● gh waits for a login.', '  HOPPER_AUTH_PENDING', '  tool: gh', '  url: https://github.com/login/device', '  code: WDJB-MJHT', '  expires_in: 900'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const DONE = { output: ['● Pushed.', '  HOPPER_DONE'] };

function recorder() {
  const reports: { report: LoginReport; renewable: boolean; restore?: boolean }[] = [];
  const ends: string[] = [];
  const logins: RunLogins = {
    report: (report, o) => { reports.push({ report, ...o }); return 'l1'; },
    check: () => ({ act: 'wait' }),
    completed: (id) => { ends.push(`${id} completed`); },
    failed: (id, reason) => { ends.push(`${id} failed: ${reason}`); },
  };
  return { logins, reports, ends };
}

describe('herdr-claude executor: a login', () => {
  it('is reported, renewable, and waits without a nudge; Claude going on completes it', async () => {
    const s = setup({ turns: [AUTH, DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx, progress, saved } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    const run = s.executor.run({ ...ctx, logins: r.logins });
    await until(() => r.reports.length === 1, 100000);
    expect(r.reports[0]).toMatchObject({ report: { kind: 'device_code', tool: 'gh', verificationUrl: 'https://github.com/login/device', userCode: 'WDJB-MJHT' }, renewable: true });
    expect(saved.at(-1)).toMatchObject({ login: { id: 'l1', tool: 'gh' } });
    const waited = s.clock.elapsed();
    await until(() => s.clock.elapsed() > waited + 3_000_000, 1_000_000);
    expect(s.herdr.prompts).toHaveLength(1);
    s.herdr.wake(s.herdr.agentStarts[0]!.name);
    expect(await run).toMatchObject({ kind: 'finished' });
    expect(r.ends).toEqual(['l1 completed']);
    expect(JSON.stringify(progress)).not.toContain('WDJB-MJHT');
  });

  it('after a restart it waits on, its code read back from the screen: restored, never reported anew', async () => {
    const s = setup({ turns: [AUTH, DONE] }, { idleNudgeMs: 20000 });
    const first = recorder();
    const { ctx, ac, saved } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    const run = s.executor.run({ ...ctx, logins: first.logins });
    await until(() => first.reports.length === 1, 100000);
    ac.abort('shutdown');
    expect(await run).toMatchObject({ kind: 'failed', error: 'shutdown' });

    const after = recorder();
    const again = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }, { executorState: saved.at(-1)! }));
    const reattached = s.executor.reattach!({ ...again.ctx, logins: after.logins });
    await until(() => after.reports.length === 1, 100000);
    expect(after.reports[0]).toMatchObject({ report: { userCode: 'WDJB-MJHT' }, restore: true });
    expect(s.herdr.prompts).toHaveLength(1);
    s.herdr.wake(s.herdr.agentStarts[0]!.name);
    expect(await reattached).toMatchObject({ kind: 'finished' });
    expect(after.ends).toEqual(['l1 completed']);
  });
});
