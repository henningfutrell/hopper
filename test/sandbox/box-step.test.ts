// Issue #1004: one box step — a seat job's command run in the sandbox box the hopper started for it, through the
// container runtime's exec, never through a pane. The runtime is the double at its port (test/support/fake-container-runtime.ts):
// each command runs on this machine, with a directory of its own as the box's HOME.
//
// Feature: a step runs in the box
//   Scenario: the command runs in the box's work dir, with the job's token file and the vault's helper; its log streams
//     back as it comes, and the step's exit code is the result; nothing of the step stays in the box
//   Scenario: the inputs land in the work dir before the command runs, and the outputs come back as a tar
//   Scenario: an output that is not there is said in the log, and the others still come back
//   Scenario: a stop kills the command in the box, and the box's scratch still goes
//   Scenario: a runtime that runs no command in a box (a box on another machine) is a problem, not a crash
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBoxStep } from '../../src/sandbox/box-step.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

const ID = '6f1c2a34-0b5e-4d7a-9c11-2e3f4a5b6c7d';
const TOKEN = 'dXNlcg.job-1.mac';

/** A running box, its runtime, and the step's own directory on the hopper's side. */
function box(): { rt: FakeContainerRuntime; container: string; dir: string; home: () => string } {
  const rt = createFakeContainerRuntime();
  const container = rt.put({ name: 'hopper-sandbox-asked-1', image: 'box', network: 'n', volume: 'v', labels: {}, env: {}, user: 'agent', limits: { cpus: 1, memoryMb: 512 } });
  const dir = temp('box-step-');
  return { rt, container, dir, home: () => { const h = rt.homes.get('hopper-sandbox-asked-1')!; dirs.push(h); return h; } };
}

const run = (b: ReturnType<typeof box>, step: Partial<Parameters<typeof runBoxStep>[2]>, signal = new AbortController().signal) => {
  let log = '';
  const result = runBoxStep(b.rt, b.container, { id: ID, command: 'true', dir: b.dir, inputs: false, outputs: [], token: TOKEN, ...step }, { log: (c) => { log += c; }, signal });
  return { result, log: () => log };
};

describe('a box step (issue #1004)', () => {
  it('runs the command in the box\'s work dir, with the job\'s token file and the vault\'s helper; streams its log; answers its exit code', async () => {
    const b = box();
    const r = run(b, { command: 'pwd; cat "$HOPPER_TOKEN_FILE"; echo "helper=$HOPPER_SECRET"; echo oops >&2; exit 3', helper: '/home/agent/.hopper/hopper-secret' });
    expect(await r.result).toEqual({ exit: 3 });
    const home = b.home();
    expect(r.log()).toBe(`${join(home, 'work')}\n${TOKEN}\nhelper=/home/agent/.hopper/hopper-secret\noops\n`);
    // Nothing of the step stays in the box: no scratch, no token.
    expect(readdirSync(join(home, '.hopper-step'))).toEqual([]);
    // The token never travels as an argument or in the command's environment: only its file's path does.
    for (const e of b.rt.execs) {
      expect(e.cmd.join(' ')).not.toContain(TOKEN);
      expect(Object.values(e.env).join(' ')).not.toContain(TOKEN);
    }
    expect(b.rt.execs.find((e) => e.env.HOPPER_TOKEN_FILE)?.env).toEqual({ HOPPER_TOKEN_FILE: join(home, '.hopper-step', ID, 'token'), HOPPER_SECRET: '/home/agent/.hopper/hopper-secret' });
  });

  it('puts the inputs in the work dir before the command runs, and brings the outputs back as a tar', async () => {
    const b = box();
    const src = temp('inputs-');
    mkdirSync(join(src, 'plan'));
    writeFileSync(join(src, 'plan', 'main.tf'), 'resource "x" "y" {}\n');
    execFileSync('tar', ['-cf', join(b.dir, 'inputs.tar'), '-C', src, 'plan']);
    const r = run(b, { command: 'mkdir -p out && wc -l < plan/main.tf > out/lines.txt', inputs: true, outputs: ['out'] });
    const result = await r.result;
    expect(result.exit).toBe(0);
    expect(result.outputsBytes).toBeGreaterThan(0);
    const back = temp('outputs-');
    execFileSync('tar', ['-xf', join(b.dir, 'outputs.tar'), '-C', back]);
    expect(readFileSync(join(back, 'out', 'lines.txt'), 'utf8').trim()).toBe('1');
    // The inputs stay in the work dir: that is where the work runs.
    expect(existsSync(join(b.home(), 'work', 'plan', 'main.tf'))).toBe(true);
  });

  it('says an output that is not there, and still brings back the others', async () => {
    const b = box();
    const r = run(b, { command: 'echo yes > here.txt', outputs: ['here.txt', 'gone.txt'] });
    const result = await r.result;
    expect(result.exit).toBe(0);
    expect(result.outputsBytes).toBeGreaterThan(0);
    expect(r.log()).toContain('gone.txt');
    expect(execFileSync('tar', ['-tf', join(b.dir, 'outputs.tar')], { encoding: 'utf8' }).trim()).toBe('here.txt');
  });

  it('a stop kills the command in the box, and the box\'s scratch still goes', async () => {
    const b = box();
    const stop = new AbortController();
    const r = run(b, { command: 'echo started; sleep 37; echo never' }, stop.signal);
    const until = Date.now() + 10000;
    while (!r.log().includes('started') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    const result = await r.result;
    expect(result).toMatchObject({ problem: 'stopped before it ended' });
    expect(r.log()).not.toContain('never');
    expect(readdirSync(join(b.home(), '.hopper-step'))).toEqual([]);
    // The command was killed in the box, not left to run.
    const ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    expect(ps).not.toMatch(/^sleep 37$/m);
  });

  it('a runtime that runs no command in a box is a problem, not a crash', async () => {
    const b = box();
    const { exec: _exec, copyIn: _copyIn, ...none } = b.rt;
    const result = await runBoxStep(none, b.container, { id: ID, command: 'true', dir: b.dir, inputs: false, outputs: [], token: TOKEN }, { log: () => undefined, signal: new AbortController().signal });
    expect(result.exit).toBe(255);
    expect(result.problem).toMatch(/runs no command in a box/);
  });
});
