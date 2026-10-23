// Issue #2504 part 9: a job's processes and its labelled containers as ledger entries — recorded by the reconciler when the
// survey finds them for an ended job, closed by a reap, and closed gone once the survey no longer finds them; part 11 the
// agent session. Pure.
import { describe, expect, it } from 'vitest';
import { JOB_LABEL } from '../../src/client/job-runtime.ts';
import { agentSessionEntryOf, containersLocatorOf, goneClosures, ledgerRootsOf, processesLocatorOf, reapClosures, retainedEntriesOf, unledgeredEntriesOf, type LedgerEntry } from '../../src/domain/resource-ledger.ts';

const AT = '2026-10-22T10:00:00.000Z';
const PROCS = 'HOPPER_JOB_ID=j1', CONTAINERS = 'hopper.job=j1';

const entry = (kind: LedgerEntry['kind'], locator: string, over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ jobId: 'j1', machineId: 'm1', kind, locator, createdAt: AT, state: 'live', ...over });

describe('the locators of a job\'s processes and containers', () => {
  it('name the variable the reap finds processes by, and the label the reap finds containers and volumes by', () => {
    expect(processesLocatorOf('j1')).toBe(PROCS);
    expect(containersLocatorOf('j1')).toBe(`${JOB_LABEL}=j1`);
  });
});

describe('reapClosures with processes and containers', () => {
  const both = [entry('job_processes', PROCS), entry('job_containers', CONTAINERS)];

  it('reaps both after a reap that looked at the scratch dir, also with work kept', () => {
    expect(reapClosures(both, { kept: [] }).map((c) => [c.entry.kind, c.state])).toEqual([['job_processes', 'reaped'], ['job_containers', 'reaped']]);
    expect(reapClosures(both, { kept: ['/w/.worktrees/app/j1'] }).map((c) => c.state)).toEqual(['reaped', 'reaped']);
  });

  it('reaps the processes, as the scope, after a reap that did not look at the scratch dir; the containers wait for the survey', () => {
    expect(reapClosures(both, { kept: [] }, false).map((c) => [c.entry.kind, c.state])).toEqual([['job_processes', 'reaped']]);
  });

  it('leaves the processes out of what a retention keeps, as the scope', () => {
    expect(retainedEntriesOf(both).map((e) => e.kind)).toEqual(['job_containers']);
  });
});

describe('goneClosures with processes and containers', () => {
  const ended = (id: string) => (id === 'j1' ? { status: 'finished' as const } : undefined);
  const both = [entry('job_processes', PROCS), entry('job_containers', CONTAINERS)];

  it('reaps them once the survey finds no process and no container of the job', () => {
    expect(goneClosures(both, { scopes: [], processes: [], scratch: [], containers: [] }, 'm1', ended).map((c) => [c.entry.kind, c.reason]))
      .toEqual([['job_processes', 'not found on the machine'], ['job_containers', 'not found on the machine']]);
  });

  it('keeps them while the survey finds them, and the containers when the survey does not list containers', () => {
    expect(goneClosures(both, { scopes: [], processes: ['j1'], scratch: [], containers: ['j1'] }, 'm1', ended)).toEqual([]);
    expect(goneClosures(both, { scopes: [], processes: ['j1'], scratch: [] }, 'm1', ended)).toEqual([]);
  });
});

describe('unledgeredEntriesOf with processes and containers', () => {
  const jobs: Record<string, { id: string; status: 'finished' | 'running' }> = { j1: { id: 'j1', status: 'finished' }, live: { id: 'live', status: 'running' } };
  const found = { scopes: [], processes: ['j1', 'live', 'other'], scratch: [], containers: ['j1', 'live', 'other'] };
  const of = (ledgered: string[] = []) => unledgeredEntriesOf(found, new Set(ledgered), (id) => jobs[id] as never, 'm1', undefined, Date.parse(AT));

  it("records an ended job's processes and containers the survey found; not a live job's, nor a job the store does not know", () => {
    expect(of()).toEqual([
      { jobId: 'j1', machineId: 'm1', kind: 'job_processes', locator: PROCS, createdAt: AT },
      { jobId: 'j1', machineId: 'm1', kind: 'job_containers', locator: CONTAINERS, createdAt: AT },
    ]);
    expect(of([`j1\0job_processes\0${PROCS}`, `j1\0job_containers\0${CONTAINERS}`])).toEqual([]);
  });

  it('gives them no work tree to survey', () => {
    expect(ledgerRootsOf([entry('job_processes', PROCS), entry('job_containers', CONTAINERS)], 'm1')).toEqual([]);
  });
});

// Part 11: the agent session the job's agent runs in, as an entry — recorded when the executor says the agent is up, stopped
// by every reap with the job's processes, and closed gone once the survey finds neither a process nor a scope of the job.
describe('the agent session as an entry (part 11)', () => {
  const ended = (id: string) => (id === 'j1' ? { status: 'finished' as const } : undefined);
  const session = entry('agent_session', 's-1');

  it('is the entry the executor reports, on its machine', () => {
    expect(agentSessionEntryOf('j1', 'm1', 's-1', AT)).toEqual({ jobId: 'j1', machineId: 'm1', kind: 'agent_session', locator: 's-1', createdAt: AT });
  });

  it('is reaped by every reap, also one that did not look at the scratch dir, and a retention does not keep it', () => {
    expect(reapClosures([session], { kept: ['/w/.worktrees/app/j1'] }).map((c) => c.state)).toEqual(['reaped']);
    expect(reapClosures([session], { kept: [] }, false).map((c) => c.state)).toEqual(['reaped']);
    expect(retainedEntriesOf([session])).toEqual([]);
  });

  it('is gone once the survey finds no process and no scope of the job, and has no work tree', () => {
    expect(goneClosures([session], { scopes: [], processes: [], scratch: [] }, 'm1', ended).map((c) => c.reason)).toEqual(['not found on the machine']);
    expect(goneClosures([session], { scopes: ['j1'], processes: [], scratch: [] }, 'm1', ended)).toEqual([]);
    expect(goneClosures([session], { scopes: [], processes: ['j1'], scratch: [] }, 'm1', ended)).toEqual([]);
    expect(ledgerRootsOf([session], 'm1')).toEqual([]);
  });

  it('is not recorded by the reconciler: the survey lists no agent session', () => {
    expect(unledgeredEntriesOf({ scopes: [], processes: [], scratch: [] }, new Set(), () => ({ id: 'j1', status: 'finished' }) as never, 'm1', undefined, Date.parse(AT))).toEqual([]);
  });
});
