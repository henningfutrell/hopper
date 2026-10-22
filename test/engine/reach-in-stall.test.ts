// Issue #2427: a machine's check that the hopper answers waits on the hopper's own event loop. A stall of that loop made
// every ssh seat fail its checks at once, and each seat was held for ten minutes. A check that fails while the loop was
// held is checked again; one that fails in a stall again holds no machine. Fakes only at the machine shell's seam, and
// the loop's reading given as the watchdog gives it.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobProxyCredentials, MachineShell } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { giveLoopHeld } from '../../src/domain/loop-held.ts';
import { placeCredentials, Unreached } from '../../src/engine/credentials.ts';
import { createAttachedMachineSource } from '../../src/machines/index.ts';

const PROXY: JobProxyCredentials = { url: 'http://127.0.0.1:1', files: { 'proxy-token': 'token' }, paths: { HOPPER_PROXY_TOKEN: 'proxy-token' }, vars: { HOPPER_URL: 'http://127.0.0.1:1' } };
const engine = { jobProxy: () => PROXY };
const MACHINE = { id: 'seat-1' } as MachineSnapshot;
const JOB = { id: 'job-1' } as Job;
const NO_ANSWER = 'this machine cannot reach the hopper at http://127.0.0.1:1: no answer';

/** A machine shell whose reach checks answer `answers` in turn; `stall` runs as each check waits. */
const shell = (answers: (string | undefined)[], stall: (n: number) => void = () => {}): MachineShell & { checks: number } => {
  const s = {
    checks: 0,
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async discover(): Promise<never> { throw new Error('not asked'); },
    async reach() { stall(s.checks); return answers[s.checks++]; },
    async keepCredential() {},
  };
  return s;
};

/** The loop held `ms` in each check `held` names, as the watchdog reads it. */
const loop = () => {
  const spans: { from: number; to: number }[] = [];
  const stop = giveLoopHeld((from) => spans.reduce((n, s) => n + Math.max(0, s.to - Math.max(s.from, from)), 0));
  return { stop, stall: (held: number[], ms: number) => (n: number) => { if (held.includes(n)) { const now = Date.now(); spans.push({ from: now, to: now + ms }); } } };
};

let stop = (): void => {};
afterEach(() => { stop(); });

describe('a reach check in a stall of the hopper\'s loop (issue #2427)', () => {
  it('is checked again: a machine that answers then gets the job', async () => {
    const l = loop(); stop = l.stop;
    const s = shell([NO_ANSWER, undefined], l.stall([0], 10_000));
    expect(await placeCredentials(engine, JOB, MACHINE, s, '/w', false, () => {})).toMatchObject({ HOPPER_URL: 'http://127.0.0.1:1' });
    expect(s.checks).toBe(2);
  });

  it('failed in a stall again: the job is not run there, and the machine is no proof of being out of reach', async () => {
    const l = loop(); stop = l.stop;
    const failed = placeCredentials(engine, JOB, MACHINE, shell([NO_ANSWER, NO_ANSWER], l.stall([0, 1], 10_000)), '/w', false, () => {});
    const err = await failed.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Unreached);
    expect((err as Unreached).loopHeld).toBe(true);
    expect((err as Unreached).message).toMatch(/while the hopper's own event loop was held/);
  });

  it('failed with the loop free, or after a short hold: no second check, and the machine is held as before', async () => {
    const l = loop(); stop = l.stop;
    for (const ms of [0, 500]) {
      const s = shell([NO_ANSWER, undefined], l.stall([0], ms));
      const err = await placeCredentials(engine, JOB, MACHINE, s, '/w', false, () => {}).then(() => undefined, (e: unknown) => e);
      expect((err as Unreached).loopHeld).toBe(false);
      expect(s.checks).toBe(1);
    }
  });
});

const flush = () => new Promise((r) => setImmediate(r));

describe('an ssh target\'s address probe in a stall of the hopper\'s loop (issue #2427)', () => {
  it('keeps the address state it had, and is probed again at the next read', async () => {
    const l = loop(); stop = l.stop;
    let probes = 0, held = false, t = 0;
    const src = createAttachedMachineSource({
      machine: () => ({ name: 'seat', ssh: 'seat', lanes: 1, executors: ['herdr-claude'], herdr: true, session: 'hopper' }),
      clock: { now: () => new Date(t) }, probeEveryMs: 30000,
      probe: async () => {
        probes++;
        if (!held) return { online: true, home: '/home/x', hopperUrl: 'http://10.0.0.2:4790' };
        l.stall([0], 10_000)(0);
        return { online: true, home: '/home/x', addressProblem: 'the hopper cannot be reached from it: http://10.0.0.2:4790 (no answer)' };
      },
    });
    await src.list(); await flush();
    expect((await src.list())[0]).toMatchObject({ hopperUrl: 'http://10.0.0.2:4790' });
    held = true; t += 30000;
    await src.list(); await flush();
    expect(probes).toBe(2);
    expect((await src.list())[0]).toMatchObject({ hopperUrl: 'http://10.0.0.2:4790' });
    // Probed again at once, with no wait for the next probe's time.
    held = false;
    await src.list(); await flush();
    const [m] = await src.list();
    expect(m).toMatchObject({ hopperUrl: 'http://10.0.0.2:4790' });
    expect(m).not.toHaveProperty('addressProblem');
    expect(probes).toBe(4);
  });
});
