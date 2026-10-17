// A need step as a saga (issues #1524, #1568, design.md "Sagas: work that survives a stop"): a need step kept in
// the real database and run by the real coordinator. A hopper stopped at each step leaves the step to another host,
// which goes on from there: the need box runs once at the most, the job reads one result, and the step's credentials
// end. An abort mid-step leaves no need box and no credential. The vault's mint and the need box are doubles at their
// seams; the need box writes the sandbox runs ledger as the sandbox module does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSagaCoordinator, type SagaCoordinator } from '../../src/sagas/coordinator.ts';
import { createNeedSteps, STEP_INTERRUPTED, type NeedSteps } from '../../src/sandbox/need-steps.ts';
import { NEED_STEP_SAGA, needStepSaga } from '../../src/sandbox/need-step-saga.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const temp = useTempStore();
const LEASE_MS = 60_000;
const quiet = { info: () => {}, warn: () => {} };
const WRITE: OperationProfile = { operation: 'apply', asset: { kind: 'aws-role', name: '123456789012/deploy' } };
const TEMPLATE = { name: 'deploy', image: 'img', profiles: [WRITE] } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const AWS = { minted: { kind: 'aws' as const, AccessKeyId: 'ASIA', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: '2030-01-01T00:15:00Z' }, reach: { kind: 'aws' as const, region: 'eu-west-1' } };
const never = (): Promise<never> => new Promise<never>(() => {});

/** The world outside the hopper: the need boxes up now, and the credentials minted and not released. */
function world() {
  const live = new Set<string>(), credentials = new Set<string>();
  /** Where the next try stops its hopper: the mint, the need box after it started, or the release. Resolves when reached. */
  let stopAt: { at: 'mint' | 'box' | 'release'; reached(): void } | undefined;
  const halt = (at: 'mint' | 'box' | 'release'): boolean => {
    if (stopAt?.at !== at) return false;
    stopAt.reached();
    stopAt = undefined;
    return true;
  };
  let block: (() => void) | undefined;
  return {
    live, credentials,
    stopAt: (at: 'mint' | 'box' | 'release'): Promise<void> => new Promise((reached) => { stopAt = { at, reached }; }),
    /** The next need box runs until it is stopped. Resolves when it started. */
    block: (): Promise<void> => new Promise((r) => { block = r; }),
    halt, unblock: () => { const b = block; block = undefined; return b; },
  };
}

describe('a need step as a saga (issue #1568)', () => {
  const stores: InstanceStore[] = [], coordinators: SagaCoordinator[] = [], dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((c) => c.stop()));
    for (const s of stores.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  let ids = 0;

  /** One hopper: its store, its need steps and its coordinator, on the shared database and the shared world. */
  const hopper = (url: string, owner: string, w: ReturnType<typeof world>, clock: ReturnType<typeof fixedClock>) => {
    const store = openInstanceStore({ url, clock });
    stores.push(store);
    const dir = mkdtempSync(join(tmpdir(), 'step-saga-'));
    dirs.push(dir);
    const held: { c?: SagaCoordinator } = {};
    const steps: NeedSteps = createNeedSteps({
      userId: 'admin', templates: () => [TEMPLATE], dir, record: () => {}, log: () => {}, planFile: () => undefined, now: () => clock.now(),
      steps: store.needSteps, ran: (step) => store.sandboxRuns.get(step) !== undefined, atWork: () => true,
      mint: async ({ step }) => { if (w.halt('mint')) return never(); w.credentials.add(step); return AWS; },
      release: async (box) => { if (w.halt('release')) return never(); w.credentials.delete(box); },
      run: async (box, io, r) => {
        store.sandboxRuns.start({ id: r.step, userId: 'admin', jobId: r.jobId, template: r.template, box: box.name, machine: 'local', startedAt: clock.now().toISOString() });
        w.live.add(box.name);
        if (w.halt('box')) return never();
        const started = w.unblock();
        if (started) {
          started();
          await new Promise<void>((resolve) => { io.signal.addEventListener('abort', () => resolve()); });
          w.live.delete(box.name);
          return { exit: 130, problem: 'the step was stopped', stopped: 'cancelled' };
        }
        applied();
        w.live.delete(box.name);
        return { exit: 0, outputs: Buffer.from('out') };
      },
      sagas: { begin: (step) => held.c!.begin(NEED_STEP_SAGA, step, { step }, { userId: 'admin' }).id, abort: (saga, reason) => held.c!.abort(saga, reason) },
    });
    const c = held.c = createSagaCoordinator({ repo: store.sagas, definitions: [needStepSaga({ steps: () => steps })], owner, clock, idGen: () => `saga-${++ids}`, logger: quiet, leaseMs: LEASE_MS, renewMs: 1e9 });
    coordinators.push(c);
    return { store, steps, c };
  };
  let appliedCount = 0;
  const applied = (): void => { appliedCount++; };
  const later = (clock: ReturnType<typeof fixedClock>, ms: number): void => clock.set(new Date(clock.now().getTime() + ms).toISOString());
  let keys = 0;
  const ask = () => ({ key: `key-${String(++keys).padStart(4, '0')}`, inputs: Buffer.alloc(0) });
  const start = (steps: NeedSteps): string => {
    const r = steps.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply', outputs: ['out'] }, ask());
    if ('no' in r) throw new Error(r.no);
    return r.id;
  };

  it('with no stop, the step runs once; the job reads its result and outputs from any host; its credentials end', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock), b = hopper(url, 'host-b', w, clock);
    const before = appliedCount;
    const id = start(a.steps);
    const saga = a.store.needSteps.get(id)!.saga!;
    expect((await a.c.drive(saga))?.state).toBe('done');
    expect(appliedCount - before).toBe(1);
    expect(b.steps.state(JOB, id)).toEqual({ result: { exit: 0, outputsBytes: 3 }, outputs: Buffer.from('out') });
    expect([w.live.size, w.credentials.size]).toEqual([0, 0]);
  });

  for (const at of ['mint', 'box', 'release'] as const) {
    it(`a hopper stopped at the ${at}: another host goes on once the lease ends; the box runs once at the most, its credentials end`, async () => {
      const url = temp.url(), w = world(), clock = fixedClock();
      const a = hopper(url, 'host-a', w, clock);
      const before = appliedCount;
      const stopped = w.stopAt(at);
      const id = start(a.steps);
      await stopped;
      const saga = a.store.needSteps.get(id)!.saga!;

      // While its lease holds, no other host takes it; the job reads that it runs.
      const b = hopper(url, 'host-b', w, clock);
      await b.c.pass();
      expect(b.steps.state(JOB, id)).toEqual(at === 'release' ? { result: { exit: 0, outputsBytes: 3 }, outputs: Buffer.from('out') } : { running: true });

      later(clock, LEASE_MS + 1);
      await b.c.pass();
      expect(b.store.sagas.get(saga)?.state).toBe('done');
      if (at === 'mint') {
        // Stopped before its box: the box runs on the other host, once.
        expect(appliedCount - before).toBe(1);
        expect(b.steps.state(JOB, id)).toEqual({ result: { exit: 0, outputsBytes: 3 }, outputs: Buffer.from('out') });
      } else if (at === 'box') {
        // Its box started, then its hopper stopped: it may have had its effect, so it is not run again.
        expect(appliedCount - before).toBe(0);
        expect(b.steps.state(JOB, id)).toEqual({ result: { exit: 125, problem: STEP_INTERRUPTED } });
      } else {
        // It ran and was kept: the other host only ends its credentials.
        expect(appliedCount - before).toBe(1);
        expect(b.steps.state(JOB, id)).toEqual({ result: { exit: 0, outputsBytes: 3 }, outputs: Buffer.from('out') });
      }
      // Every credential minted for its need box is released, whichever host minted it.
      expect(w.credentials.size).toBe(0);
    });
  }

  it('an abort mid-step stops the need box and compensates: no box and no credential are left, the step ends cancelled', async () => {
    const url = temp.url(), w = world(), clock = fixedClock();
    const a = hopper(url, 'host-a', w, clock);
    const blocked = w.block();
    const id = start(a.steps);
    await blocked;
    expect([w.live.size, w.credentials.size]).toEqual([1, 1]);
    expect(a.steps.stop(JOB, id)).toBe(true);
    const saga = a.store.needSteps.get(id)!.saga!;
    await new Promise((r) => setImmediate(r));
    const end = await a.c.drive(saga);
    expect(end?.state).toBe('compensated');
    expect([w.live.size, w.credentials.size]).toEqual([0, 0]);
    expect(a.steps.state(JOB, id)).toMatchObject({ result: { exit: 125, problem: expect.stringContaining('cancelled: aborted: job job-1 stopped the step') } });
    expect(a.steps.stop(JOB, id)).toBe(false);
  });
});
