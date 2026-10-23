// Issue #2146 (the bastion path, part 1): a user's bastions. A job of an approved sandbox request starts one bastion of a
// template with an observe on each target: the vault mints each observe for the bastion's box, the box starts with the
// tokens as files, and the hopper mints them again while it runs. It ends when its TTL passes, when its job ends, when
// the job stops it, or when a mint is refused; its tokens are released, and each start and end is an event on the job's
// timeline. Part 2: a job's relay connection to one of its targets is a pipe to the connect command in the box, which
// keeps it from expiring while it is open and ends with it. Part 3: a bastion forwards only to targets approved with its
// template; Access decides each connection, and each connection, or its refusal, is an event on the job's timeline. The
// vault's mint, Access and the need box are doubles at their seams.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { PassThrough } from 'node:stream';
import type { BoxPipe } from '../../src/domain/sandboxes.ts';
import type { NeedBox, NeedBoxIo, NeedBoxResult, RunningNeedBox } from '../../src/sandbox/need-box.ts';
import { parseTargets, relayCommand, type BastionTarget } from '../../src/sandbox/bastion.ts';
import { createBastions, type BastionsOptions } from '../../src/sandbox/bastions.ts';

const MONITORING: OperationProfile = { operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } };
const APPROVED = ['uat/monitoring/svc/grafana:80', 'uat/monitoring/svc/prometheus-server:9090'];
const TEMPLATE = { name: 'observe-uat', image: 'img', tools: ['kubectl'], profiles: [MONITORING], bastionTargets: APPROVED, pending: { bastionTargets: [] } } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const TARGETS = parseTargets('uat/monitoring/svc/prometheus-server:9090 uat/monitoring/svc/grafana:80') as BastionTarget[];
const SERVER = { kind: 'kube' as const, server: 'https://uat.example:6443' };

const dirs: string[] = [];
const ended: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of ended.splice(0)) await stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !what(); i++) await tick(10);
  expect(what()).toBe(true);
};

/** What kubectl says in the box once each forward of its command listens. */
const listening = (box: { env: Record<string, string> }): string =>
  [...(box.env.HOPPER_STEP_COMMAND ?? '').matchAll(/ '([^']+)' &$/gm)].map((m, i) => `[${m[1]}] Forwarding from 127.0.0.1:${20000 + i} -> remote\n`).join('');

/** Bastions with the box a double that runs until it is stopped, and a mint that counts. */
function bastions(o: Partial<BastionsOptions> & { pipe?: RunningNeedBox['pipe'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bastions-'));
  dirs.push(dir);
  const events: NewEvent[] = [];
  const released: string[] = [];
  const boxes: { box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>; renewed: Record<string, string>[] }[] = [];
  let minted = 0;
  let atWork = true;
  const run = async (box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: Omit<NeedBoxIo, 'phases'>): Promise<NeedBoxResult> => {
    const b = { box, renewed: [] as Record<string, string>[] };
    boxes.push(b);
    io.log(`hopper-bastion: forwarding 2 targets\n${listening(box)}`);
    io.running?.({ renew: async (secrets) => { b.renewed.push(secrets); }, ...(o.pipe ? { pipe: o.pipe } : {}) });
    await new Promise((r) => { io.signal.addEventListener('abort', r, { once: true }); });
    return { exit: 125, problem: 'the job stopped waiting for it', stopped: 'cancelled' };
  };
  const b = createBastions({
    userId: 'u1', dir, run, record: (e) => { events.push(e); }, log: () => {}, atWork: () => atWork,
    mint: async () => ({ minted: { kind: 'kube', token: `token-${++minted}`, expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: SERVER }),
    release: async (box) => { released.push(box); },
    mayRelay: async () => ({ allowed: true, reason: 'job:u1/job-1 may relay' }),
    ttlMs: 60_000, renewMs: 60_000, checkMs: 10,
    ...o,
  });
  ended.push(() => b.stopAll());
  return { b, events, released, boxes, minted: () => minted, leave: () => { atWork = false; } };
}

describe('a bastion (issue #2146)', () => {
  it('starts one box of the template with each observe minted for it, its tokens as files, each target on a port kubectl picks', async () => {
    const { b, events, boxes, minted } = bastions();
    const r = await b.start(JOB, TEMPLATE, TARGETS);
    if ('no' in r) throw new Error(r.no);
    expect(r).toMatchObject({ jobId: 'job-1', template: 'observe-uat', targets: [{ target: 'uat/monitoring/svc/prometheus-server:9090' }, { target: 'uat/monitoring/svc/grafana:80' }] });
    expect(minted()).toBe(1);
    await until(() => b.of('job-1')?.state === 'running');
    expect(b.of('job-1')?.targets.map((t) => t.local)).toEqual([20000, 20001]);
    const [{ box }] = boxes as [typeof boxes[number]];
    expect(box.name).toBe(r.box);
    expect(box.files).toEqual({ secrets: { 'kube-uat-monitoring': 'token-1' } });
    expect(box.env.HOPPER_STEP_COMMAND).toContain('svc/prometheus-server');
    expect(box.env.HOPPER_STEP_KUBECONFIG).not.toContain('token-1');
    expect(events.map((e) => e.type)).toEqual(['bastion.started']);
    expect(events[0]).toMatchObject({ jobId: 'job-1', data: { bastion: r.id, template: 'observe-uat', box: r.box, targets: ['uat/monitoring/svc/prometheus-server:9090', 'uat/monitoring/svc/grafana:80'] } });
    expect(b.of('job-1')?.log).toContain('forwarding 2 targets');
  });

  it('names where its tokens reach (part 5): a read-only template\'s box runs behind the egress proxy, which lets the cluster through', async () => {
    const { b, boxes } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => boxes.length === 1);
    expect(boxes[0]!.box.reaches).toEqual([SERVER]);
  });

  it('one bastion a job: the same ask again is the same bastion; another is refused while the first runs', async () => {
    const { b, boxes } = bastions();
    const first = await b.start(JOB, TEMPLATE, TARGETS);
    expect(await b.start(JOB, TEMPLATE, [...TARGETS].reverse())).toEqual(first);
    const other = await b.start(JOB, TEMPLATE, TARGETS.slice(0, 1));
    expect(other).toMatchObject({ status: 409 });
    expect((other as { no: string }).no).toMatch(/^this job's bastion .* runs: stop it first/);
    expect(boxes).toHaveLength(1);
  });

  it('refuses a target no observe of the template reaches, and a mint the vault refuses; nothing starts and nothing stays held', async () => {
    const { b, boxes, released, events } = bastions({ mint: async () => ({ refused: 'Access denied it' }) });
    expect(await b.start(JOB, TEMPLATE, parseTargets('prod/monitoring/svc/grafana:80') as BastionTarget[])).toMatchObject({ status: 400 });
    const r = await b.start(JOB, TEMPLATE, TARGETS);
    expect(r).toEqual({ status: 403, no: 'the vault minted no observe on namespace uat/monitoring: Access denied it' });
    expect(boxes).toHaveLength(0);
    expect(released).toHaveLength(1);
    expect(b.of('job-1')).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('mints its tokens again while it runs, and copies them into the box', async () => {
    const { b, boxes, minted } = bastions({ renewMs: 30 });
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => (boxes[0]?.renewed.length ?? 0) >= 2);
    expect(boxes[0]!.renewed[0]).toEqual({ 'kube-uat-monitoring': 'token-2' });
    expect(minted()).toBeGreaterThanOrEqual(3);
  });

  it('ends when a renewal is refused: its tokens are released, and the end says why', async () => {
    let n = 0;
    const { b, events, released } = bastions({
      renewMs: 30, mint: async () => (++n === 1 ? { minted: { kind: 'kube', token: 't', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: SERVER } : { refused: 'the job is not at work' }),
    });
    const r = await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'ended');
    expect(b.of('job-1')).toMatchObject({ ended: 'failed', problem: 'the vault minted no observe on namespace uat/monitoring: the job is not at work' });
    expect(released).toEqual([(r as { box: string }).box]);
    expect(events.at(-1)).toMatchObject({ type: 'bastion.ended', data: { reason: 'failed', problem: 'the vault minted no observe on namespace uat/monitoring: the job is not at work' } });
  });

  it('ends when its TTL passes with no use; a use renews it', async () => {
    const { b, events } = bastions({ ttlMs: 150 });
    await b.start(JOB, TEMPLATE, TARGETS);
    await tick(100);
    b.touch('job-1');
    await tick(100);
    expect(b.of('job-1')?.state).not.toBe('ended');
    await until(() => b.of('job-1')?.state === 'ended');
    expect(b.of('job-1')?.ended).toBe('expired');
    expect(events.at(-1)).toMatchObject({ type: 'bastion.ended', jobId: 'job-1', data: { reason: 'expired' } });
  });

  it('ends with its job', async () => {
    const { b, leave } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    leave();
    await until(() => b.of('job-1')?.state === 'ended');
    expect(b.of('job-1')?.ended).toBe('job-ended');
  });

  it('the job stops it: it ends, its tokens are released, and the next ask starts a new one', async () => {
    const { b, released, boxes } = bastions();
    const first = await b.start(JOB, TEMPLATE, TARGETS) as { id: string; box: string };
    expect(b.stop('job-1', 'job')?.id).toBe(first.id);
    await until(() => b.of('job-1')?.state === 'ended');
    expect(b.of('job-1')).toMatchObject({ ended: 'stopped', endedBy: 'job' });
    await until(() => released.length === 1);
    expect(released).toEqual([first.box]);
    const second = await b.start(JOB, TEMPLATE, TARGETS) as { id: string };
    expect(second.id).not.toBe(first.id);
    expect(boxes).toHaveLength(2);
    expect(b.stop('job-2', 'job')).toBeUndefined();
  });

  it('lists each bastion that runs, for a person; one that ended leaves the list (a person\'s stop)', async () => {
    const { b, events } = bastions();
    expect(b.list()).toEqual([]);
    const first = await b.start(JOB, TEMPLATE, TARGETS) as { id: string };
    const other = await b.start({ ...JOB, id: 'job-2' } as Job, TEMPLATE, TARGETS.slice(0, 1)) as { id: string };
    await until(() => b.list().every((v) => v.state === 'running'));
    expect(b.list().map((v) => [v.jobId, v.id])).toEqual([['job-1', first.id], ['job-2', other.id]]);
    b.list()[0]!.targets[0]!.local = 1;
    expect(b.of('job-1')?.targets[0]?.local).toBe(20000);
    expect(b.stop('job-1', 'a person')?.id).toBe(first.id);
    await until(() => b.list().length === 1);
    expect(b.list()[0]?.jobId).toBe('job-2');
    await until(() => events.some((e) => e.type === 'bastion.ended'));
    expect(events.find((e) => e.type === 'bastion.ended')?.data).toMatchObject({ bastion: first.id, reason: 'stopped', by: 'a person' });
  });

  it('a hopper that runs no sandbox starts none', async () => {
    const { b } = bastions({ run: undefined });
    expect(await b.start(JOB, TEMPLATE, TARGETS)).toMatchObject({ status: 503 });
  });
});

/** A box's pipe double: what the relay writes, and the command it started. */
function pipes() {
  const started: (readonly string[])[] = [];
  const opened: BoxPipe[] = [];
  const pipe = async (cmd: readonly string[]): Promise<BoxPipe> => {
    started.push(cmd);
    const p = Object.assign(new PassThrough(), { stderr: () => '' }) as unknown as BoxPipe;
    opened.push(p);
    return p;
  };
  return { started, opened, pipe };
}

describe('the relay to a bastion (issue #2146, part 2)', () => {
  it('pipes a connection to the target\'s forward in the box, through the connect command', async () => {
    const p = pipes();
    const { b } = bastions({ pipe: p.pipe });
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    const r = await b.relay('job-1', 'uat/monitoring/svc/grafana:80');
    expect('no' in r).toBe(false);
    expect(p.started).toEqual([relayCommand(20001)]);
    const echoed = new Promise((resolve) => (r as BoxPipe).once('data', (d: Buffer) => resolve(d.toString())));
    (r as BoxPipe).write('GET / HTTP/1.1\r\n\r\n');
    expect(await echoed).toBe('GET / HTTP/1.1\r\n\r\n');
  });

  it('says no for a job with no bastion, a target it does not forward to, and a bastion that is not running yet', async () => {
    const p = pipes();
    const { b } = bastions({ pipe: p.pipe });
    expect(await b.relay('job-1', 'uat/monitoring/svc/grafana:80')).toMatchObject({ status: 404, no: expect.stringMatching(/^this job has no bastion that runs/) });
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    expect(await b.relay('job-1', 'uat/monitoring/svc/loki:3100')).toEqual({
      status: 404, no: 'the job\'s bastion forwards to uat/monitoring/svc/prometheus-server:9090, uat/monitoring/svc/grafana:80; not to uat/monitoring/svc/loki:3100',
    });
    expect(await b.relay('job-2', 'uat/monitoring/svc/grafana:80')).toMatchObject({ status: 404 });
    expect(p.started).toEqual([]);
  });

  it('says no when the box\'s runtime starts no command, and when the start fails', async () => {
    const none = bastions();
    await none.b.start(JOB, TEMPLATE, TARGETS);
    await until(() => none.b.of('job-1')?.state === 'running');
    expect(await none.b.relay('job-1', 'uat/monitoring/svc/grafana:80')).toMatchObject({ status: 503 });
    const failing = bastions({ pipe: async () => { throw new Error('podman refused to start a command in the box (500): oops'); } });
    await failing.b.start(JOB, TEMPLATE, TARGETS);
    await until(() => failing.b.of('job-1')?.state === 'running');
    expect(await failing.b.relay('job-1', 'uat/monitoring/svc/grafana:80')).toEqual({
      status: 502, no: 'the relay did not reach uat/monitoring/svc/grafana:80 in the box: podman refused to start a command in the box (500): oops',
    });
  });

  it('does not expire while a connection is open; a closed one starts its TTL again', async () => {
    const p = pipes();
    const { b } = bastions({ pipe: p.pipe, ttlMs: 100 });
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    const r = await b.relay('job-1', 'uat/monitoring/svc/grafana:80') as BoxPipe;
    await tick(250);
    expect(b.of('job-1')?.state).toBe('running');
    r.destroy();
    await tick(50);
    expect(b.of('job-1')?.state).toBe('running');
    await until(() => b.of('job-1')?.state === 'ended');
    expect(b.of('job-1')?.ended).toBe('expired');
  });

  it('closes each open connection when it ends', async () => {
    const p = pipes();
    const { b } = bastions({ pipe: p.pipe });
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    const r = await b.relay('job-1', 'uat/monitoring/svc/grafana:80') as BoxPipe;
    b.stop('job-1', 'job');
    await until(() => b.of('job-1')?.state === 'ended');
    expect(r.destroyed).toBe(true);
    expect(await b.relay('job-1', 'uat/monitoring/svc/grafana:80')).toMatchObject({ status: 404 });
  });
});

describe('targets approved with the template, and Access for each connection (issue #2146, part 3)', () => {
  it('starts no bastion to a target the template does not name, or names but a person has not approved yet', async () => {
    const { b, boxes, minted } = bastions();
    const loki = parseTargets('uat/monitoring/svc/loki:3100') as BastionTarget[];
    expect(await b.start(JOB, TEMPLATE, loki)).toEqual({
      status: 403, no: 'template observe-uat names no bastion target uat/monitoring/svc/loki:3100: ask for a template with --targets "uat/monitoring/svc/loki:3100"',
    });
    const waiting = { ...TEMPLATE, bastionTargets: [...APPROVED, 'uat/monitoring/svc/loki:3100'], pending: { bastionTargets: ['uat/monitoring/svc/loki:3100'] } } as unknown as TemplateView;
    expect(await b.start(JOB, waiting, loki)).toEqual({
      status: 403, no: 'the bastion target uat/monitoring/svc/loki:3100 of template observe-uat waits for a person to approve it on Access requests',
    });
    expect(boxes).toEqual([]);
    expect(minted()).toBe(0);
  });

  it('asks Access for each connection, and records it when it closes', async () => {
    const p = pipes();
    const asked: unknown[] = [];
    let now = Date.parse('2026-10-20T12:00:00.000Z');
    const { b, events } = bastions({ pipe: p.pipe, now: () => new Date(now), mayRelay: async (a) => { asked.push(a); return { allowed: true, reason: 'job:u1/job-1 may relay' }; } });
    const r = await b.start(JOB, TEMPLATE, TARGETS);
    if ('no' in r) throw new Error(r.no);
    await until(() => b.of('job-1')?.state === 'running');
    const pipe = await b.relay('job-1', 'uat/monitoring/svc/grafana:80') as BoxPipe;
    expect(asked).toEqual([{ jobId: 'job-1', template: 'observe-uat', target: 'uat/monitoring/svc/grafana:80' }]);
    now += 1500;
    pipe.destroy();
    await until(() => events.some((e) => e.type === 'bastion.relayed'));
    expect(events.find((e) => e.type === 'bastion.relayed')).toEqual({
      type: 'bastion.relayed', jobId: 'job-1',
      data: { bastion: r.id, target: 'uat/monitoring/svc/grafana:80', openedAt: '2026-10-20T12:00:00.000Z', ms: 1500 },
    });
  });

  it('refuses a connection Access denies, starts no command for it, and records the refusal', async () => {
    const p = pipes();
    const { b, events } = bastions({ pipe: p.pipe, mayRelay: async () => ({ allowed: false, reason: 'job:u1/job-1 may not relay to uat/monitoring/svc/grafana:80' }) });
    const r = await b.start(JOB, TEMPLATE, TARGETS);
    if ('no' in r) throw new Error(r.no);
    await until(() => b.of('job-1')?.state === 'running');
    expect(await b.relay('job-1', 'uat/monitoring/svc/grafana:80')).toEqual({
      status: 403, no: 'Access denies the relay to uat/monitoring/svc/grafana:80: job:u1/job-1 may not relay to uat/monitoring/svc/grafana:80',
    });
    expect(p.started).toEqual([]);
    expect(events.find((e) => e.type === 'bastion.relay_refused')).toEqual({
      type: 'bastion.relay_refused', jobId: 'job-1',
      data: { bastion: r.id, target: 'uat/monitoring/svc/grafana:80', reason: 'job:u1/job-1 may not relay to uat/monitoring/svc/grafana:80' },
    });
  });
});
