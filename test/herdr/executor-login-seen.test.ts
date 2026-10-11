// Issue #698: a device code a herdr job's screen shows, when the job ends its turn without HOPPER_AUTH_PENDING, still
// reaches the user: the hopper reports it to the logins at once, and tells the job to report it with the protocol
// lines, so a login signal can end it. A GitHub code is steered to the hopper's GitHub proxy, as a reported one is
// (issue #563). A code the job already reported is not taken again.
import { describe, expect, it } from 'vitest';
import type { LoginReport, RunLogins } from '../../src/domain/types.ts';
import { githubLoginNote, loginSeenNote } from '../../src/executors/herdr/login.ts';
import { STATUS_NOTE_NUDGE } from '../../src/executors/herdr/screen.ts';
import { contextFor, jobWith, setup, until } from './support.ts';

const FOREVER = { work: '1 shell', polls: 1_000_000 };
const SEEN = {
  output: ['● Bash(tool login &)', '  ⎿  Open https://auth.example.com/device and enter the code QWER-TYUI (expires in 10 minutes)', '● The tool waits for its login.'],
  background: FOREVER,
};
const REPORTED = {
  output: ['● The tool waits for its login.', '  HOPPER_AUTH_PENDING', '  tool: tool login', '  url: https://auth.example.com/device', '  code: QWER-TYUI', '  expires_in: 600'],
  background: FOREVER,
};
const GH_SEEN = {
  output: ['● Bash(gh auth login --web &)', '  ⎿  ! First copy your one-time code: ABCD-1234', '     Open this URL to continue in your web browser: https://github.com/login/device', '● gh waits.'],
  background: FOREVER,
};
const AUTH = {
  output: ['● codex waits for a login.', '  HOPPER_AUTH_PENDING', '  tool: codex', '  url: https://auth.openai.com/codex/device', '  code: WDJB-MJHT', '  expires_in: 900'],
  background: { work: '1 shell', polls: 3 },
};
const DONE = { output: ['● Pushed.', '  HOPPER_DONE'] };

function recorder() {
  const reports: { report: LoginReport; renewable: boolean }[] = [];
  const logins: RunLogins = {
    report: (report, o) => { reports.push({ report, renewable: o.renewable }); return 'l1'; },
    check: () => ({ act: 'wait' }),
    completed: () => {},
    failed: () => {},
    expired: () => {},
  };
  return { logins, reports };
}

describe('herdr-claude executor: a device code on screen, not reported (issue #698)', () => {
  it('is reported to the logins at once, and the job is told to report it; its report is the same login', async () => {
    const s = setup({ turns: [SEEN, REPORTED, DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    const run = s.executor.run({ ...ctx, logins: r.logins });
    await until(() => r.reports.length === 2, 100000);
    expect(r.reports[0]).toMatchObject({ report: { kind: 'device_code', tool: 'auth.example.com', verificationUrl: 'https://auth.example.com/device', userCode: 'QWER-TYUI' }, renewable: true });
    expect(s.herdr.prompts[1]!.text).toBe(loginSeenNote('auth.example.com'));
    expect(s.herdr.prompts[1]!.text).toContain('HOPPER_AUTH_PENDING');
    expect(s.herdr.prompts).toHaveLength(2);
    s.herdr.wake(s.herdr.agentStarts[0]!.name);
    expect(await run).toMatchObject({ kind: 'finished' });
    expect(JSON.stringify(progress)).not.toContain('QWER-TYUI');
  });

  it('a GitHub code on screen is steered to the hopper, never reported', async () => {
    const s = setup({ turns: [GH_SEEN, DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    expect(await s.executor.run({ ...ctx, logins: r.logins })).toMatchObject({ kind: 'finished' });
    expect(r.reports).toEqual([]);
    expect(s.herdr.prompts[1]!.text).toBe(githubLoginNote('gh'));
  });

  it('a code the job reported before is not taken again: a turn after it with no marker is a status note', async () => {
    const s = setup({ turns: [AUTH, { output: ['● Going on.'] }, DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    expect(await s.executor.run({ ...ctx, logins: r.logins })).toMatchObject({ kind: 'finished' });
    expect(r.reports).toHaveLength(1);
    expect(s.herdr.prompts[1]!.text).toBe(STATUS_NOTE_NUDGE);
  });
});
