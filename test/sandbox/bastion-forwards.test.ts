// Issue #2413: a bastion said "running" and listed its forwards, while each forward's kubectl failed in the box and
// nothing listened; every read answered only curl's "Failed to connect". The hopper now reads each forward's lines in
// the bastion's output: a forward listens once kubectl says "Forwarding from", and stops when its loop says it ended,
// with the last thing kubectl said. The job sees it in `bastion` and in a relay or read to a forward that does not
// listen, which starts no command in the box. The vault's mint, Access and the need box are doubles at their seams.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { BoxPipe } from '../../src/domain/sandboxes.ts';
import type { Job } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { forwardWatch, parseTargets, type BastionTarget } from '../../src/sandbox/bastion.ts';
import { createBastions } from '../../src/sandbox/bastions.ts';
import type { NeedBoxIo, NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { bastionText } from '../../src/skills/bastion-skill.ts';

const PROM = 'utility/monitoring/svc/prometheus:9090';
const GRAFANA = 'utility/monitoring/svc/grafana:80';
const MONITORING: OperationProfile = { operation: 'observe', asset: { kind: 'namespace', name: 'utility/monitoring' } };
const TEMPLATE = { name: 'observe-utility', image: 'img', tools: ['kubectl'], profiles: [MONITORING], bastionTargets: [PROM, GRAFANA], pending: { bastionTargets: [] } } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const TARGETS = parseTargets(`${PROM} ${GRAFANA}`) as BastionTarget[];
const FORBIDDEN = 'error: error upgrading connection: pods "prometheus-0" is forbidden: User "hopper-observe" cannot create resource "pods/portforward" in API group "" in the namespace "monitoring"';

describe('what the bastion\'s output says of each forward (issue #2413)', () => {
  it('a forward listens once kubectl says so; connections it handles change nothing', () => {
    const w = forwardWatch();
    expect(w.of(PROM)).toBeUndefined();
    w.add(`[${PROM}] Forwarding from 127.0.0.1:20000 -> 9090\r\n[${PROM}] Handling connection for 20000\n`);
    expect(w.of(PROM)).toEqual({ listening: true, local: 20000 });
    expect(w.of(GRAFANA)).toBeUndefined();
  });

  it('a forward listens once kubectl says so, before the new line of that line comes (issue #2484)', () => {
    const w = forwardWatch();
    w.add(`hopper-bastion: forwarding 2 targets\n[${PROM}] Forwarding from 127.0.0.1:20000 -> 9090`);
    expect(w.of(PROM)).toEqual({ listening: true, local: 20000 });
    w.add(`\n[${GRAFANA}] Forwarding from 127.0.0.1:20001`);
    expect(w.of(GRAFANA)).toEqual({ listening: true });
    w.add(` -> 80\n[${PROM}] ${FORBIDDEN}\n[${PROM}] the forward ended: it starts again in 2 s`);
    expect(w.of(GRAFANA)).toEqual({ listening: true, local: 20001 });
    expect(w.of(PROM)).toEqual({ listening: true, local: 20000 });
    w.add('\n');
    expect(w.of(PROM)).toEqual({ listening: false, said: FORBIDDEN });
  });

  it('a forward that ended does not listen, and keeps the last thing kubectl said, also from lines cut over two chunks', () => {
    const w = forwardWatch();
    w.add(`[${PROM}] Forwarding from 127.0.0.1:20000 -> 9090\n[${PROM}] ${FORBIDDEN.slice(0, 30)}`);
    w.add(`${FORBIDDEN.slice(30)}\n[${PROM}] the forward ended: it starts again in 2 s\n`);
    expect(w.of(PROM)).toEqual({ listening: false, said: FORBIDDEN });
  });

  it('a forward that ended with no word of kubectl says that it ended; one that listens again forgets the error', () => {
    const w = forwardWatch();
    w.add(`sh: kubectl: not found\n[${GRAFANA}] the forward ended: it starts again in 2 s\n`);
    expect(w.of(GRAFANA)).toEqual({ listening: false, said: 'the forward ended: it starts again in 2 s' });
    w.add(`[${GRAFANA}] Forwarding from 127.0.0.1:20001 -> 80\n`);
    expect(w.of(GRAFANA)).toEqual({ listening: true, local: 20001 });
  });
});

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

/** Bastions whose box is a double the test writes the output of; each command started in it is an echo pipe. */
function bastions() {
  const dir = mkdtempSync(join(tmpdir(), 'bastion-forwards-'));
  dirs.push(dir);
  const started: (readonly string[])[] = [];
  let io: Omit<NeedBoxIo, 'phases'> | undefined;
  const pipe = async (cmd: readonly string[]): Promise<BoxPipe> => {
    started.push(cmd);
    return Object.assign(new PassThrough(), { stderr: () => '' }) as unknown as BoxPipe;
  };
  const b = createBastions({
    userId: 'u1', dir, record: () => {}, log: () => {}, atWork: () => true,
    run: async (_box, i): Promise<NeedBoxResult> => {
      io = i;
      i.running?.({ renew: async () => {}, pipe });
      await new Promise((r) => { i.signal.addEventListener('abort', r, { once: true }); });
      return { exit: 125, stopped: 'cancelled' };
    },
    mint: async () => ({ minted: { kind: 'kube', token: 'token-1', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://utility.example:6443' } }),
    release: async () => {}, mayRelay: async () => ({ allowed: true, reason: 'job:u1/job-1 may relay' }),
  });
  ended.push(() => b.stopAll());
  return { b, started, say: (text: string) => io!.log(text) };
}

describe('a bastion whose forward does not listen (issue #2413)', () => {
  it('shows each forward\'s state in its view and in the job\'s status, with the tail of its output', async () => {
    const { b, say } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    say(`hopper-bastion: forwarding 2 targets\n[${GRAFANA}] Forwarding from 127.0.0.1:20001 -> 80\n[${PROM}] ${FORBIDDEN}\n[${PROM}] the forward ended: it starts again in 2 s\n`);
    const v = b.of('job-1')!;
    expect(v.targets).toEqual([
      { target: PROM, listening: false, said: FORBIDDEN },
      { target: GRAFANA, local: 20001, listening: true },
    ]);
    const text = bastionText(v);
    expect(text).toContain(`${PROM} on a port kubectl picks in the box: not listening: ${FORBIDDEN}`);
    expect(text).toContain(`${GRAFANA} on 127.0.0.1:20001 in the box: listening`);
    expect(text).toContain(`Its last output:\nhopper-bastion: forwarding 2 targets\n`);
  });

  it('a forward with no word yet says so', async () => {
    const { b } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    expect(bastionText(b.of('job-1')!)).toContain(`${PROM} on a port kubectl picks in the box: not listening yet`);
  });

  it('refuses a relay or a read to a forward that does not listen, with what kubectl said, and starts no command for it', async () => {
    const { b, started, say } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    say(`[${PROM}] ${FORBIDDEN}\n[${PROM}] the forward ended: it starts again in 2 s\n[${GRAFANA}] Forwarding from 127.0.0.1:20001 -> 80\n`);
    const no = { status: 503, no: `the bastion's forward to ${PROM} does not listen in the box: ${FORBIDDEN}. Its loop starts it again every 2 s; see where it stands with sh "$HOPPER_SKILL" bastion` };
    expect(await b.relay('job-1', PROM)).toEqual(no);
    expect(await b.read('job-1', { target: PROM, method: 'GET', path: '/api/v1/query?query=up' })).toEqual(no);
    expect(started).toEqual([]);
    expect('no' in await b.relay('job-1', GRAFANA)).toBe(false);
    expect(started).toHaveLength(1);
  });
});
