// Issue #542: the blast-radius gate. A gated machine takes no job by ordinary placement: a job goes to another
// machine, or is held at the gate saying which machine and why. A job passes by a rule (a label, a repo, a priority)
// or because a person let it through; a job resuming returns to its pane.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { BlastRadiusInput, Job } from '../../src/domain/types.ts';
import { inputs, job, machine } from './support.ts';

const gate = (gated: string[], pass: Partial<BlastRadiusInput['pass']> = {}): BlastRadiusInput => ({
  gated: gated.map((machineId) => ({ machineId, reason: 'rated high' })), pass: { labels: [], repos: [], ...pass },
});
const fromIssue = (id: string, labels: string[], repo = 'org/app', over: Partial<Job> = {}): Job =>
  job(id, { source: { source: 'github', kind: 'github', key: `k-${id}`, repo, labels }, ...over });
const safe = machine({ id: 'safe', label: 'safe' });
const wide = machine({ id: 'wide', label: 'wide' });

describe('the blast-radius gate', () => {
  it('a job goes to the machine that is not gated', () => {
    const d = decide(inputs({ machines: [wide, safe], waiting: [job('a'), job('b')], blastRadius: gate(['wide']) }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['safe', 'safe']);
    expect(d.lanes.find((l) => l.machineId === 'wide')!.idle).toBe('gated by blast radius: rated high; only jobs let through the gate run here');
  });

  it('with every machine it may run on gated, the job is held at the gate, naming them', () => {
    const d = decide(inputs({ machines: [wide], waiting: [job('a')], blastRadius: gate(['wide']) }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'a', reason: 'held at the blast-radius gate: wide is rated high; only a job let through the gate runs there' }]);
  });

  it('a job pinned to a gated machine is held at the gate', () => {
    const d = decide(inputs({ machines: [wide, safe], waiting: [job('a', { machineId: 'wide' })], blastRadius: gate(['wide']) }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'a', reason: expect.stringMatching(/^held at the blast-radius gate: wide/) }]);
  });

  it('a job let through by a person runs there', () => {
    const d = decide(inputs({ machines: [wide], waiting: [job('a', { gatePass: { at: '2026-10-09T10:00:00.000Z' } })], blastRadius: gate(['wide']) }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'wide' })]);
  });

  it('a job passes by label, by repo, or by priority — when the rules name them', () => {
    const waiting = [fromIssue('l', ['hopper', 'hopper:actor']), fromIssue('r', ['hopper'], 'org/infra'), fromIssue('p', ['hopper'], 'org/app', { priority: 90 }), fromIssue('n', ['hopper'])];
    const d = decide(inputs({ machines: [wide], waiting, blastRadius: gate(['wide'], { labels: ['hopper:actor'], repos: ['org/infra'], minPriority: 80 }) }), 'd1');
    expect(d.start.map((s) => s.jobId).sort()).toEqual(['l', 'p', 'r']);
    expect(d.hold.map((h) => h.jobId)).toEqual(['n']);
  });

  it('a job resuming returns to its pane on a gated machine', () => {
    const resuming = job('a', { pendingAnswer: 'yes', resumeOn: 'wide' });
    const d = decide(inputs({ machines: [wide], waiting: [resuming], blastRadius: gate(['wide']) }), 'd1');
    expect(d.start).toEqual([expect.objectContaining({ jobId: 'a', machineId: 'wide' })]);
  });

  it('a gated machine that is the only usable one beside a full disk: the gate is what holds', () => {
    const full = machine({ id: 'full', label: 'full', disk: { freeBytes: 1, totalBytes: 100, low: true } });
    const d = decide(inputs({ machines: [wide, full], waiting: [job('a')], blastRadius: gate(['wide']) }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'a', reason: expect.stringMatching(/^held at the blast-radius gate: wide/) }]);
  });

  it('no gate input: as before', () => {
    const d = decide(inputs({ machines: [wide], waiting: [job('a')] }), 'd1');
    expect(d.start).toHaveLength(1);
  });
});
