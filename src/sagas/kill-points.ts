// Kill points (issues #1954, #1959, design.md "The crash harness"): named places — a saga step's, a GitHub outbox call's — where the crash harness's test ends this
// process with SIGKILL, as a crash or a pulled plug does — no stop, no finally, no release of a lease. Off in every
// deploy: a point is armed only in a test run (HOPPER_TEST_RUN, which only the test suite's setup sets) that names it
// (HOPPER_TEST_KILL_POINT, `<name>` or `<name>#<n>` for its nth pass). Anything else passes each point and goes on.
import { writeSync } from 'node:fs';
import type { SagaDefinition } from './coordinator.ts';

/** How many times each point was passed in this process. */
const passed = new Map<string, number>();

/** Ends this process with SIGKILL when a test armed `name`; else nothing. */
export function killPoint(name: string): void {
  const armed = process.env.HOPPER_TEST_RUN ? process.env.HOPPER_TEST_KILL_POINT : undefined;
  if (!armed) return;
  const [point, nth = '1'] = armed.split('#');
  if (point !== name) return;
  const n = (passed.get(name) ?? 0) + 1;
  passed.set(name, n);
  if (n !== Number(nth)) return;
  // Written at once, before the kill: the test reads which point ended the process.
  writeSync(2, `hopper: kill point ${name}\n`);
  process.kill(process.pid, 'SIGKILL');
}

/** The kill points of a saga step: before its do or compensation starts, and after it answered, before it is recorded. */
export const sagaKillPoint = (kind: string, step: string, at: 'before-do' | 'after-do' | 'before-compensate' | 'after-compensate'): string =>
  `saga:${kind}:${step}:${at}`;

/** Every kill point a saga of this kind passes, in step order: what the crash harness picks from. */
export const killPointsOf = (d: SagaDefinition): string[] => d.steps.flatMap((s) => [
  sagaKillPoint(d.kind, s.name, 'before-do'), sagaKillPoint(d.kind, s.name, 'after-do'),
  ...(s.compensate ? [sagaKillPoint(d.kind, s.name, 'before-compensate'), sagaKillPoint(d.kind, s.name, 'after-compensate')] : []),
]);
