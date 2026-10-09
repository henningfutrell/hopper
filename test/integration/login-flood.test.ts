// Issue #567: a job running a device-flow script that polls its token endpoint — a Python MCP auth helper, or gh —
// shows exactly one open login until it really completes or expires. Claude going on, the script printing
// `authorization_pending` again, Claude reporting the same code again (under another tool name too): the same login,
// no new one, no `auth.*` event. It completes only on a login signal (a token obtained, the CLI saying it is logged
// in); a job that ends with none leaves its login to fail with the job, never completed.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHerdrClient, type FakeHerdrClient, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 100 } }];
const CODE = 'QWER-TYUI';
const POLLING = ['     Waiting for authorization...', '     authorization_pending: polling again in 5s', '     slow_down: polling every 10s now'];

/** Claude ends its turn on the login while the script polls in the background; the script's output wakes it after `polls` polls. */
const pyAuth = (o: { tool?: string; polls?: number } = {}): FakeTurn => ({
  output: [
    '● Bash(python auth.py &)',
    `  ⎿  To sign in, open https://auth.example.com/device and enter the code ${CODE}`,
    '● The MCP server waits for its login.',
    '  HOPPER_AUTH_PENDING',
    `  tool: ${o.tool ?? 'python auth.py'}`,
    '  url: https://auth.example.com/device',
    `  code: ${CODE}`,
    '  expires_in: 900',
  ],
  background: { work: '1 shell', polls: o.polls ?? 6, prints: POLLING },
});

const ghAuth = (polls: number): FakeTurn => ({
  output: [
    '● Bash(gh auth login --hostname github.com --web &)',
    '  ⎿  ! First copy your one-time code: WDJB-MJHT',
    '     Open this URL to continue in your web browser: https://github.com/login/device',
    '● gh waits for a login.',
    '  HOPPER_AUTH_PENDING',
    '  tool: gh',
    '  url: https://github.com/login/device',
    '  code: WDJB-MJHT',
    '  expires_in: 900',
  ],
  background: { work: '1 shell', polls },
});

async function start(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS }, seams: { herdr } });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const item = { executor: 'herdr-claude', prompt: 'Connect the MCP server' };

async function logins(a: TestApp) {
  return ((await a.api('GET', '/api/logins')).body as { logins: Record<string, unknown>[] }).logins;
}

const authTypes = async (a: TestApp, jobId: string) => (await a.events()).filter((e) => e.jobId === jobId && e.type.startsWith('auth.')).map((e) => e.type);

describe('a job polling a device flow', () => {
  it('a Python MCP auth loop: one login while it polls and Claude reports it again, completed once the token is obtained', async () => {
    const done: FakeTurn = { output: ['● BashOutput(auth.py)', '  ⎿  Token obtained; saved to the MCP token cache.', '● The MCP server answers.', '  HOPPER_DONE'] };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [pyAuth(), pyAuth(), pyAuth({ tool: 'auth.py' }), pyAuth(), pyAuth({ polls: 400 })] });
    const a = await start(herdr);
    const job = await a.pull({}, item);
    // Five reports of the one prompt, under two tool names: one login, open, the whole time.
    await waitFor(() => herdr.screen(herdr.agentStarts[0]?.paneId ?? '').split('\n').filter((l) => l === '  HOPPER_AUTH_PENDING').length === 5, { timeoutMs: 8000 });
    const open = await logins(a);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: 'pending', tool: 'python auth.py', jobId: job.id });
    expect(await authTypes(a, job.id)).toEqual(['auth.pending']);

    herdr.addTurns(done);
    herdr.wake(herdr.agentStarts[0]!.name);
    await a.waitForStatus(job.id, 'finished', 8000);
    const after = await logins(a);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: open[0]!.id, status: 'completed' });
    expect(await authTypes(a, job.id)).toEqual(['auth.pending', 'auth.completed']);
  });

  it("gh's device flow: once it reaches the user (issue #563), Claude checking on it again and again is the same login, never steered again; gh saying it is logged in completes it", async () => {
    const done: FakeTurn = { output: ['● BashOutput(gh)', '  ⎿  ✓ Authentication complete.', '     ✓ Logged in as octocat', '● Pushed.', '  HOPPER_DONE'] };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ghAuth(5), ghAuth(5), ghAuth(5), ghAuth(5), done] });
    const a = await start(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished', 8000);
    // The prompt, and the one note that steers the first report to the hopper's GitHub proxy.
    expect(herdr.prompts).toHaveLength(2);
    const after = await logins(a);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ tool: 'gh', status: 'completed' });
    expect(await authTypes(a, job.id)).toEqual(['auth.pending', 'auth.completed']);
  });

  it('a job that ends with no login signal: its login fails with the job, never completed', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [pyAuth(), { output: ['● Gave up on the MCP server.', '  HOPPER_DONE'] }] });
    const a = await start(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished', 8000);
    const login = await waitFor(async () => { const l = (await logins(a))[0]; return l?.status === 'failed' ? l : undefined; }, { timeoutMs: 8000 });
    expect(login.reason).toMatch(/^the job ended/);
    expect(await authTypes(a, job.id)).toEqual(['auth.pending', 'auth.failed']);
  });
});
