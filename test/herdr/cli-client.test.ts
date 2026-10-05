import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HerdrError, createHerdrCliClient } from '../../src/executors/herdr/index.ts';

const BIN = fileURLToPath(new URL('./fake-herdr-bin.mjs', import.meta.url));
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

  it('createTab returns tab and root pane ids and passes each env var as --env K=V', async () => {
    expect(await herdr().createTab({ workspaceId: 'w7', cwd: '/tmp/a', label: 'local/lane-1 · abcd1234', env: { HOPPER_JOB_ID: 'j1', HOPPER_REPO: 'o/r' } }))
      .toEqual({ tabId: 'w7:t3', paneId: 'w7:p5' });
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

  it('getAgent maps status and state_change_seq, and null when the agent is gone', async () => {
    expect(await herdr().getAgent('jh-a')).toEqual({ status: 'idle', stateChangeSeq: 4, paneId: 'w7:p5' });
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
    const h = createHerdrCliClient({ bin: BIN, session: 'jh-test-x', timeoutMs: 200 });
    // run() is the adapter's raw runner; every typed method goes through it.
    const err = await h.run(['slow']).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'timeout' });
  });

  it('a usage error (exit 2) becomes code usage', async () => {
    await expect(herdr().run(['usage'])).rejects.toMatchObject({ code: 'usage' });
  });

  it('a missing binary becomes code spawn', async () => {
    await expect(createHerdrCliClient({ bin: join(dir, 'nope'), session: 's' }).getAgent('a')).rejects.toMatchObject({ code: 'spawn' });
  });
});
