// Issue #2146 (the bastion path, part 6): a bastion's vault secrets and its reads. The job names vault secrets the
// template gives; each is read for the bastion's box after the job's vault grant and goes in as a header file, never in
// its environment. A bastion read is a relay connection whose command is curl in the box: Access decides it, its POST
// body goes on stdin, its answer is the target's status and body, and it is an event on the job's timeline. The vault,
// Access and the need box are doubles at their seams.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { BoxPipe } from '../../src/domain/sandboxes.ts';
import type { NeedBox, NeedBoxIo, NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { parseTargets, type BastionTarget } from '../../src/sandbox/bastion.ts';
import { readCommand, READ_MAX_BYTES } from '../../src/sandbox/bastion-read.ts';
import { createBastions, type BastionsOptions } from '../../src/sandbox/bastions.ts';

const GRAFANA = 'utility/monitoring/svc/grafana:80';
const TEMPLATE = {
  name: 'observe-utility', image: 'img', profiles: [{ operation: 'observe', asset: { kind: 'namespace', name: 'utility/monitoring' } }], bastionTargets: [GRAFANA],
  pending: { bastionTargets: [] }, gives: ['grafana-viewer'],
} as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const TARGETS = parseTargets(GRAFANA) as BastionTarget[];

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

/** A command in the box: what it was given on stdin, and it answers `out` once its stdin ends. */
function box(out: Buffer | string, stderr = '') {
  const started: { cmd: readonly string[]; input: string }[] = [];
  const pipe = async (cmd: readonly string[]): Promise<BoxPipe> => {
    const run = { cmd, input: '' };
    started.push(run);
    const d = new Duplex({
      read() {},
      write(chunk: Buffer, _e, done) { run.input += chunk.toString(); done(); },
      final(done) { d.push(out); d.push(null); done(); },
    });
    return Object.assign(d, { stderr: () => stderr }) as unknown as BoxPipe;
  };
  return { started, pipe };
}

function bastions(o: Partial<BastionsOptions> & { pipe?: (cmd: readonly string[]) => Promise<BoxPipe> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bastion-reads-'));
  dirs.push(dir);
  const events: NewEvent[] = [];
  const boxes: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>[] = [];
  const asked: string[] = [];
  const run = async (b: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>, io: Omit<NeedBoxIo, 'phases'>): Promise<NeedBoxResult> => {
    boxes.push(b);
    // Each forward listens, as kubectl says in the box (issue #2484: a read waits for that).
    io.log([...(b.env.HOPPER_STEP_COMMAND ?? '').matchAll(/ '([^']+)' &$/gm)].map((m, i) => `[${m[1]}] Forwarding from 127.0.0.1:${20000 + i} -> remote\n`).join(''));
    io.running?.({ renew: async () => {}, ...(o.pipe ? { pipe: o.pipe } : {}) });
    await new Promise((r) => { io.signal.addEventListener('abort', r, { once: true }); });
    return { exit: 125, problem: 'stopped', stopped: 'cancelled' };
  };
  const b = createBastions({
    userId: 'u1', dir, run, record: (e) => { events.push(e); }, log: () => {}, atWork: () => true,
    mint: async () => ({ minted: { kind: 'kube', token: 'kube-token', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://utility.example:6443' } }),
    release: async () => {}, mayRelay: async () => ({ allowed: true, reason: 'job:u1/job-1 may relay' }),
    secret: async (a) => { asked.push(`${a.name} ${a.job} ${a.host} ${a.template}`); return { value: 'glsa_viewer\n' }; },
    ...o,
  });
  ended.push(() => b.stopAll());
  return { b, events, boxes, asked };
}

describe('a bastion\'s vault secrets (issue #2146, part 6)', () => {
  it('reads each one for its box after the job\'s grant and copies it in as a header file, never in its environment', async () => {
    const { b, boxes, asked, events } = bastions();
    const v = await b.start(JOB, TEMPLATE, TARGETS, ['grafana-viewer']);
    if ('no' in v) throw new Error(v.no);
    expect(v.secrets).toEqual(['grafana-viewer']);
    await until(() => boxes.length === 1);
    expect(asked).toEqual([`grafana-viewer job-1 ${v.box} observe-utility`]);
    expect(boxes[0]!.files?.secrets).toEqual({ 'kube-utility-monitoring': 'kube-token', 'read-grafana-viewer': 'Authorization: Bearer glsa_viewer\n' });
    expect(JSON.stringify(boxes[0]!.env)).not.toContain('glsa_viewer');
    expect(events[0]).toMatchObject({ type: 'bastion.started', data: { secrets: ['grafana-viewer'] } });
    expect(JSON.stringify(events)).not.toContain('glsa_viewer');
  });

  it('refuses a secret the template does not give, or one the vault refuses (no grant); nothing starts', async () => {
    const { b, boxes } = bastions({ secret: async () => ({ refused: 'job job-1 has no vault grant: a person grants it the vault on Access requests, then ask again' }) });
    expect(await b.start(JOB, TEMPLATE, TARGETS, ['other'])).toEqual({ status: 403, no: 'template observe-utility does not give other now: ask for a template with --secrets "other", which a person approves' });
    expect(await b.start(JOB, TEMPLATE, TARGETS, ['grafana-viewer'])).toEqual({
      status: 403, no: 'the vault gave no grafana-viewer: job job-1 has no vault grant: a person grants it the vault on Access requests, then ask again',
    });
    expect(boxes).toEqual([]);
  });

  it('is part of what makes the same bastion: other secrets while one runs are a 409', async () => {
    const { b } = bastions();
    const first = await b.start(JOB, TEMPLATE, TARGETS, ['grafana-viewer']);
    expect(await b.start(JOB, TEMPLATE, TARGETS, ['grafana-viewer'])).toEqual(first);
    expect(await b.start(JOB, TEMPLATE, TARGETS)).toMatchObject({ status: 409 });
  });
});

describe('a bastion read (issue #2146, part 6)', () => {
  const running = async (o: Parameters<typeof bastions>[0]) => {
    const t = bastions(o);
    await t.b.start(JOB, TEMPLATE, TARGETS, ['grafana-viewer']);
    await until(() => t.b.of('job-1')?.state === 'running');
    return t;
  };

  it('runs curl in the box on the target\'s port with the secret\'s file, and answers the status and body', async () => {
    const c = box('[{"uid":"abc"}]\n200');
    const { b, events } = await running({ pipe: c.pipe });
    const r = { target: GRAFANA, path: '/api/search?query=latency', method: 'GET' as const, secret: 'grafana-viewer' };
    expect(await b.read('job-1', r)).toEqual({ status: 200, body: Buffer.from('[{"uid":"abc"}]') });
    expect(c.started).toEqual([{ cmd: readCommand(20000, r), input: '' }]);
    await until(() => events.some((e) => e.type === 'bastion.relayed'));
    expect(events.find((e) => e.type === 'bastion.read')).toMatchObject({
      jobId: 'job-1', data: { target: GRAFANA, method: 'GET', path: '/api/search?query=latency', status: 200, bytes: 15 },
    });
  });

  it('sends a POST\'s body on the command\'s stdin', async () => {
    const c = box('{"results":{}}\n200');
    const { b } = await running({ pipe: c.pipe });
    await b.read('job-1', { target: GRAFANA, path: '/api/ds/query', method: 'POST', data: '{"queries":[]}', secret: 'grafana-viewer' });
    expect(c.started[0]!.input).toBe('{"queries":[]}');
  });

  it('says no for a secret the bastion does not hold, an answer too big, and a command that gave no status', async () => {
    const big = await running({ pipe: box(Buffer.alloc(READ_MAX_BYTES + 100, 0x61)).pipe });
    expect(await big.b.read('job-1', { target: GRAFANA, path: '/x', method: 'GET', secret: 'other' })).toMatchObject({ status: 404, no: expect.stringContaining('holds no vault secret other') });
    expect(await big.b.read('job-1', { target: GRAFANA, path: '/x', method: 'GET' })).toMatchObject({ status: 413, no: expect.stringContaining('over 2097152 bytes') });
    const failing = await running({ pipe: box('\n000', 'curl: (7) Failed to connect to 127.0.0.1 port 20000').pipe });
    expect(await failing.b.read('job-1', { target: GRAFANA, path: '/x', method: 'GET' })).toEqual({
      status: 502, no: `the read of ${GRAFANA}/x in the box gave no answer: curl: (7) Failed to connect to 127.0.0.1 port 20000`,
    });
    expect(failing.events.find((e) => e.type === 'bastion.read')?.data).toMatchObject({ problem: 'curl: (7) Failed to connect to 127.0.0.1 port 20000' });
  });

  it('is a relay connection: Access decides it, and a denied one starts no command', async () => {
    const c = box('{}\n200');
    const { b } = await running({ pipe: c.pipe, mayRelay: async () => ({ allowed: false, reason: 'not approved' }) });
    expect(await b.read('job-1', { target: GRAFANA, path: '/x', method: 'GET' })).toEqual({ status: 403, no: `Access denies the relay to ${GRAFANA}: not approved` });
    expect(c.started).toEqual([]);
  });
});
