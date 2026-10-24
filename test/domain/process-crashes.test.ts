// Core dumps and OOM kills of a job's processes (issue #2722 part 3): what the job records of each, and its failed part.
import { describe, expect, it } from 'vitest';
import { coreDumpedOf, crashCommandOf, oomKilledOf, processCrashes, signalName } from '../../src/domain/process-crashes.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

describe('the command of a core dump, for a person (issue #2722 part 3)', () => {
  it('from the journal\'s command line: the script node ran, each path by its file\'s name, shell quotes read', () => {
    expect(crashCommandOf('node /home/x/w/node_modules/.bin/tsc --noEmit -p .')).toBe('tsc --noEmit -p .');
    expect(crashCommandOf("$'npm exec tsc --noEmit -p .'")).toBe('npm exec tsc --noEmit -p .');
    expect(crashCommandOf("/usr/bin/cc1plus -O2 'my file.cpp'")).toBe('cc1plus -O2 my file.cpp');
    expect(crashCommandOf(undefined)).toBe('a process');
    expect(crashCommandOf('')).toBe('a process');
  });

  it('a signal by its name', () => {
    expect(signalName(11)).toBe('SIGSEGV');
    expect(signalName(6)).toBe('SIGABRT');
    expect(signalName(99)).toBe('signal 99');
    expect(signalName(undefined)).toBe('a signal');
  });
});

describe('what the job records (issue #2722 part 3)', () => {
  it('job.core_dumped: the command, the signal and when', () => {
    expect(coreDumpedOf({ pid: 41, signal: 11, commandLine: '/usr/bin/cc1plus -O2 big.cpp', dumpedAtMs: Date.parse('2026-10-24T10:41:00.000Z') }))
      .toEqual({ command: 'cc1plus -O2 big.cpp', signal: 'SIGSEGV', dumpedAt: '2026-10-24T10:41:00.000Z' });
    expect(coreDumpedOf({})).toEqual({ command: 'a process', signal: 'a signal' });
  });

  it('job.oom_killed: the process\'s name and when', () => {
    expect(oomKilledOf({ pid: 3001, task: 'tsc', killedAtMs: Date.parse('2026-10-24T10:41:00.000Z') })).toEqual({ command: 'tsc', killedAt: '2026-10-24T10:41:00.000Z' });
    expect(oomKilledOf({})).toEqual({ command: 'a process' });
  });
});

describe('a failed part for each (issue #2722 part 3)', () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): DomainEvent =>
    ({ seq, type, jobId: 'j1', machineId: 'm1', at: '2026-10-24T11:00:00.000Z', data }) as DomainEvent;

  it('under machines: what crashed or was killed, how, and on which machine', () => {
    expect(processCrashes([
      event('job.core_dumped', { command: 'cc1plus -O2 big.cpp', signal: 'SIGSEGV', dumpedAt: '2026-10-24T10:41:00.000Z' }, 4),
      event('job.oom_killed', { command: 'tsc' }, 5),
      event('job.heap_aborted', { command: 'tsc' }, 6),
    ])).toEqual([
      { id: 'core-dump:4', group: 'machines', kind: 'core_dump', label: 'cc1plus crashed (SIGSEGV)', status: 'failed', at: '2026-10-24T10:41:00.000Z', detail: 'cc1plus -O2 big.cpp: core dumped, on m1', href: '#machines' },
      { id: 'oom-kill:5', group: 'machines', kind: 'oom_kill', label: 'tsc was killed: out of memory', status: 'failed', at: '2026-10-24T11:00:00.000Z', detail: 'tsc: the kernel\'s OOM killer ended it, on m1', href: '#machines' },
    ]);
    expect(processCrashes([])).toEqual([]);
  });
});
