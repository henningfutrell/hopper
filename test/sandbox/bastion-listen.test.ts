// Issue #2484: a job's `bastion --wait` answered a running bastion that forwards to two targets, and its first read
// right after got curl's "Failed to connect": kubectl had said nothing of either forward yet, and the hopper started the
// read's command in the box all the same. Then the job stopped the bastion and asked again: `bastion` named the old one
// as running, while the read and the relay said the job has no bastion that runs. Now a relay or a read to a forward that
// has said nothing yet waits a short time for it to listen, and is refused with "not listening yet", as `bastion` says,
// when it does not; and `bastion`, `bastion read` and the relay name the same bastion before and after a stop. The
// vault's mint, Access and the box are doubles at their seams; the ask is the real one, on the real bastions.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { BoxPipe } from '../../src/domain/sandboxes.ts';
import type { Job } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { parseTargets, type BastionTarget } from '../../src/sandbox/bastion.ts';
import { createBastions, type BastionView } from '../../src/sandbox/bastions.ts';
import type { NeedBoxIo, NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { bastionAsk, bastionText, type BastionFields } from '../../src/skills/bastion-skill.ts';

const TEMPO = 'uat/monitoring/svc/tempo:3200';
const PROM = 'uat/monitoring/svc/prometheus:9090';
const MONITORING: OperationProfile = { operation: 'observe', asset: { kind: 'namespace', name: 'uat/monitoring' } };
const TEMPLATE = {
  name: 'observe-uat', image: 'img', tools: ['kubectl'], profiles: [MONITORING], bastionTargets: [PROM, TEMPO],
  approval: { by: 'a person', at: 'now' }, pending: { egress: [], profiles: [], bastionTargets: [] }, gives: [],
} as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const TARGETS = parseTargets(`${TEMPO} ${PROM}`) as BastionTarget[];
const PATH = '/api/search/tag/resource.service.name/values';

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
 * Bastions whose boxes the test writes the output of and ends by hand (`gone`). Each command started in a box answers as
 * a read's curl does: a body, a new line and the status.
 */
function bastions(listenMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'bastion-listen-'));
  dirs.push(dir);
  const boxes: { io: Omit<NeedBoxIo, 'phases'>; gone: () => void }[] = [];
  const started: (readonly string[])[] = [];
  const pipe = async (cmd: readonly string[]): Promise<BoxPipe> => {
    started.push(cmd);
    const p = new Duplex({ read() {}, write(_c, _e, cb) { cb(); }, final(cb) { this.push('["checkout"]\n200'); this.push(null); cb(); } });
    return Object.assign(p, { stderr: () => '' }) as unknown as BoxPipe;
  };
  const b = createBastions({
    userId: 'u1', dir, record: () => {}, log: () => {}, atWork: () => true, saidMs: 0, listenMs,
    run: (_box, io) => new Promise<NeedBoxResult>((resolve) => {
      boxes.push({ io, gone: () => resolve({ exit: 125, stopped: 'cancelled' }) });
      io.running?.({ renew: async () => {}, pipe });
    }),
    mint: async () => ({ minted: { kind: 'kube', token: 'token-1', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://uat.example:6443' } }),
    release: async () => {}, mayRelay: async () => ({ allowed: true, reason: 'job:u1/job-1 may relay' }),
  });
  ended.push(async () => { const all = b.stopAll(); for (const x of boxes) x.gone(); await all; });
  const ask = (f: BastionFields) => bastionAsk({ template: (n) => (n === TEMPLATE.name ? TEMPLATE : undefined), sandbox: (template) => ({ id: 'r-1', jobId: 'job-1', template, state: 'approved', askedAt: 'now', approvedBy: 'a person' }), bastions: b }, JOB, f, {
    no: (status, reason) => ({ status, text: `no: ${reason}` }), loaded: (text) => ({ status: 200, text }), waiting: (text) => ({ status: 202, text }),
    waitingText: () => 'waiting', declinedText: () => 'declined',
  });
  const say = (box: number, text: string) => boxes[box]!.io.log(text);
  return { b, ask, say, started };
}

describe('a forward that has said nothing yet (issue #2484)', () => {
  it('a read right after the start waits for its forward to listen, then runs', async () => {
    const { b, say, started } = bastions(5_000);
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    const read = b.read('job-1', { target: TEMPO, method: 'GET', path: PATH });
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toEqual([]);
    say(0, `[${TEMPO}] Forwarding from 127.0.0.1:20000 -> 3200\n`);
    expect(await read).toEqual({ status: 200, body: Buffer.from('["checkout"]') });
    expect(started).toHaveLength(1);
  });

  it('a relay or a read to a forward that does not listen in time is refused as not listening yet, as the status says, and starts no command', async () => {
    const { b, ask, started } = bastions(100);
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    const no = { status: 503, no: `the bastion's forward to ${TEMPO} does not listen in the box yet: kubectl said nothing of it in 0.1 s. See where it stands with sh "$HOPPER_SKILL" bastion` };
    expect(await b.relay('job-1', TEMPO)).toEqual(no);
    expect(await b.read('job-1', { target: TEMPO, method: 'GET', path: PATH })).toEqual(no);
    expect(await ask({ asset: 'read', targets: TEMPO, path: PATH })).toEqual({ status: 503, text: `no: ${no.no}` });
    expect(started).toEqual([]);
    expect(bastionText(b.of('job-1')!)).toContain(`${TEMPO} on a port kubectl picks in the box: not listening yet`);
  });

  it('a forward that ends while a relay waits refuses it with what kubectl said', async () => {
    const { b, say, started } = bastions(5_000);
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    const relay = b.relay('job-1', PROM);
    say(0, `[${PROM}] error: services "prometheus" not found\n[${PROM}] the forward ended: it starts again in 2 s\n`);
    expect(await relay).toMatchObject({ status: 503, no: expect.stringContaining(`does not listen in the box: error: services "prometheus" not found`) });
    expect(started).toEqual([]);
  });
});

describe('the status, the read and the relay agree on the job\'s bastion (issue #2484)', () => {
  it('before a stop, after it, and once a new bastion runs', async () => {
    const { b, ask, say } = bastions(5_000);
    const asked = { template: TEMPLATE.name, targets: `${TEMPO} ${PROM}`, why: 'read the traces' };
    const first = (await ask(asked)).text;
    const firstId = /^bastion (\S+) of template/.exec(first)![1]!;
    await until(() => b.of('job-1')?.state === 'running');
    say(0, `[${TEMPO}] Forwarding from 127.0.0.1:20000 -> 3200\n[${PROM}] Forwarding from 127.0.0.1:20001 -> 9090\n`);
    expect((await ask({})).text).toContain(`bastion ${firstId} of template observe-uat is running`);
    expect(await ask({ asset: 'read', targets: TEMPO, path: PATH })).toEqual({ status: 200, text: '["checkout"]' });

    expect((await ask({ asset: 'stop' })).text).toMatch(new RegExp(`^stopped: bastion ${firstId} of template observe-uat ended`));
    expect((await ask({})).text).toMatch(new RegExp(`^bastion ${firstId} of template observe-uat ended`));
    expect(await ask({ asset: 'read', targets: TEMPO, path: PATH })).toMatchObject({ status: 404, text: expect.stringMatching(/^no: this job has no bastion that runs/) });
    expect(await b.relay('job-1', TEMPO)).toMatchObject({ status: 404, no: expect.stringMatching(/^this job has no bastion that runs/) });

    // The old box still goes; the next ask starts a new bastion, and each of the three names it.
    const second = (await ask(asked)).text;
    const secondId = /^bastion (\S+) of template/.exec(second)![1]!;
    expect(secondId).not.toBe(firstId);
    await until(() => b.of('job-1')?.state === 'running');
    say(1, `[${TEMPO}] Forwarding from 127.0.0.1:20000 -> 3200\n`);
    expect((await ask({ asset: 'status' })).text).toContain(`bastion ${secondId} of template observe-uat is running`);
    expect(await ask({ asset: 'read', targets: TEMPO, path: PATH })).toEqual({ status: 200, text: '["checkout"]' });
    const pipe = await b.relay('job-1', TEMPO) as BoxPipe;
    expect('no' in pipe).toBe(false);
    pipe.destroy();
    expect(b.list().map((v: BastionView) => v.id)).toEqual([secondId]);
  });
});
