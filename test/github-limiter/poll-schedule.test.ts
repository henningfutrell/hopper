// The poll schedule (issue #436): GitHub watches poll in batches, and the batches spread evenly across the poll interval, so
// 100+ watches never ask GitHub all at once. The interval and the batch size are read at each round: a change applies
// to the next round without a restart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPollSchedule } from '../../src/github-limiter/poll-schedule.ts';

beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
afterEach(() => { vi.useRealTimers(); });

function watches(n: number) {
  const started: { key: string; at: number }[] = [];
  const poll = (key: string) => async () => { started.push({ key, at: Date.now() }); };
  return { started, keys: Array.from({ length: n }, (_, i) => `w${i}`), poll };
}

describe('the poll schedule (issue #436)', () => {
  it('120 watches, batches of 10, a minute: 12 batches 5 s apart, each watch polled once a round', async () => {
    const w = watches(120);
    const s = createPollSchedule({ intervalMs: () => 60_000, batchSize: () => 10 });
    for (const k of w.keys) s.add(k, w.poll(k));
    s.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(w.started).toHaveLength(120);
    expect(new Set(w.started.map((p) => p.key)).size).toBe(120);
    const times = [...new Set(w.started.map((p) => p.at))];
    expect(times).toEqual(Array.from({ length: 12 }, (_, i) => i * 5000));
    for (const t of times) expect(w.started.filter((p) => p.at === t)).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.started).toHaveLength(130);
    await s.stop();
  });

  it('a new interval or batch size applies at the next round', async () => {
    const w = watches(20);
    let interval = 60_000;
    let batch = 10;
    const s = createPollSchedule({ intervalMs: () => interval, batchSize: () => batch });
    for (const k of w.keys) s.add(k, w.poll(k));
    s.start();
    await vi.advanceTimersByTimeAsync(1);
    interval = 10_000;
    batch = 5;
    await vi.advanceTimersByTimeAsync(59_998);
    w.started.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect([...new Set(w.started.map((p) => p.at))]).toEqual([60_000, 62_500, 65_000, 67_500]);
    await s.stop();
  });

  it('a watch removed is not polled again; one still polling from the last round is skipped, not doubled', async () => {
    const s = createPollSchedule({ intervalMs: () => 1000, batchSize: () => 10 });
    let slow = 0;
    let fast = 0;
    s.add('slow', () => { slow++; return new Promise((r) => setTimeout(r, 2500)); });
    s.add('fast', async () => { fast++; });
    s.start();
    await vi.advanceTimersByTimeAsync(2999);
    expect(fast).toBe(3);
    expect(slow).toBe(1);
    s.remove('fast');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fast).toBe(3);
    expect(slow).toBe(2);
    expect(s.size()).toBe(1);
    const stopped = s.stop();
    await vi.advanceTimersByTimeAsync(2500);
    await stopped;
  });

  it('a poll that throws is reported and the others still run; stop waits for the polls running', async () => {
    const errors: string[] = [];
    let finished = false;
    const s = createPollSchedule({ intervalMs: () => 1000, batchSize: () => 10, onError: (key, err) => errors.push(`${key}: ${(err as Error).message}`) });
    s.add('bad', async () => { throw new Error('boom'); });
    s.add('slow', () => new Promise<void>((r) => setTimeout(() => { finished = true; r(); }, 500)));
    s.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(errors).toEqual(['bad: boom']);
    const stopped = s.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors).toEqual(['bad: boom']);
  });
});
