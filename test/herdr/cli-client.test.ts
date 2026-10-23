import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerdrError, createHerdrCliClient } from '../../src/executors/herdr/index.ts';

const BIN = fileURLToPath(new URL('./fake-herdr-bin.mjs', import.meta.url));
// The timeout for the calls the fake answers late (in 5 s): long enough for Node to start the fake and record its call on
// a loaded machine, so each call is counted; a shorter one ended a call before the fake recorded it.
const SLOW_MS = 1500;
chmodSync(BIN, 0o755);

let dir: string;
const saved = { ...process.env };

function calls(): { argv: string[]; claudeEnv: string[] }[] {
  return readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-herdr-cli-'));
  process.env.FAKE_HERDR_DIR = dir;
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_CHILD_SESSION = 'leak';
});

afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

describe('herdr CLI client', () => {
  const herdr = () => createHerdrCliClient({ bin: BIN, session: 'jh-test-x' });

  it('always passes --session first and scrubs Claude variables from the environment', async () => {
    await herdr().getAgent('jh-a');
    const [c] = calls();
    expect(c!.argv.slice(0, 2)).toEqual(['--session', 'jh-test-x']);
    expect(c!.claudeEnv).toEqual([]);
  });

  it('exposes its session', () => expect(herdr().session).toBe('jh-test-x'));

  it('refuses an empty session name', () => {
    expect(() => createHerdrCliClient({ bin: BIN, session: '' })).toThrow(/session/);
  });

  it('ensureWorkspace creates the labelled workspace without focus when none exists', async () => {
    expect(await herdr().ensureWorkspace('hopper', '/tmp/a')).toBe('w9');
    expect(calls().map((c) => c.argv.slice(2))).toEqual([
      ['workspace', 'list'],
      ['workspace', 'create', '--label', 'hopper', '--cwd', '/tmp/a', '--no-focus'],
    ]);
  });

  it('ensureWorkspace finds an existing workspace by label', async () => {
    process.env.FAKE_HERDR_HAS_WS = '1';
    expect(await herdr().ensureWorkspace('hopper', '/tmp/a')).toBe('w7');
    expect(calls()).toHaveLength(1);
  });

  it('listPanes lists every pane of the session, with no path (issue #1128)', async () => {
    process.env.FAKE_HERDR_PANE_LIST = '1';
    expect(await herdr().listPanes()).toEqual([
      { paneId: 'w7:p1', tabId: 'w7:t1', workspaceId: 'w7', agentStatus: 'unknown' },
      { paneId: 'w7:p5', tabId: 'w7:t3', workspaceId: 'w7', title: 'Fix it', agent: 'claude', agentStatus: 'working' },
    ]);
    expect(calls()[0]!.argv.slice(2)).toEqual(['pane', 'list']);
  });

  it('findTab finds the tab by its label in the workspace, with its pane, that pane\'s terminal and its agent (issue #1569)', async () => {
    process.env.FAKE_HERDR_PANE_LIST = '1';
    expect(await herdr().findTab({ workspaceId: 'w7', label: 'local/lane-1 · abcd1234 · 1.1' }))
      .toEqual({ tabId: 'w7:t3', paneId: 'w7:p5', terminalId: 'term_a1', agent: 'claude' });
    expect(calls().map((c) => c.argv.slice(2))).toEqual([['tab', 'list', '--workspace', 'w7'], ['pane', 'list']]);
  });

  it('tabLabel answers the label of the tab a pane is in, and null for a pane no tab has (issue #2676)', async () => {
    process.env.FAKE_HERDR_PANE_LIST = '1';
    expect(await herdr().tabLabel('w7:p5')).toBe('local/lane-1 · abcd1234 · 1.1');
    expect(calls().map((c) => c.argv.slice(2))).toEqual([['pane', 'list'], ['tab', 'list', '--workspace', 'w7']]);
    expect(await herdr().tabLabel('w7:p404')).toBeNull();
  });

  it('findTab answers null for a label no tab has, and lists no pane', async () => {
    expect(await herdr().findTab({ workspaceId: 'w7', label: 'local/lane-1 · abcd1234 · 2.1' })).toBeNull();
    expect(calls()).toHaveLength(1);
  });

  it('createTab returns tab and root pane ids, the pane\'s terminal (issue #1465), and passes each env var as --env K=V', async () => {
    expect(await herdr().createTab({ workspaceId: 'w7', cwd: '/tmp/a', label: 'local/lane-1 · abcd1234', env: { HOPPER_JOB_ID: 'j1', HOPPER_REPO: 'o/r' } }))
      .toEqual({ tabId: 'w7:t3', paneId: 'w7:p5', terminalId: 'term_a1' });
    expect(calls()[0]!.argv.slice(2)).toEqual([
      'tab', 'create', '--workspace', 'w7', '--cwd', '/tmp/a', '--label', 'local/lane-1 · abcd1234',
      '--env', 'HOPPER_JOB_ID=j1', '--env', 'HOPPER_REPO=o/r', '--no-focus',
    ]);
  });

  it('startAgent passes claude args after -- and maps agent_not_ready', async () => {
    expect(await herdr().startAgent({ name: 'jh-a', paneId: 'w7:p5', args: ['--dangerously-skip-permissions', '--model', 'opus'], timeoutMs: 60000 }))
      .toEqual({ ok: true });
    expect(calls()[0]!.argv.slice(2)).toEqual(['agent', 'start', 'jh-a', '--kind', 'claude', '--pane', 'w7:p5', '--timeout', '60000', '--', '--dangerously-skip-permissions', '--model', 'opus']);
    expect(await herdr().startAgent({ name: 'jh-blocked', paneId: 'w7:p5', args: [], timeoutMs: 1000 })).toEqual({ ok: false, notReady: true });
  });

  it('startAgent maps agent_pane_busy (pane not at a shell yet) to paneBusy', async () => {
    expect(await herdr().startAgent({ name: 'jh-busy', paneId: 'w7:p5', args: [], timeoutMs: 1000 })).toEqual({ ok: false, paneBusy: true });
  });

  it('other errors become a typed HerdrError with code and message', async () => {
    const err = await herdr().startAgent({ name: 'jh-boom', paneId: 'w7:p404', args: [], timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err).toMatchObject({ code: 'pane_not_found', message: 'pane w7:p404 not found' });
  });

  it('getAgent maps status, state_change_seq and its pane\'s terminal (issue #1465), and null when the agent is gone', async () => {
    expect(await herdr().getAgent('jh-a')).toEqual({ status: 'idle', stateChangeSeq: 4, paneId: 'w7:p5', terminalId: 'term_a1' });
    expect(await herdr().getAgent('jh-gone')).toBeNull();
  });

  it('read returns the raw pane text', async () => {
    expect(await herdr().read('w7:p5', { source: 'recent-unwrapped', lines: 200 })).toBe('line one\n● HOPPER_DONE\n');
    expect(calls()[0]!.argv.slice(2)).toEqual(['pane', 'read', 'w7:p5', '--source', 'recent-unwrapped', '--lines', '200']);
  });

  it('runInPane types a shell command into the pane with pane run', async () => {
    await herdr().runInPane('w7:p5', "mkdir -p '/w/x'");
    expect(calls()[0]!.argv.slice(2)).toEqual(['pane', 'run', 'w7:p5', "mkdir -p '/w/x'"]);
  });

  it('waitOutput waits for a literal match in recent output: true when seen, false on herdr\'s timeout', async () => {
    expect(await herdr().waitOutput('w7:p5', 'hopper-scratch-ready', 1000)).toBe(true);
    expect(await herdr().waitOutput('w7:p5', 'never-printed', 1000)).toBe(false);
    expect(calls()[0]!.argv.slice(2)).toEqual(['pane', 'wait-output', 'w7:p5', '--match', 'hopper-scratch-ready', '--source', 'recent-unwrapped', '--timeout', '1000']);
  });

  it('prompt, sendKeys and closePane issue the documented commands', async () => {
    const h = herdr();
    await h.prompt('jh-a', 'line 1\nline 2');
    await h.sendKeys('w7:p5', ['esc', 'ctrl+c']);
    await h.closePane('w7:p5');
    expect(calls().map((c) => c.argv.slice(2))).toEqual([
      ['agent', 'prompt', 'jh-a', 'line 1\nline 2'],
      ['pane', 'send-keys', 'w7:p5', 'esc', 'ctrl+c'],
      ['pane', 'close', 'w7:p5'],
    ]);
  });

  it('closePane on a missing pane is a pane_not_found error', async () => {
    await expect(herdr().closePane('w7:p404')).rejects.toMatchObject({ code: 'pane_not_found' });
  });

  it('times out a call that hangs', async () => {
    const h = createHerdrCliClient({ bin: BIN, session: 'jh-test-x', timeoutMs: SLOW_MS });
    // run() is the adapter's raw runner; every typed method goes through it.
    const err = await h.run(['slow']).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'timeout' });
  });

  it('asks a read again when herdr answers it too late (issue #1857): a busy server answers the next one', async () => {
    const h = createHerdrCliClient({ bin: BIN, session: 'jh-test-x', timeoutMs: SLOW_MS });
    expect(await h.getAgent('jh-slow-once')).toMatchObject({ status: 'idle', stateChangeSeq: 4 });
    expect(calls().map((c) => c.argv.slice(2))).toEqual([['agent', 'get', 'jh-slow-once'], ['agent', 'get', 'jh-slow-once']]);
  });

  it('a read that times out 3 times in a row is a timeout (issue #1857)', async () => {
    const h = createHerdrCliClient({ bin: BIN, session: 'jh-test-x', timeoutMs: SLOW_MS });
    await expect(h.getAgent('jh-slow')).rejects.toMatchObject({ code: 'timeout' });
    expect(calls()).toHaveLength(3);
  });

  it('never sends a prompt again on a timeout: it may have reached Claude (issue #1857)', async () => {
    const h = createHerdrCliClient({ bin: BIN, session: 'jh-test-x', timeoutMs: SLOW_MS });
    await expect(h.prompt('jh-slow', 'go')).rejects.toMatchObject({ code: 'timeout' });
    expect(calls()).toHaveLength(1);
  });

  it('a usage error (exit 2) becomes code usage', async () => {
    await expect(herdr().run(['usage'])).rejects.toMatchObject({ code: 'usage' });
  });

  it('a missing binary becomes code spawn', async () => {
    await expect(createHerdrCliClient({ bin: join(dir, 'nope'), session: 's' }).getAgent('a')).rejects.toMatchObject({ code: 'spawn' });
  });
});
