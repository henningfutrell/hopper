// Issue #2474: a job's bastion reported both forwards, and every relay request got curl's "Empty reply from server":
// kubectl took each connection and its stream to the pod failed, which leaves the forward listening. Then the job
// stopped the bastion and asked for a new one: its box was still going, so the ask answered the old bastion, `bastion`
// said it runs, and the relay said the job has no bastion that runs. Now a stopped bastion ends for the job at once —
// the next ask starts a new one, which the status and the relay both read —, and a relay connection that got no answer
// says why, naming its target and what kubectl said after it opened. The vault's mint, Access and the box are doubles.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { BoxPipe } from '../../src/domain/sandboxes.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { parseTargets, type BastionTarget } from '../../src/sandbox/bastion.ts';
import { createBastions, type BastionView } from '../../src/sandbox/bastions.ts';
import type { NeedBoxIo, NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { bastionText } from '../../src/skills/bastion-skill.ts';

const PROM = 'uat/monitoring/svc/prometheus:9090';
const LOKI = 'uat/monitoring/svc/loki:3100';
const MONITORING: OperationProfile = { operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } };
const TEMPLATE = { name: 'observe-uat', image: 'img', tools: ['kubectl'], profiles: [MONITORING], bastionTargets: [LOKI, PROM], pending: { bastionTargets: [] } } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const TARGETS = parseTargets(`${PROM} ${LOKI}`) as BastionTarget[];
const STREAM_ERROR = 'E1022 14:00:00.000000 portforward.go:413] an error occurred forwarding 20000 -> 9090: error forwarding port 9090 to pod prometheus-0: connection refused';

const dirs: string[] = [];
const ended: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of ended.splice(0)) await stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const until = async (what: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !what(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(what()).toBe(true);
};

/**
 * Bastions whose boxes a test ends by hand (`gone`): a stopped box still goes until then, as a burn that takes long.
 * Each command started in a box is a pipe the test answers.
 */
function bastions() {
  const dir = mkdtempSync(join(tmpdir(), 'bastion-stop-relay-'));
  dirs.push(dir);
  const events: NewEvent[] = [];
  const released: string[] = [];
  const boxes: { name: string; io: Omit<NeedBoxIo, 'phases'>; gone: () => void }[] = [];
  const opened: BoxPipe[] = [];
  const pipe = async (): Promise<BoxPipe> => {
    const p = Object.assign(new PassThrough(), { stderr: () => '' }) as unknown as BoxPipe;
    opened.push(p);
    return p;
  };
  const b = createBastions({
    userId: 'u1', dir, record: (e) => { events.push(e); }, log: () => {}, atWork: () => true, saidMs: 0,
    run: (box, io) => new Promise<NeedBoxResult>((resolve) => {
      boxes.push({ name: box.name, io, gone: () => resolve({ exit: 125, stopped: 'cancelled' }) });
      // Each forward listens, as kubectl says in the box (issue #2484: a relay waits for that).
      io.log([...(box.env.HOPPER_STEP_COMMAND ?? '').matchAll(/ '([^']+)' &$/gm)].map((m) => `[${m[1]}] Forwarding from 127.0.0.1 -> remote\n`).join(''));
      io.running?.({ renew: async () => {}, pipe });
    }),
    mint: async () => ({ minted: { kind: 'kube', token: 'token-1', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://uat.example:6443' } }),
    release: async (box) => { released.push(box); }, mayRelay: async () => ({ allowed: true, reason: 'job:u1/job-1 may relay' }),
  });
  ended.push(async () => { const all = b.stopAll(); for (const x of boxes) x.gone(); await all; });
  return { b, events, released, boxes, opened };
}

describe('a stopped bastion, and the next one (issue #2474)', () => {
  it('ends for the job at once: the next ask starts a new bastion while the old box still goes, and the status and the relay read the new one', async () => {
    const { b, boxes, released, events } = bastions();
    const first = await b.start(JOB, TEMPLATE, TARGETS) as BastionView;
    await until(() => b.of('job-1')?.state === 'running');
    expect(b.stop('job-1', 'job')).toMatchObject({ id: first.id, state: 'ended', ended: 'stopped', endedBy: 'job' });
    expect(b.of('job-1')).toMatchObject({ id: first.id, state: 'ended' });
    expect(b.list()).toEqual([]);
    expect(await b.relay('job-1', PROM)).toMatchObject({ status: 404, no: expect.stringMatching(/^this job has no bastion that runs/) });

    const second = await b.start(JOB, TEMPLATE, TARGETS) as BastionView;
    expect(second.id).not.toBe(first.id);
    expect(boxes).toHaveLength(2);
    await until(() => b.of('job-1')?.state === 'running');
    expect(b.of('job-1')?.id).toBe(second.id);
    expect(bastionText(b.of('job-1')!)).toContain(`bastion ${second.id} of template observe-uat is running`);
    expect(b.list().map((v) => v.id)).toEqual([second.id]);
    expect('no' in await b.relay('job-1', PROM)).toBe(false);

    // The old box goes: its tokens are released and its end recorded; the new bastion still runs.
    expect(released).toEqual([]);
    boxes[0]!.gone();
    await until(() => released.length === 1);
    expect(released).toEqual([first.box]);
    expect(events.filter((e) => e.type === 'bastion.ended').map((e) => e.data)).toEqual([expect.objectContaining({ bastion: first.id, reason: 'stopped', by: 'job' })]);
    expect(b.of('job-1')).toMatchObject({ id: second.id, state: 'running' });
  });

  it('closes the stopped bastion\'s relay connections at once', async () => {
    const { b } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    const pipe = await b.relay('job-1', LOKI) as BoxPipe;
    b.stop('job-1', 'a person');
    expect(pipe.destroyed).toBe(true);
  });
});

describe('a relay connection that got no answer (issue #2474)', () => {
  it('says why: its target and what kubectl said of the forward after the connection opened', async () => {
    const { b, boxes, opened } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    boxes[0]!.io.log(`[${PROM}] Forwarding from 127.0.0.1:20000 -> 9090\n[${PROM}] an older error\n`);
    const pipe = await b.relay('job-1', PROM) as BoxPipe;
    expect(opened).toHaveLength(1);
    boxes[0]!.io.log(`[${PROM}] Handling connection for 20000\n[${PROM}] ${STREAM_ERROR}\n`);
    expect(await b.noAnswer(PROM, pipe)).toBe(`the bastion's forward to ${PROM} closed the connection with no answer: kubectl said: ${STREAM_ERROR}`);
    expect(b.of('job-1')?.targets.find((t) => t.target === PROM)?.listening).toBe(true);
  });

  it('with no word of kubectl after it opened, says the connect command\'s error, else where to look', async () => {
    const { b, boxes } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    boxes[0]!.io.log(`[${LOKI}] an older error\n`);
    const quiet = await b.relay('job-1', LOKI) as BoxPipe;
    expect(await b.noAnswer(LOKI, quiet)).toBe(`the bastion's forward to ${LOKI} closed the connection with no answer. See its output with sh "$HOPPER_SKILL" bastion`);
    const failed = Object.assign(await b.relay('job-1', LOKI) as BoxPipe, { stderr: () => 'hopper-relay: the box\'s image has no socat, bash or nc to reach 127.0.0.1:20001\n' });
    expect(await b.noAnswer(LOKI, failed)).toBe(`the bastion's forward to ${LOKI} closed the connection with no answer: hopper-relay: the box's image has no socat, bash or nc to reach 127.0.0.1:20001`);
  });
});
