// Core dumps and OOM kills of a job's processes (issue #2722 part 3): the reap reads, from the journal, the core dumps
// systemd-coredump took in the job's scope and the kernel's OOM kills in it, before it stops the scope, and says each.
// Run for real with a stand-in systemctl, journalctl and cgroup tree: a test machine may have no systemd (a container, CI).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv, scopeUnitOf } from '../../src/client/reap.ts';

const JOB = 'job-2722-crash01';
const UNIT = `${scopeUnitOf(JOB)}.scope`;
const SCOPE = `/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`;

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'reap-crashes-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const core = (pid: number, signal: number, cmdline: string, us: number): string =>
  JSON.stringify({ __CURSOR: 's=1', __REALTIME_TIMESTAMP: String(us + 900000), COREDUMP_PID: String(pid), COREDUMP_SIGNAL: String(signal), COREDUMP_CMDLINE: cmdline, COREDUMP_TIMESTAMP: String(us) });

/**
 * A bin dir with a systemctl that names the scope's cgroup, and a journalctl that answers `cores` to a core dump query of
 * the scope's unit and `kernel` to a kernel query that greps for the scope; each call's arguments go to `journalctl.args`.
 */
function bin(o: { cores?: string[]; kernel?: string[] }): string {
  const dir = join(root, 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\ncase "$*" in *ControlGroup*) printf '%s\\n' '${SCOPE}';; esac\nexit 0\n`);
  writeFileSync(join(dir, 'cores.txt'), (o.cores ?? []).map((l) => `${l}\n`).join(''));
  writeFileSync(join(dir, 'kernel.txt'), (o.kernel ?? []).map((l) => `${l}\n`).join(''));
  writeFileSync(join(dir, 'journalctl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${join(dir, 'journalctl.args')}'`,
    `case "$*" in *" -k "*"hopper-job-${JOB}"*) cat '${join(dir, 'kernel.txt')}';; *"COREDUMP_USER_UNIT=${UNIT}"*) cat '${join(dir, 'cores.txt')}';; esac`,
    'exit 0', '',
  ].join('\n'));
  for (const f of ['systemctl', 'journalctl']) chmodSync(join(dir, f), 0o755);
  return dir;
}

function cgroup(oomKills: number): string {
  const top = join(root, 'cgroup');
  mkdirSync(join(top, SCOPE), { recursive: true });
  writeFileSync(join(top, SCOPE, 'memory.events'), `oom 1\noom_kill ${oomKills}\n`);
  return top;
}

function reap(dir: string, top: string, scratch = ''): string {
  const [file, ...args] = reapArgv(JOB, scratch, scratch !== '');
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOPPER_CGROUP_ROOT: top } });
}

const OOM_LINE = (task: string, pid: number) =>
  `1792860571.326723 box kernel: oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=${SCOPE},task_memcg=${SCOPE},task=${task},pid=${pid},uid=1000`;

describe('the reap says the core dumps in the job\'s scope (issue #2722 part 3)', () => {
  it('each with its pid, signal, command line and time, from the journal entries of the scope\'s unit', () => {
    const dir = bin({ cores: [core(41, 11, 'cc1plus -O2 big.cpp', 1792860571000000), core(42, 6, "node /w/node_modules/.bin/tsc --noEmit", 1792860572000000)] });
    expect(readReap(reap(dir, cgroup(0)))?.cores).toEqual([
      { pid: 41, signal: 11, commandLine: 'cc1plus -O2 big.cpp', dumpedAtMs: 1792860571000 },
      { pid: 42, signal: 6, commandLine: 'node /w/node_modules/.bin/tsc --noEmit', dumpedAtMs: 1792860572000 },
    ]);
    const args = readFileSync(join(dir, 'journalctl.args'), 'utf8');
    expect(args).toContain('MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1');
    // No OOM kills in the scope: the kernel log is not read.
    expect(args).not.toContain(' -k ');
  });

  it('none when there are none, and an entry it cannot read is left out', () => {
    expect(readReap(reap(bin({}), cgroup(0)))?.cores).toBeUndefined();
    const dir = bin({ cores: ['{"COREDUMP_PID":"7","COREDUMP_SIGNAL":"11","COREDUMP_CMDLINE":[1,2', core(8, 7, 'x', 1792860571000000)] });
    expect(readReap(reap(dir, cgroup(0)))?.cores).toEqual([{ pid: 8, signal: 7, commandLine: 'x', dumpedAtMs: 1792860571000 }]);
  });
});

describe('a core dump of a heap abort is the heap abort\'s (issue #2722 part 3)', () => {
  it('not said again: neither the core of the process whose report says it, nor its parent\'s that raised its signal again within 10 s', () => {
    const scratch = join(root, 'w', '.worktrees', '@scratch', JOB);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'report.20261024.42.0.001.json'), '{"header":{"event":"Allocation failed - JavaScript heap out of memory","trigger":"OOMError","dumpEventTimeStamp":"1792860571000","processId":42,"commandLine":["node","tsc"],"nodejsVersion":"v26.8.2"}}');
    const t = 1792860571000000;
    const dir = bin({ cores: [core(42, 6, 'node tsc', t), core(40, 6, "$'npm exec tsc'", t + 500000), core(39, 6, 'later', t + 60000000), core(41, 11, 'cc1plus', t)] });
    const said = readReap(reap(dir, cgroup(0), scratch));
    expect(said?.heap).toHaveLength(1);
    expect(said?.cores?.map((c) => c.pid)).toEqual([39, 41]);
  });
});

describe('the reap says the OOM kills in the job\'s scope (issue #2722 part 3)', () => {
  it('each killed process\'s name, pid and time, from the kernel log, when the scope counted OOM kills', () => {
    const dir = bin({ kernel: [OOM_LINE('tsc', 3001), OOM_LINE('npm exec tsc --', 3000)] });
    const said = readReap(reap(dir, cgroup(2)));
    expect(said?.oomKilled).toEqual([{ pid: 3001, task: 'tsc', killedAtMs: 1792860571326 }, { pid: 3000, task: 'npm exec tsc --', killedAtMs: 1792860571326 }]);
    expect(said?.used?.oomKills).toBe(2);
  });

  it('nothing from a kernel log that names no process, or that the reap cannot read', () => {
    expect(readReap(reap(bin({ kernel: ['1792860571.1 box kernel: Memory cgroup out of memory: Killed process 3001 (tsc)'] }), cgroup(1)))?.oomKilled).toBeUndefined();
    expect(readReap(reap(bin({}), cgroup(1)))?.oomKilled).toBeUndefined();
  });
});
