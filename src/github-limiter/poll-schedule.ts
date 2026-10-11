// The poll schedule (issue #436, design.md "The shared rate limiter"): GitHub watches poll in rounds of the poll interval, in
// batches of the batch size, the batches spread evenly across the round (`pollPlan`), so many GitHub watches never ask GitHub
// at once. The interval and the batch size are read at the start of each round: a change applies to the next round. A
// GitHub watch still polling from an earlier round is skipped, never run twice at once. A poll that throws is reported and
// never stops the others. `stop` ends the rounds and waits for the polls running.
import { pollPlan } from '../domain/github-rate-limit.ts';

export interface PollSchedule {
  add(key: string, poll: () => Promise<void>): void;
  remove(key: string): void;
  size(): number;
  start(): void;
  stop(): Promise<void>;
}

export function createPollSchedule(o: {
  intervalMs: () => number; batchSize: () => number; onError?: (key: string, err: unknown) => void;
}): PollSchedule {
  const polls = new Map<string, () => Promise<void>>();
  const running = new Map<string, Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let started = false;

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };

  function run(key: string): void {
    const poll = polls.get(key);
    if (!poll || running.has(key)) return;
    const p = Promise.resolve().then(poll).catch((err: unknown) => o.onError?.(key, err)).finally(() => running.delete(key));
    running.set(key, p);
  }

  function round(): void {
    if (!started) return;
    const interval = o.intervalMs();
    const keys = [...polls.keys()];
    for (const b of pollPlan(keys.length, interval, o.batchSize())) {
      const batch = keys.slice(b.from, b.to);
      const go = () => { if (started) for (const k of batch) run(k); };
      if (b.at === 0) go(); else later(b.at, go);
    }
    later(interval, round);
  }

  return {
    add(key, poll) { polls.set(key, poll); },
    remove(key) { polls.delete(key); },
    size: () => polls.size,
    start() { if (!started) { started = true; round(); } },
    async stop() {
      started = false;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await Promise.all(running.values());
    },
  };
}
