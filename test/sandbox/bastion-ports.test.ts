// Issue #2566: a bastion forwarded three targets on a client machine, where a box shares the machine's network. Its
// forwards took fixed ports from 20000, and the first target, on 20000, gave only "Empty reply from server": that port of
// the machine was not the forward's. Each forward now takes a port kubectl picks free, and the relay reaches the port
// kubectl says it forwards from. The vault's mint, Access and the need box are doubles at their seams.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { BoxPipe } from '../../src/domain/sandboxes.ts';
import type { Job } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { bastionCommand, forwardWatch, parseTargets, placeTargets, relayCommand, type BastionTarget, type PlacedTarget } from '../../src/sandbox/bastion.ts';
import { createBastions } from '../../src/sandbox/bastions.ts';
import type { NeedBoxIo, NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { bastionText } from '../../src/skills/bastion-skill.ts';

const LOKI = 'lab/monitoring/svc/loki:3100';
const TEMPO = 'lab/monitoring/svc/tempo:3200';
const PROM = 'lab/monitoring/svc/prometheus:9090';
const MONITORING: OperationProfile = { operation: 'observe', asset: { kind: 'namespace', name: 'lab/monitoring' } };
const TEMPLATE = { name: 'observe-lab', image: 'img', tools: ['kubectl'], profiles: [MONITORING], bastionTargets: [LOKI, TEMPO, PROM], pending: { bastionTargets: [] } } as unknown as TemplateView;
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
const TARGETS = parseTargets(`${LOKI} ${TEMPO} ${PROM}`) as BastionTarget[];

describe('each forward takes a port kubectl picks (issue #2566)', () => {
  it('the bastion\'s command names no local port: kubectl picks a free one for each target', () => {
    const placed = (placeTargets(TARGETS, [MONITORING]) as { placed: PlacedTarget[] }).placed;
    const command = bastionCommand(placed);
    expect(command).toContain('port-forward --address 127.0.0.1 "$3" ":$4"');
    expect(command).toContain(`forward 'lab-monitoring' 'monitoring' 'svc/loki' 3100 '${LOKI}' &`);
    expect(command).not.toMatch(/2000\d/);
  });

  it('a forward\'s port is the one kubectl says it forwards from, and a new one when it starts again', () => {
    const w = forwardWatch();
    w.add(`[${LOKI}] Forwarding from 127.0.0.1:41231 -> 3100`);
    expect(w.of(LOKI)).toEqual({ listening: true, local: 41231 });
    w.add(`\n[${LOKI}] the forward ended: it starts again in 2 s\n[${LOKI}] Forwarding from 127.0.0.1:38017 -> 3100\n`);
    expect(w.of(LOKI)).toEqual({ listening: true, local: 38017 });
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

function bastions() {
  const dir = mkdtempSync(join(tmpdir(), 'bastion-ports-'));
  dirs.push(dir);
  const started: (readonly string[])[] = [];
  let io: Omit<NeedBoxIo, 'phases'> | undefined;
  const pipe = async (cmd: readonly string[]): Promise<BoxPipe> => {
    started.push(cmd);
    return Object.assign(new PassThrough(), { stderr: () => '' }) as unknown as BoxPipe;
  };
  const b = createBastions({
    userId: 'u1', dir, record: () => {}, log: () => {}, atWork: () => true, listenMs: 200,
    run: async (_box, i): Promise<NeedBoxResult> => {
      io = i;
      i.running?.({ renew: async () => {}, pipe });
      await new Promise((r) => { i.signal.addEventListener('abort', r, { once: true }); });
      return { exit: 125, stopped: 'cancelled' };
    },
    mint: async () => ({ minted: { kind: 'kube', token: 'token-1', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://lab.example:6443' } }),
    release: async () => {}, mayRelay: async () => ({ allowed: true, reason: 'job:u1/job-1 may relay' }),
  });
  ended.push(() => b.stopAll());
  return { b, started, say: (text: string) => io!.log(text) };
}

describe('a bastion of three targets whose first one is not on a fixed port (issue #2566)', () => {
  it('the relay to each target reaches the port its kubectl forwards from, the first target too', async () => {
    const { b, started, say } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    // Another box on the machine holds 20000: the first target's kubectl took another port.
    say(`[${LOKI}] Forwarding from 127.0.0.1:41231 -> 3100\n[${TEMPO}] Forwarding from 127.0.0.1:20001 -> 3200\n[${PROM}] Forwarding from 127.0.0.1:35553 -> 9090\n`);
    expect(b.of('job-1')!.targets).toEqual([
      { target: LOKI, listening: true, local: 41231 }, { target: TEMPO, listening: true, local: 20001 }, { target: PROM, listening: true, local: 35553 },
    ]);
    expect(bastionText(b.of('job-1')!)).toContain(`${LOKI} on 127.0.0.1:41231 in the box: listening`);
    for (const t of [LOKI, TEMPO, PROM]) expect('no' in await b.relay('job-1', t)).toBe(false);
    expect(started).toEqual([relayCommand(41231), relayCommand(20001), relayCommand(35553)]);
  });

  it('a forward that has not said its port yet has none in its view', async () => {
    const { b } = bastions();
    await b.start(JOB, TEMPLATE, TARGETS);
    await until(() => b.of('job-1')?.state === 'running');
    expect(b.of('job-1')!.targets[0]).toEqual({ target: LOKI });
    expect(bastionText(b.of('job-1')!)).toContain(`${LOKI} on a port kubectl picks in the box: not listening yet`);
  });
});
