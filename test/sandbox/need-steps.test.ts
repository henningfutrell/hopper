// A need step's files (issue #1007, src/sandbox/need-steps.ts): the inputs the job sent, over 64 KiB too, and, for a
// step that applies an approved infra plan, that plan's saved file and its id, go to the need box. A need box holds no
// proxy token, so the apply wrapper in it cannot fetch the plan file: the hopper gives it. The vault's mint and the need
// box are doubles at their seams.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { NeedBox } from '../../src/sandbox/need-box.ts';
import { createNeedSteps, NEED_STEP_INPUTS_MAX_BYTES } from '../../src/sandbox/need-steps.ts';

const PLAN = '3f2b8a7c-1d4e-4f6a-9b0c-2d3e4f5a6b7c';
const FILE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255]);
const WRITE: OperationProfile = { operation: 'apply', asset: { kind: 'aws-role', name: '123456789012/deploy' } };
const TEMPLATE = { name: 'deploy', image: 'img', profiles: [WRITE] } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function steps() {
  const dir = mkdtempSync(join(tmpdir(), 'need-steps-'));
  dirs.push(dir);
  const boxes: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>[] = [];
  const events: NewEvent[] = [];
  const s = createNeedSteps({
    templates: () => [TEMPLATE], dir, record: (e) => { events.push(e); }, log: () => {},
    mint: async () => ({ minted: { kind: 'aws', AccessKeyId: 'ASIA', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: '2030-01-01T00:15:00Z' }, reach: { kind: 'aws', region: 'eu-west-1' } }),
    planFile: (id) => (id === PLAN ? FILE : undefined),
    run: async (box) => { boxes.push(box); return { exit: 0 }; },
  });
  return { s, boxes, events };
}

describe('a need step\'s files (issue #1007)', () => {
  it('a step that applies an approved plan gets its saved file and its id in the need box', async () => {
    const { s, boxes } = steps();
    const started = await s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply -auto-approve', outputs: [], plan: PLAN });
    if ('no' in started) throw new Error(started.no);
    expect(await started.run({ inputsBytes: 0, log: () => {}, signal: new AbortController().signal })).toEqual({ exit: 0 });
    expect(boxes[0]!.files).toEqual({ plan: FILE });
    expect(boxes[0]!.env.HOPPER_PLAN).toBe(PLAN);
  });

  it('a plan with no saved file gives the box its id only: the wrapper there says why it cannot apply', async () => {
    const { s, boxes } = steps();
    const other = '00000000-0000-4000-8000-000000000000';
    const started = await s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'terraform apply', outputs: [], plan: other });
    if ('no' in started) throw new Error(started.no);
    await started.run({ inputsBytes: 0, log: () => {}, signal: new AbortController().signal });
    expect(boxes[0]!.files).toBeUndefined();
    expect(boxes[0]!.env.HOPPER_PLAN).toBe(other);
  });

  it('the inputs go to the need box as a file, over 64 KiB too', async () => {
    expect(NEED_STEP_INPUTS_MAX_BYTES).toBeGreaterThan(64 * 1024);
    const { s, boxes } = steps();
    const started = await s.start(JOB, { template: TEMPLATE, needs: [WRITE], command: 'ls', outputs: [] });
    if ('no' in started) throw new Error(started.no);
    const inputs = Buffer.alloc(200 * 1024, 'x');
    writeFileSync(started.inputsFile, inputs);
    await started.run({ inputsBytes: inputs.length, log: () => {}, signal: new AbortController().signal });
    expect(boxes[0]!.files).toEqual({ inputs: started.inputsFile });
    expect(boxes[0]!.env.HOPPER_STEP_INPUTS).toBeUndefined();
    expect(boxes[0]!.env.HOPPER_PLAN).toBeUndefined();
  });
});

// Issue #1349: a box step is a need step in a sandbox of its own, of the template the job's sandbox request was approved
// for. It is minted the template's reads, and with an approved plan its changes too; nothing the vault does not mint.
describe('a box step (issue #1349)', () => {
  const READ: OperationProfile = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } };
  const ACCOUNT: OperationProfile = { operation: 'read', asset: { kind: 'aws-account', name: '123456789012' } };
  const READY = { name: 'asked-1', image: 'img', profiles: [READ, WRITE, ACCOUNT], approval: { by: 'Ada' }, pending: { image: false, profiles: [] } } as unknown as TemplateView;

  function boxSteps(templates: TemplateView[]) {
    const dir = mkdtempSync(join(tmpdir(), 'box-steps-'));
    dirs.push(dir);
    const minted: OperationProfile[] = [];
    const runs: { box: string; run: unknown }[] = [];
    const events: NewEvent[] = [];
    const s = createNeedSteps({
      templates: () => templates, dir, record: (e) => { events.push(e); }, log: () => {},
      mint: async (ask) => { minted.push(ask.profile); return { minted: { kind: 'aws', AccessKeyId: 'ASIA', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: '2030-01-01T00:15:00Z' }, reach: { kind: 'aws', region: 'eu-west-1' } }; },
      planFile: () => undefined,
      run: async (box, _io, run) => { runs.push({ box: box.name, run }); return { exit: 0 }; },
    });
    return { s, minted, runs, events };
  }
  const go = async (started: Awaited<ReturnType<ReturnType<typeof createNeedSteps>['box']>>) => {
    if ('no' in started) throw new Error(started.no);
    return started.run({ inputsBytes: 0, log: () => {}, signal: new AbortController().signal });
  };

  it('runs in a new sandbox of the approved template, minted its reads only; the ledger is told the job and the step', async () => {
    const { s, minted, runs } = boxSteps([READY]);
    const started = await s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'aws sts get-caller-identity', outputs: [], secrets: [] });
    expect(await go(started)).toEqual({ exit: 0 });
    expect(minted).toEqual([READ]);
    expect(runs).toEqual([{ box: expect.stringMatching(/^hopper-need-asked-1-/), run: { jobId: JOB.id, step: (started as { id: string }).id, template: 'asked-1' } }]);
    await go(await s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'true', outputs: [], secrets: [] }));
    expect(runs[1]!.box).not.toBe(runs[0]!.box);
  });

  it('with an approved plan, its changes are minted too', async () => {
    const { s, minted } = boxSteps([READY]);
    await go(await s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'terraform apply', outputs: [], secrets: [], plan: PLAN }));
    expect(minted).toEqual([READ, WRITE]);
  });

  it('a template the job has no approved sandbox of, a --secret, or a template not ready now is refused', async () => {
    const { s, runs, events } = boxSteps([READY, { ...READY, name: 'asked-2', pending: { image: false, profiles: [WRITE] } } as unknown as TemplateView]);
    expect(await s.box(JOB, { box: 'asked-1', approved: [], command: 'true', outputs: [], secrets: [] }))
      .toEqual({ status: 404, no: expect.stringContaining('this job has no approved sandbox of template asked-1. It has none') });
    expect(await s.box(JOB, { box: 'asked-1', approved: ['asked-1'], command: 'true', outputs: [], secrets: ['AWS_KEY'] }))
      .toEqual({ status: 400, no: expect.stringContaining('a box step takes no --secret') });
    expect(await s.box(JOB, { box: 'asked-2', approved: ['asked-2'], command: 'true', outputs: [], secrets: [] }))
      .toEqual({ status: 409, no: expect.stringContaining('template asked-2 is not ready now') });
    expect(runs).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['step.refused', 'step.refused', 'step.refused']);
  });
});
