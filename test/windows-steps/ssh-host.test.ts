// Issue #731: the Windows host a step runs on, reached as an ssh target is — the hopper's key only, the host's pinned
// key only, nothing forwarded — with fake ssh and scp binaries that record what the hopper sends.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WindowsHost } from '../../src/domain/windows-steps.ts';
import { createSshStepHost } from '../../src/windows-steps/index.ts';

const FAKE = fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url));
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const HOST: WindowsHost = { name: 'build-host', ssh: 'builder@winbox', hostKey: KEY, workDir: 'C:\\work\\app' };

let dir: string;
const calls = () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; args: string[] }).filter((c) => c.args[0] !== '-G');
const scripts = () => readFileSync(join(dir, 'scripts.txt'), 'utf8').split('\n----\n').filter(Boolean);

function host() {
  const ssh = join(dir, 'ssh'); const scp = join(dir, 'scp');
  symlinkSync(FAKE, ssh); symlinkSync(FAKE, scp);
  chmodSync(FAKE, 0o755);
  const key = join(dir, 'id'); writeFileSync(key, 'key', { mode: 0o600 });
  return createSshStepHost({ auth: () => ({ identityFile: key, knownHostsFile: join(dir, 'targets_known_hosts') }), sshDir: join(dir, 'sshdir'), sshBin: ssh, scpBin: scp });
}

function stepDir(inputs: boolean): string {
  const d = join(dir, 'step');
  mkdirSync(d);
  if (inputs) writeFileSync(join(d, 'inputs.tar'), 'the inputs tar');
  return d;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'win-step-')); process.env.FAKE_WIN_DIR = dir; delete process.env.FAKE_WIN_EXIT; delete process.env.FAKE_WIN_HANG; delete process.env.FAKE_WIN_CUT; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.FAKE_WIN_DIR; });

describe('the Windows step host over ssh', () => {
  it('prepares, copies the inputs and the step, runs it streaming its output, brings the outputs back, then cleans up', async () => {
    const d = stepDir(true);
    process.env.FAKE_WIN_EXIT = '3';
    const log: string[] = [];
    const r = await host().run(HOST, { id: 's1', command: 'msbuild App.sln', dir: d, inputs: true, outputs: ['bin\\Release'] }, { log: (c) => log.push(c), signal: new AbortController().signal });
    expect(r).toEqual({ exit: 3, outputsBytes: 'the outputs tar'.length });
    expect(log.join('')).toContain('building App.sln\n');
    expect(log.join('')).toContain('warning CS0168\n');
    const c = calls();
    expect(c.map((x) => x.tool)).toEqual(['ssh', 'scp', 'ssh', 'scp', 'ssh']);
    // Every call: the hardened options, the host's own pin, the hopper's key, nothing forwarded.
    for (const x of c) {
      expect(x.args).toEqual(expect.arrayContaining(['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'HostKeyAlias=builder@winbox', '-i', join(dir, 'id')]));
      expect(x.args).toContain(`UserKnownHostsFile=${join(dir, 'sshdir', 'windows', 'build-host.known_hosts')}`);
    }
    expect(readFileSync(join(dir, 'sshdir', 'windows', 'build-host.known_hosts'), 'utf8')).toBe(`builder@winbox ${KEY}\n`);
    expect(c[0]!.args.slice(-7, -1)).toEqual(['-p', '2222', '-l', 'builder', '--', 'winbox']);
    expect(c[1]!.args.slice(-3)).toEqual([join(d, 'inputs.tar'), join(d, 'step.ps1'), 'builder@winbox:C:/work/app/.hopper-step/']);
    expect(c[1]!.args).toEqual(expect.arrayContaining(['-P', '2222']));
    expect(c[3]!.args.slice(-2)).toEqual(['builder@winbox:C:/work/app/.hopper-step/outputs.tar', join(d, 'outputs.tar')]);
    expect(readFileSync(join(d, 'outputs.tar'), 'utf8')).toBe('the outputs tar');
    // The step's script: UTF-8 with a byte order mark, the job's command in it.
    const ps1 = readFileSync(join(dir, 'host', 'C', 'work', 'app', '.hopper-step', 'step.ps1'), 'utf8');
    expect(ps1.charCodeAt(0)).toBe(0xfeff);
    expect(ps1).toContain('msbuild App.sln');
    const [prepare, run, cleanup] = scripts();
    expect(prepare).toContain('New-Item -ItemType Directory');
    expect(run).toContain("tar -xf 'C:\\work\\app\\.hopper-step\\inputs.tar'");
    expect(cleanup).toContain('Remove-Item');
  });

  it('gives the step its secrets on the run call\'s stdin only: never in an argument, a copied file or another call', async () => {
    const d = stepDir(false);
    const r = await host().run(HOST, { id: 's5', command: 'nuget push', dir: d, inputs: false, outputs: [], secrets: { NUGET_TOKEN: 'never-in-argv' } }, { log: () => undefined, signal: new AbortController().signal });
    expect(r).toEqual({ exit: 0 });
    expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe(`NUGET_TOKEN=${Buffer.from('never-in-argv').toString('base64')}\n`);
    const encoded = Buffer.from('never-in-argv').toString('base64');
    for (const c of calls()) for (const a of c.args) {
      const decoded = a.startsWith('powershell ') ? Buffer.from(a.split(' ').at(-1)!, 'base64').toString('utf16le') : a;
      expect(decoded).not.toContain('never-in-argv');
      expect(decoded).not.toContain(encoded);
    }
    expect(readFileSync(join(dir, 'host', 'C', 'work', 'app', '.hopper-step', 'step.ps1'), 'utf8')).not.toContain('never-in-argv');
    expect(scripts()[1]).toContain('[Console]::In.ReadToEnd()');
  });

  it('copies no inputs when there are none, and says so when the outputs do not come back', async () => {
    const d = stepDir(false);
    const r = await host().run(HOST, { id: 's2', command: 'dir', dir: d, inputs: false, outputs: [] }, { log: () => undefined, signal: new AbortController().signal });
    expect(r).toEqual({ exit: 0 });
    expect(calls()[1]!.args.slice(-2)).toEqual([join(d, 'step.ps1'), 'builder@winbox:C:/work/app/.hopper-step/']);
    expect(scripts()[1]).not.toContain('tar -xf');
  });

  it('says the outputs came back cut short when the copy is smaller than the archive the host packed (issue #1255)', async () => {
    const d = stepDir(false);
    process.env.FAKE_WIN_CUT = '5';
    const r = await host().run(HOST, { id: 's6', command: 'msbuild App.sln', dir: d, inputs: false, outputs: ['bin'] }, { log: () => undefined, signal: new AbortController().signal });
    expect(r).toEqual({ exit: 0, problem: 'the outputs came back cut short: 5 of 15 bytes' });
  });

  it('stops the step when it is aborted, and still cleans up', async () => {
    const d = stepDir(false);
    process.env.FAKE_WIN_HANG = '1';
    const stop = new AbortController();
    const log: string[] = [];
    const running = host().run(HOST, { id: 's3', command: 'sleep', dir: d, inputs: false, outputs: [] }, { log: (c) => { log.push(c); stop.abort(); }, signal: stop.signal });
    const r = await running;
    expect(r.problem).toBe('stopped before it ended');
    expect(calls().map((x) => x.tool).at(-1)).toBe('ssh');
    expect(scripts().at(-1)).toContain('Remove-Item');
  });

  it('says why when the host cannot be prepared', async () => {
    const d = stepDir(false);
    const r = await host().run({ ...HOST, ssh: 'not a target' }, { id: 's4', command: 'dir', dir: d, inputs: false, outputs: [] }, { log: () => undefined, signal: new AbortController().signal });
    expect(r.exit).toBe(255);
    expect(r.problem).toContain('bad ssh target');
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false);
  });
});
