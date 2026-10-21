// Issue #2272: while the user's sandbox host is set and none of its machines is online, a need step waits — before
// anything is minted, so no credential exists for a box that has nowhere to run —, its log saying "sandbox host <name> is
// offline", and it never starts on another machine. Once the host is back, the step runs. A step whose job stops while it
// waits ends cancelled; one whose saga is stopped meanwhile mints nothing and runs nothing, and its saga goes on later.
// Each step is kept in the real database; the vault's mint, the sandbox host and the need box are doubles at their seams.
//
// Feature: a step waits for its sandbox host
//   Scenario: a step waits while the sandbox host is offline, says so, and runs once it is back
//   Scenario: a step whose job stops while it waits ends cancelled, with nothing minted
//   Scenario: a step stopped while it waits mints nothing and runs nothing
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createNeedSteps } from '../../src/sandbox/need-steps.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { useTempStore } from '../store/helpers.ts';

const READ: OperationProfile = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/reader' } };
const TEMPLATE = { name: 'reader', image: 'img', profiles: [READ] } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const AWS = { minted: { kind: 'aws' as const, AccessKeyId: 'ASIA', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: '2030-01-01T00:15:00Z' }, reach: { kind: 'aws' as const, region: 'eu-west-1' } };

const temp = useTempStore();
const dirs: string[] = [];
const stores: InstanceStore[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of stores.splice(0)) s.close();
});

function setup(offline: () => string | undefined, atWork: () => boolean = () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'need-host-'));
  dirs.push(dir);
  const store = openInstanceStore({ url: temp.url(), clock: { now: () => new Date() } });
  stores.push(store);
  const mints: string[] = [], ran: string[] = [];
  const s = createNeedSteps({
    userId: 'admin', dir, record: () => {}, log: () => {}, planFile: () => undefined, steps: store.needSteps,
    ran: (step) => store.sandboxRuns.get(step) !== undefined, atWork: () => atWork(),
    sagas: { begin: (step) => `saga-${step}`, abort: () => true }, templates: () => [TEMPLATE],
    mint: async (a) => { mints.push(a.step); return AWS; },
    run: async (box) => { ran.push(box.name); return { exit: 0 }; },
    hostOffline: async () => offline(), hostWaitMs: 10,
  });
  const started = s.start(JOB, { template: TEMPLATE, needs: [READ], command: 'aws sts get-caller-identity', outputs: [] }, { key: 'key-0001', inputs: Buffer.alloc(0) });
  if (!('id' in started)) throw new Error(started.no);
  return { s, id: started.id, mints, ran };
}

describe('a step waits for its sandbox host (issue #2272)', () => {
  it('a step waits while the sandbox host is offline, says so, and runs once it is back', async () => {
    let looks = 0;
    const { s, id, mints, ran } = setup(() => (++looks <= 3 ? 'sandbox host vm is offline' : undefined));
    await s.run(id, new AbortController().signal);
    expect(looks).toBe(4);
    expect(mints).toHaveLength(1);
    expect(ran).toHaveLength(1);
    const log = s.log(JOB, id, 0)!.text;
    // Said once per wait, then that it starts.
    expect(log.match(/sandbox host vm is offline/g)).toHaveLength(1);
    expect(log).toContain('hopper: sandbox host vm is offline: the step waits for it, and never starts on another machine');
    expect(log).toContain('hopper: the sandbox host is online: the step starts');
    expect(s.state(JOB, id)).toMatchObject({ result: { exit: 0 } });
  });

  it('a step whose job stops while it waits ends cancelled, with nothing minted', async () => {
    let looks = 0;
    const { s, id, mints, ran } = setup(() => 'sandbox host vm is offline', () => ++looks < 3);
    await s.run(id, new AbortController().signal);
    expect(mints).toEqual([]);
    expect(ran).toEqual([]);
    expect(s.state(JOB, id)).toMatchObject({ result: { exit: 125, problem: 'cancelled: job job-1 is not at work' } });
  });

  it('a step stopped while it waits mints nothing and runs nothing', async () => {
    const { s, id, mints, ran } = setup(() => 'sandbox host vm is offline');
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error('the hopper stops')), 30);
    await expect(s.run(id, stop.signal)).rejects.toThrow('the hopper stops');
    expect(mints).toEqual([]);
    expect(ran).toEqual([]);
    // Not ended: its saga runs it again on any host.
    expect(s.state(JOB, id)).toMatchObject({ running: true });
  });
});
