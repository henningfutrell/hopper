// A need step's files (issue #1007, src/sandbox/need-steps.ts): the inputs the job sent, over 64 KiB too, and, for a
// step that applies an approved infra plan, that plan's saved file and its id, go to the need box. A need box holds no
// proxy token, so the apply wrapper in it cannot fetch the plan file: the hopper gives it. Each step is kept in the
// real database (issue #1568), and its saga is a double that records each begin: a test runs the saga's steps itself.
// The vault's mint and the need box are doubles at their seams.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { NeedBox, NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { createNeedSteps, NEED_STEP_INPUTS_MAX_BYTES, NO_NEED_STEPS, STEP_INTERRUPTED, type NeedStepsOptions } from '../../src/sandbox/need-steps.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { useTempStore } from '../store/helpers.ts';

const PLAN = '3f2b8a7c-1d4e-4f6a-9b0c-2d3e4f5a6b7c';
const FILE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255]);
const WRITE: OperationProfile = { operation: 'apply', asset: { kind: 'aws-role', name: '123456789012/deploy' } };
const TEMPLATE = { name: 'deploy', image: 'img', profiles: [WRITE], limits: { cpus: { default: 2, max: 2 } } } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const AWS = { minted: { kind: 'aws' as const, AccessKeyId: 'ASIA', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: '2030-01-01T00:15:00Z' }, reach: { kind: 'aws' as const, region: 'eu-west-1' } };

const temp = useTempStore();
const dirs: string[] = [];
const stores: InstanceStore[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of stores.splice(0)) s.close();
});
let keys = 0;
/** A new ask's key and its inputs. */
const ask = (inputs = Buffer.alloc(0)) => ({ key: `key-${String(++keys).padStart(4, '0')}`, inputs });
const signal = () => new AbortController().signal;

/** Need steps over a real store; `run` the need box, which the sandbox module would record in the ledger. */
function needSteps(o: Partial<NeedStepsOptions> & { templates: () => TemplateView[]; run?: NonNullable<NeedStepsOptions['run']> }) {
  const dir = mkdtempSync(join(tmpdir(), 'need-steps-'));
  dirs.push(dir);
  const store = openInstanceStore({ url: temp.url(), clock: { now: () => new Date() } });
  stores.push(store);
  const events: NewEvent[] = [];
  const begun: string[] = [];
  const boxes: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>[] = [];
  const run = o.run ?? (async (): Promise<NeedBoxResult> => ({ exit: 0 }));
  const s = createNeedSteps({
    userId: 'admin', dir, record: (e) => { events.push(e); }, log: () => {}, planFile: (id) => (id === PLAN ? FILE : undefined),
    mint: async () => AWS, steps: store.needSteps, ran: (step) => store.sandboxRuns.get(step) !== undefined, atWork: () => true,
    sagas: { begin: (step) => { begun.push(step); return `saga-${step}`; }, abort: () => true },
    ...o,
    run: async (box, io, r) => {
      boxes.push(box);
      store.sandboxRuns.start({ id: r.step, userId: 'admin', jobId: r.jobId, template: r.template, box: box.name, machine: 'local', startedAt: new Date().toISOString() });
      return run(box, io, r);
    },
  });
  /** Asks for a step and runs it as its saga would: its result. */
  const go = async (started: { id: string } | { status: number; no: string }) => {
    if ('no' in started) throw new Error(started.no);
    await s.run(started.id, signal());
    await s.release(started.id);
    const state = s.state(JOB, started.id);
    if (!state || 'running' in state) throw new Error('the step did not end');
    return state;
  };
  return { s, store, events, begun, boxes, go };
}

describe('a need step\'s files (issue #1007)', () => {
  it('a step that applies an approved plan gets its saved file and its id in the need box', async () => {
    const { s, boxes, go } = needSteps({ templates: () => [TEMPLATE] });
    expect((await go(s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply -auto-approve', outputs: [], plan: PLAN }, ask()))).result).toEqual({ exit: 0 });
    expect(boxes[0]!.files).toEqual({ plan: FILE });
    expect(boxes[0]!.env.HOPPER_PLAN).toBe(PLAN);
    // The box runs with the template's limits (issue #1349).
    expect(boxes[0]!.template.limits).toEqual({ cpus: { default: 2, max: 2 } });
  });

  it('a plan with no saved file gives the box its id only: the wrapper there says why it cannot apply', async () => {
    const { s, boxes, go } = needSteps({ templates: () => [TEMPLATE] });
    const other = '00000000-0000-4000-8000-000000000000';
    await go(s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply', outputs: [], plan: other }, ask()));
    expect(boxes[0]!.files).toBeUndefined();
    expect(boxes[0]!.env.HOPPER_PLAN).toBe(other);
  });

  it('the inputs, kept in the database, go to the need box as a file, over 64 KiB too', async () => {
    expect(NEED_STEP_INPUTS_MAX_BYTES).toBeGreaterThan(64 * 1024);
    const inputs = Buffer.alloc(200 * 1024, 'x');
    let seen: Buffer | undefined;
    const { s, boxes, go } = needSteps({ templates: () => [TEMPLATE], run: async (box) => { seen = readFileSync(box.files!.inputs!); return { exit: 0 }; } });
    await go(s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'ls', outputs: [] }, ask(inputs)));
    expect(seen?.equals(inputs)).toBe(true);
    expect(boxes[0]!.env.HOPPER_STEP_INPUTS).toBeUndefined();
    expect(boxes[0]!.env.HOPPER_PLAN).toBeUndefined();
  });
});

// Issue #1568: a step is kept in the database from the job's ask. The same ask sent again is the same step; its log, its
// result and its outputs are read from the database; a step whose need box started before a stop is never run again.
describe('a need step kept in the database (issue #1568)', () => {
  it('the same key again answers the same step: one step, one need box', async () => {
    const { s, begun, boxes } = needSteps({ templates: () => [TEMPLATE] });
    const a = ask();
    const fields = { template: TEMPLATE, needs: [WRITE], command: 'terraform apply', outputs: [] };
    const first = s.start(JOB, fields, a), again = s.start(JOB, fields, a);
    expect(again).toEqual(first);
    expect(begun).toEqual([(first as { id: string }).id, (first as { id: string }).id]);
    const other = s.start(JOB, fields, ask());
    expect(other).not.toEqual(first);
    await s.run((first as { id: string }).id, signal());
    await s.run((first as { id: string }).id, signal());
    expect(boxes).toHaveLength(1);
  });

  it('its log, masked, and then its result and outputs are read from the database; while it runs it says so', async () => {
    let finish = (): void => {};
    const { s, store, go } = needSteps({
      templates: () => [TEMPLATE],
      run: async (_box, io) => {
        io.log('who: ASIA');
        io.log(' with secret\n');
        await new Promise<void>((r) => { finish = r; });
        return { exit: 3, outputs: Buffer.from('tar'), problem: 'it failed' };
      },
    });
    const started = s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'aws sts get-caller-identity', outputs: ['out.txt'] }, ask());
    const { id } = started as { id: string };
    const running = s.run(id, signal());
    await new Promise((r) => setImmediate(r));
    expect(s.state(JOB, id)).toEqual({ running: true });
    expect(s.log(JOB, id, 0)).toEqual({ text: 'who: *** with ***\n', next: 18, ended: false });
    expect(s.log(JOB, id, 9)).toMatchObject({ text: 'with ***\n', next: 18 });
    finish();
    await running;
    expect(s.log(JOB, id, 18)).toEqual({ text: '', next: 18, ended: true });
    expect((await go({ id })).result).toEqual({ exit: 3, outputsBytes: 3, problem: 'it failed' });
    expect(s.state(JOB, id)).toEqual({ result: { exit: 3, outputsBytes: 3, problem: 'it failed' }, outputs: Buffer.from('tar') });
    // Its inputs are dropped once it ended; another job's ask for it finds nothing.
    expect(store.needSteps.inputs(id)).toBeUndefined();
    expect(s.state({ ...JOB, id: 'job-2' } as Job, id)).toBeUndefined();
  });

  it('a step whose need box started before a stop is not run again: it ends saying so, and its credentials end', async () => {
    const released: string[] = [];
    const { s, store, boxes, events } = needSteps({ templates: () => [TEMPLATE], release: async (box) => { released.push(box); } });
    const { id } = s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply', outputs: [] }, ask()) as { id: string };
    // The hopper that ran it stopped mid-step: its ledger row is there, and no result.
    store.sandboxRuns.start({ id, userId: 'admin', jobId: JOB.id, template: TEMPLATE.name, box: 'hopper-need-x', machine: 'local', startedAt: new Date().toISOString() });
    await s.run(id, signal());
    await s.release(id);
    expect(boxes).toEqual([]);
    expect(s.state(JOB, id)).toEqual({ result: { exit: 125, problem: STEP_INTERRUPTED } });
    expect(events.filter((e) => e.type === 'step.finished').map((e) => e.data)).toEqual([expect.objectContaining({ step: id, exit: 125, problem: STEP_INTERRUPTED })]);
    expect(released).toEqual([store.needSteps.get(id)!.box]);
  });

  it('a job no longer at work: its step does not run; one that stops mid-step stops the need box', async () => {
    let atWork = false;
    let stoppedBy: unknown;
    const { s, boxes } = needSteps({
      templates: () => [TEMPLATE], atWork: () => atWork,
      run: (_box, io) => new Promise((resolve) => { io.signal.addEventListener('abort', () => { stoppedBy = io.signal.reason; resolve({ exit: 130, problem: 'stopped' }); }); }),
    });
    const first = s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'true', outputs: [] }, ask()) as { id: string };
    await s.run(first.id, signal());
    expect(boxes).toEqual([]);
    expect(s.state(JOB, first.id)).toEqual({ result: { exit: 125, problem: 'cancelled: job job-1 is not at work' } });
    atWork = true;
    const abort = new AbortController();
    const second = s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'sleep 600', outputs: [] }, ask()) as { id: string };
    const running = s.run(second.id, abort.signal);
    await new Promise((r) => setImmediate(r));
    abort.abort(new Error('aborted: job job-1 stopped the step'));
    await running;
    expect(boxes).toHaveLength(1);
    expect(stoppedBy).toEqual(new Error('aborted: job job-1 stopped the step'));
  });

  it('the compensation ends a step not ended as cancelled, once, and its credentials end', async () => {
    const released: string[] = [];
    const { s, events } = needSteps({ templates: () => [TEMPLATE], release: async (box) => { released.push(box); } });
    const { id } = s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'true', outputs: [] }, ask()) as { id: string };
    await s.cancel(id, 'aborted: a person stopped it');
    await s.cancel(id, 'again');
    expect(s.state(JOB, id)).toEqual({ result: { exit: 125, problem: 'cancelled: aborted: a person stopped it' } });
    expect(events.filter((e) => e.type === 'step.finished')).toHaveLength(1);
    expect(released).toHaveLength(2);
  });

  it('a step\'s ask is refused without a saga to run it, saying why', () => {
    const { s } = needSteps({ templates: () => [TEMPLATE] });
    const none = createNeedSteps({ userId: 'admin', templates: () => [TEMPLATE], dir: '', record: () => {}, log: () => {}, planFile: () => undefined, mint: async () => AWS, steps: NO_NEED_STEPS, ran: () => false, atWork: () => true });
    expect(none.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'true', outputs: [] }, ask())).toMatchObject({ status: 503, no: expect.stringContaining('this hopper runs no sandbox step') });
    expect(s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: ' ', outputs: [] }, ask())).toMatchObject({ status: 400 });
  });
});

// Issue #1349: a box step is a need step in a sandbox of its own, of the template the job's sandbox request was approved
// for. It is minted the template's reads, and with an approved plan its changes too; nothing the vault does not mint.
describe('a box step (issue #1349)', () => {
  const READ: OperationProfile = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } };
  const ACCOUNT: OperationProfile = { operation: 'read', asset: { kind: 'aws-account', name: '123456789012' } };
  const READY = { name: 'asked-1', image: 'img', profiles: [READ, WRITE, ACCOUNT], approval: { by: 'Ada' }, gives: [], pending: { image: false, egress: [], profiles: [] } } as unknown as TemplateView;

  function boxSteps(templates: TemplateView[]) {
    const minted: OperationProfile[] = [];
    const runs: { box: string; run: unknown }[] = [];
    const n = needSteps({
      templates: () => templates,
      mint: async (a) => { minted.push(a.profile); return AWS; },
      run: async (box, _io, run) => { runs.push({ box: box.name, run }); return { exit: 0 }; },
    });
    return { ...n, minted, runs };
  }

  it('runs in a new sandbox of the approved template, minted its reads only; the ledger is told the job and the step', async () => {
    const { s, minted, runs, go } = boxSteps([READY]);
    const started = s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'aws sts get-caller-identity', outputs: [], secrets: [] }, ask());
    expect((await go(started)).result).toEqual({ exit: 0 });
    expect(minted).toEqual([READ]);
    expect(runs).toEqual([{ box: expect.stringMatching(/^hopper-need-asked-1-/), run: { jobId: JOB.id, step: (started as { id: string }).id, template: 'asked-1' } }]);
    await go(s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'true', outputs: [], secrets: [] }, ask()));
    expect(runs[1]!.box).not.toBe(runs[0]!.box);
  });

  it('with an approved plan, its changes are minted too', async () => {
    const { s, minted, go } = boxSteps([READY]);
    await go(s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'terraform apply', outputs: [], secrets: [], plan: PLAN }, ask()));
    expect(minted).toEqual([READ, WRITE]);
  });

  it('a template the job has no approved sandbox of, a --secret, or a template not ready now is refused', () => {
    const { s, runs, events, begun } = boxSteps([READY, { ...READY, name: 'asked-2', pending: { image: false, egress: [], profiles: [WRITE] } } as unknown as TemplateView]);
    expect(s.box(JOB, { box: 'asked-1', approved: [], command: 'true', outputs: [], secrets: [] }, ask()))
      .toEqual({ status: 404, no: expect.stringContaining('this job has no approved sandbox of template asked-1. It has none') });
    expect(s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'true', outputs: [], secrets: ['AWS_KEY'] }, ask()))
      .toEqual({ status: 400, no: expect.stringContaining('a box step takes no --secret') });
    expect(s.box(JOB, { box: 'asked-2', approved: ['asked-2'], command: 'true', outputs: [], secrets: [] }, ask()))
      .toEqual({ status: 409, no: expect.stringContaining('template asked-2 is not ready now') });
    expect(runs).toEqual([]);
    expect(begun).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['step.refused', 'step.refused', 'step.refused']);
  });
});

// Issue #1371 (decision #1394): a step's credentials end with its sandbox. Each way a step ends — it exits, fails, its
// box run throws, it times out or is cancelled, or a later mint is refused — releases the sandbox's bindings, so each
// Kubernetes token minted for it stops working.
describe('a step\'s credentials end with its sandbox (issue #1371)', () => {
  const KUBE: OperationProfile = { operation: 'read', asset: { kind: 'namespace', name: 'lab/web' } };
  const KUBE_TEMPLATE = { name: 'kube', image: 'img', profiles: [KUBE, WRITE] } as unknown as TemplateView;

  function releasing(run: () => Promise<NeedBoxResult>, refuse?: OperationProfile) {
    const released: string[] = [];
    const minted: string[] = [];
    const n = needSteps({
      templates: () => [KUBE_TEMPLATE],
      mint: async ({ step, profile }) => {
        minted.push(step);
        if (refuse && profile.operation === refuse.operation && profile.asset.name === refuse.asset.name) return { refused: 'Access denied it' };
        return { minted: { kind: 'kube', token: 'token', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://lab:6443' } };
      },
      run: async () => run(),
      release: async (box) => { released.push(box); },
    });
    return { ...n, released, minted };
  }

  it.each([
    ['succeeds', async () => ({ exit: 0 })],
    ['fails', async () => ({ exit: 3 })],
    ['times out', async () => ({ exit: 124, problem: 'the need box did not end in 5 s', stopped: 'timed-out' as const })],
    ['is cancelled', async () => ({ exit: 130, problem: 'the job stopped waiting', stopped: 'cancelled' as const })],
    ['throws', async (): Promise<NeedBoxResult> => { throw new Error('the runtime went away'); }],
  ])('a step that %s releases its sandbox\'s bindings after it', async (_, run) => {
    const { s, released, minted } = releasing(run);
    const { id } = s.start(JOB, { template: KUBE_TEMPLATE, needs: [KUBE], command: 'kubectl get pods', outputs: [] }, ask()) as { id: string };
    expect(released).toEqual([]);
    await s.run(id, signal());
    expect(released).toEqual([minted[0]]);
  });

  it('a step whose later mint is refused releases what was minted for it before, and ends refused, saying why', async () => {
    const { s, released, minted, events } = releasing(async () => ({ exit: 0 }), WRITE);
    const { id } = s.start(JOB, { template: KUBE_TEMPLATE, needs: [KUBE, WRITE], command: 'kubectl apply', outputs: [] }, ask()) as { id: string };
    await s.run(id, signal());
    expect(released).toEqual([minted[0]]);
    expect(s.state(JOB, id)).toEqual({ result: { exit: 125, problem: 'apply/aws-role/123456789012/deploy: Access denied it' } });
    expect(events.filter((e) => e.type === 'step.refused').map((e) => e.data)).toEqual([{ reason: 'apply/aws-role/123456789012/deploy: Access denied it', box: minted[0] }]);
  });
});

// Issue #1722: with infra applies off, the hopper runs no step that applies: none with a plan, none that needs a change.
// A step that only reads runs as before.
describe('need and box steps with infra applies off (issue #1722)', () => {
  const READ: OperationProfile = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } };
  const READY = { name: 'asked-1', image: 'img', profiles: [READ, WRITE], approval: { by: 'Ada' }, gives: [], pending: { image: false, egress: [], profiles: [] } } as unknown as TemplateView;
  const OFF = /^infra applies are off on this hopper: .* goes through CI/;

  it('refuses a step with a plan, or one that needs a change, and records why; no box starts', () => {
    const { s, events, begun, boxes } = needSteps({ templates: () => [TEMPLATE, READY], applies: () => false });
    expect(s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply', outputs: [], plan: PLAN }, ask())).toEqual({ status: 409, no: expect.stringMatching(OFF) });
    expect(s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply', outputs: [] }, ask())).toEqual({ status: 409, no: expect.stringMatching(OFF) });
    expect(s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'terraform apply', outputs: [], secrets: [], plan: PLAN }, ask())).toEqual({ status: 409, no: expect.stringMatching(OFF) });
    expect(events.filter((e) => e.type === 'step.refused').map((e) => e.data)).toHaveLength(3);
    expect(begun).toEqual([]);
    expect(boxes).toEqual([]);
  });

  it('runs a step that only reads', async () => {
    const minted: OperationProfile[] = [];
    const { s, go } = needSteps({ templates: () => [READY], applies: () => false, mint: async (a) => { minted.push(a.profile); return AWS; } });
    expect((await go(s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'terraform plan', outputs: [], secrets: [] }, ask()))).result).toEqual({ exit: 0 });
    expect(minted).toEqual([READ]);
  });
});
