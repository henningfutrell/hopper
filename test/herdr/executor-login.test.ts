// Issue #476: herdr-claude and a job's login. The login goes to the logins (renewable: the job can be asked for
// a new code), never a question; no progress line carries its code; a login signal on screen completes it (issue
// #567), never Claude going on by itself. After a restart, the job waits on: the URL and code are read back from
// the screen, and nothing is reported anew.
// Issue #563: a GitHub login is not a job's to make. The job is told to ask the hopper's GitHub proxy instead;
// only when it reports the same login again, right after, does it go to the logins.
import { describe, expect, it } from 'vitest';
import type { LoginReport, RunLogins } from '../../src/domain/types.ts';
import { githubLoginNote, isGitHubLogin } from '../../src/executors/herdr/login.ts';
import { contextFor, jobWith, setup, until } from './support.ts';

const AUTH = {
  output: ['● codex waits for a login.', '  HOPPER_AUTH_PENDING', '  tool: codex', '  url: https://auth.openai.com/codex/device', '  code: WDJB-MJHT', '  expires_in: 900'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const GH_AUTH = {
  output: ['● gh waits for a login.', '  HOPPER_AUTH_PENDING', '  tool: gh auth login', '  url: https://github.com/login/device', '  code: ABCD-1234', '  expires_in: 900'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const DONE = { output: ['● BashOutput(codex login)', '  ⎿  Successfully logged in', '● Pushed.', '  HOPPER_DONE'] };

/** A Python MCP auth helper's device flow in the background: it polls the token endpoint, printing as it goes. */
const PY_CODE = 'QWER-TYUI';
const pyAuth = (polls: number) => ({
  output: [
    '● Bash(python auth.py &)',
    `  ⎿  To sign in, open https://auth.example.com/device and enter the code ${PY_CODE}`,
    '● The MCP server waits for its login.',
    '  HOPPER_AUTH_PENDING',
    '  tool: python auth.py',
    '  url: https://auth.example.com/device',
    `  code: ${PY_CODE}`,
    '  expires_in: 900',
  ],
  background: { work: '1 shell', polls, prints: ['     Waiting for authorization...', '     authorization_pending: polling again in 5s', '     slow_down: polling every 10s now'] },
});
const PY_DONE = { output: ['● BashOutput(auth.py)', '  ⎿  Token obtained; saved to the MCP token cache.', '● Logged in; the MCP server answers.', '  HOPPER_DONE'] };

function recorder() {
  const reports: { report: LoginReport; renewable: boolean; restore?: boolean }[] = [];
  const ends: string[] = [];
  const logins: RunLogins = {
    report: (report, o) => { reports.push({ report, ...o }); return 'l1'; },
    check: () => ({ act: 'wait' }),
    completed: (id) => { ends.push(`${id} completed`); },
    failed: (id, reason) => { ends.push(`${id} failed: ${reason}`); },
    expired: (id) => { ends.push(`${id} expired`); },
  };
  return { logins, reports, ends };
}

describe('herdr-claude executor: a login', () => {
  it('is reported, renewable, and waits without a nudge; the CLI saying it is logged in completes it', async () => {
    const s = setup({ turns: [AUTH, DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx, progress, saved } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    const run = s.executor.run({ ...ctx, logins: r.logins });
    await until(() => r.reports.length === 1, 100000);
    expect(r.reports[0]).toMatchObject({ report: { kind: 'device_code', tool: 'codex', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WDJB-MJHT' }, renewable: true });
    expect(saved.at(-1)).toMatchObject({ login: { id: 'l1', tool: 'codex' } });
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

  it('steers a GitHub login to the hopper: the job is told to ask it, and nothing goes to the logins (issue #563)', async () => {
    const s = setup({ turns: [GH_AUTH, DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    expect(await s.executor.run({ ...ctx, logins: r.logins })).toMatchObject({ kind: 'finished' });
    expect(r.reports).toEqual([]);
    expect(s.herdr.prompts).toHaveLength(2);
    expect(s.herdr.prompts[1]!.text).toBe(githubLoginNote('gh auth login'));
    expect(s.herdr.prompts[1]!.text).toContain('sh "$HOPPER_GH" help');
    expect(progress.map((p) => p.message)).toContain('the job started a gh auth login login: told it to ask the hopper for GitHub instead');
    expect(JSON.stringify(progress)).not.toContain('ABCD-1234');
  });

  it('takes a GitHub login the job reports again right after being steered: then it goes to the user', async () => {
    const s = setup({ turns: [GH_AUTH, GH_AUTH, DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    const run = s.executor.run({ ...ctx, logins: r.logins });
    await until(() => r.reports.length === 1, 100000);
    expect(r.reports[0]).toMatchObject({ report: { tool: 'gh auth login', userCode: 'ABCD-1234' } });
    s.herdr.wake(s.herdr.agentStarts[0]!.name);
    expect(await run).toMatchObject({ kind: 'finished' });
  });

  it('a device-flow script polling never completes it: not Claude going on, not the same code again, not the screen changing (issue #567)', async () => {
    const s = setup({ turns: [pyAuth(4), pyAuth(4), pyAuth(4), pyAuth(4), PY_DONE] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    const run = s.executor.run({ ...ctx, logins: r.logins });
    await until(() => r.reports.length === 4, 100000);
    expect(r.ends).toEqual([]);
    expect(new Set(r.reports.map((x) => x.report.userCode))).toEqual(new Set([PY_CODE]));
    expect(await run).toMatchObject({ kind: 'finished' });
    expect(r.ends).toEqual(['l1 completed']);
    expect(s.herdr.prompts).toHaveLength(1);
  });

  it('a job that ends with no login signal leaves its login to the sweep: never completed', async () => {
    const s = setup({ turns: [{ ...AUTH, background: { work: '1 shell', polls: 3 } }, { output: ['● Pushed.', '  HOPPER_DONE'] }] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    expect(await s.executor.run({ ...ctx, logins: r.logins })).toMatchObject({ kind: 'finished' });
    expect(r.ends).toEqual([]);
  });

  it('the code expiring on screen expires it at once', async () => {
    const expired = { output: ['● BashOutput(auth.py)', '  ⎿  {"error": "expired_token"}', '● The code expired before it was entered.'], background: { work: '1 shell', polls: 1_000_000 } };
    const s = setup({ turns: [pyAuth(3), expired] }, { idleNudgeMs: 20000 });
    const r = recorder();
    const { ctx, ac } = contextFor(jobWith({ prompt: 'go', timeoutMs: 3_600_000 }));
    const run = s.executor.run({ ...ctx, logins: r.logins });
    await until(() => r.ends.length === 1, 100000);
    expect(r.ends).toEqual(['l1 expired']);
    ac.abort('shutdown');
    await run;
  });
});

describe('a GitHub login (issue #563)', () => {
  it('is gh by its tool, or GitHub\'s device page by its URL', () => {
    expect(isGitHubLogin({ tool: 'gh', verificationUrl: 'https://example.com' })).toBe(true);
    expect(isGitHubLogin({ tool: 'gh auth login --web', verificationUrl: 'https://example.com' })).toBe(true);
    expect(isGitHubLogin({ tool: 'git push', verificationUrl: 'https://github.com/login/device' })).toBe(true);
    expect(isGitHubLogin({ tool: 'codex', verificationUrl: 'https://auth.openai.com/codex/device' })).toBe(false);
    expect(isGitHubLogin({ tool: 'ghost', verificationUrl: 'https://notgithub.com/login/device' })).toBe(false);
    expect(isGitHubLogin({ tool: 'x', verificationUrl: 'not a url' })).toBe(false);
  });
});
