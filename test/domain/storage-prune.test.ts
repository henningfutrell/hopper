// Which exited containers the storage prune removes (issue #2494, design.md "Hopper's own disk use" → "Part 8"): pure.
import { describe, expect, it } from 'vitest';
import { containersToPrune, stoppedAtMs } from '../../src/domain/storage-prune.ts';

const NOW = Date.parse('2026-10-22T00:00:00Z');
const DAY = 86_400_000;
const exited = (id: string, finishedAt: string, labels: string[] = []) => ({ runtime: 'podman' as const, id: id.repeat(64), finishedAt, labels });

describe('when a container stopped', () => {
  it('reads docker\'s time and podman\'s, and no zero time', () => {
    expect(stoppedAtMs('2026-10-01T00:20:00.123456789Z')).toBe(Date.parse('2026-10-01T00:20:00.123Z'));
    expect(stoppedAtMs('2026-10-01 00:20:00.123456789 -0500 CDT')).toBe(Date.parse('2026-10-01T05:20:00.123Z'));
    expect(stoppedAtMs('2026-10-01 00:20:00 +0000 UTC')).toBe(Date.parse('2026-10-01T00:20:00Z'));
    expect(stoppedAtMs('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(stoppedAtMs('soon')).toBeUndefined();
  });
});

describe('the exited containers the prune removes', () => {
  it('takes one stopped longer than the age, not one stopped since', () => {
    const old = exited('a', new Date(NOW - 31 * DAY).toISOString());
    const recent = exited('b', new Date(NOW - 29 * DAY).toISOString());
    expect(containersToPrune([old, recent], 30, NOW)).toEqual([old]);
  });

  it('never takes the stack\'s, the hopper\'s own, a kind node\'s or a job\'s, nor one with no stop time', () => {
    const long = new Date(NOW - 90 * DAY).toISOString();
    const kept = [
      exited('a', long, ['com.docker.compose.project']), exited('b', long, ['io.podman.compose.project']),
      exited('c', long, ['io.hopper.box']), exited('d', long, ['io.x-k8s.kind.cluster']), exited('e', long, ['hopper.job']),
      exited('f', '0001-01-01T00:00:00Z'),
    ];
    expect(containersToPrune(kept, 30, NOW)).toEqual([]);
  });
});
