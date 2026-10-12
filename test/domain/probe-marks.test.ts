// A person's marks on the read probes of a template's read-only check (issue #916): which marks a template can keep, and
// how the marks change what the check runs. Pure.
import { describe, expect, it } from 'vitest';
import { markRuns, probeMarksProblem, PROBE_MARKS_MAX, type ProbeRun } from '../../src/domain/read-only-check.ts';
import { HOPPER_PROBES, PROBES } from '../../src/sandbox/probes.ts';

describe('probe marks (issue #916)', () => {
  it('a read probe takes expect-denied or skip', () => {
    expect(probeMarksProblem({ 'helm.list': 'expect-denied' }, PROBES)).toBeUndefined();
    expect(probeMarksProblem({ 'helm.list': 'skip', 'kube.get': 'expect-denied' }, PROBES)).toBeUndefined();
    expect(probeMarksProblem({}, PROBES)).toBeUndefined();
  });

  it('a write probe takes no mark: each write must be refused, always', () => {
    expect(probeMarksProblem({ 'helm.install': 'skip' }, PROBES)).toBe('helm.install is a write probe: a write must be refused always, so it takes no mark');
    expect(probeMarksProblem({ 'aws.iam-create-user': 'expect-denied' }, PROBES)).toContain('is a write probe');
  });

  it('an unknown probe or mark is refused, saying what is', () => {
    expect(probeMarksProblem({ 'helm.lst': 'skip' }, PROBES)).toMatch(/^helm\.lst is no probe: mark one of .*helm\.list/);
    expect(probeMarksProblem({ 'helm.list': 'allow' }, PROBES)).toBe('allow is no probe mark: expect-denied or skip');
    const many = Object.fromEntries(Array.from({ length: PROBE_MARKS_MAX + 1 }, (_, i) => [`p${i}`, 'skip']));
    expect(probeMarksProblem(many, PROBES)).toBe(`a template holds at most ${PROBE_MARKS_MAX} probe marks`);
  });

  it('marks apply to read probes only: a mark on a write probe kept before changes nothing', () => {
    const runs = HOPPER_PROBES.runsFor([{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }]);
    const marked = markRuns(runs, { 'helm.list': 'expect-denied', 'helm.install': 'skip' });
    const of = (rs: ProbeRun[], id: string) => rs.find((r) => r.probe.id === id)!;
    expect(of(marked, 'helm.list').mark).toBe('expect-denied');
    expect(of(marked, 'helm.install').mark).toBeUndefined();
    expect(of(marked, 'kube.get').mark).toBeUndefined();
    expect(markRuns(runs, undefined)).toEqual(runs);
  });
});
