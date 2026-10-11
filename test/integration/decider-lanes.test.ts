// The Decider (issue #550) as the decision point for lane tuning (issue #688), through the real daemon, store and HTTP
// server, Jev as a double at its seam (`seams.jev`). Two decision points:
// - `lane-count`: when a machine's lane recommendation by the rules changes, Jev picks its lanes from the lanes the rules
//   allow. In shadow (the default) the rules' recommendation stands and Jev's pick is compared with what an admin applies;
//   active, a sure pick is the machine's recommendation, `decidedBy: 'jev'`, with the rules' own beside it. An admin
//   still applies it. Below the threshold, the rules decide.
// - `job-machine`: a waiting job that more than one machine can take asks Jev for its machine. In shadow the decider
//   places it as before, and the pick is compared with the machine it got; active, a sure pick goes first.
// The probe is the seam: no ssh here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, JevChooser, JevPick, LaneTuningPlan, MachineSample, MinorDecisionAsk, MinorDecisionsView, ResourceReading } from '../../src/domain/types.ts';
import type { MachineProbe } from '../../src/machines/index.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const GIB = 1024 ** 3;
const MIN = 60_000;
const RES: ResourceReading = { cores: 8, cpuBusyFrac: 0.1, load: [1, 1, 1], memTotalBytes: 16 * GIB, memAvailableBytes: 12 * GIB };

/** Jev as a double: picks what `answer` says for each point, records every ask. */
function fakeJev(answer: (ask: MinorDecisionAsk) => JevPick | undefined): JevChooser & { asks: MinorDecisionAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  return {
    asks,
    available: () => ({ available: true }),
    pick: async (ask) => { asks.push(ask); return answer(ask) ?? { ok: false, why: 'not this point' }; },
    check: async () => ({ ok: true }),
  };
}

/** Machines `names`, each with 2 lanes, online, read as RES; a `where` executor says where it ran. */
async function boot(names: string[], jev: JevChooser): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugin = join(dirname(db.dbPath), 'plugins', 'where');
  mkdirSync(plugin, { recursive: true, mode: 0o700 });
  writeFileSync(join(plugin, 'index.js'), [
    "export default { id: 'where', role: 'executor', describe: 'says where it ran',",
    "  async detect() { return { status: 'available' }; },",
    "  create() { return { name: 'where', idempotent: true, validate() { return null; },",
    "    async run(ctx) { return { kind: 'finished', result: { machine: ctx.machine.id } }; } }; } };",
  ].join('\n'), { mode: 0o600 });
  writePlugins(db.dbPath, {
    version: 1,
    executors: [{ name: 'where', plugin: 'where' }],
    machines: names.map((name) => ({ name, plugin: 'ssh', options: { ssh: name, lanes: 2, executors: ['where'] } })),
  });
  const probe: MachineProbe = { online: true, home: '/home/far', disk: { freeBytes: 50 * GIB, totalBytes: 100 * GIB, low: false }, resources: RES };
  const a = await startTestApp({ dbPath: db.dbPath, seams: { jev, machineProbe: () => Promise.resolve(probe) } });
  apps.push(a);
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { online: boolean }[]).filter((m) => m.online).length === names.length);
  return a;
}

/** Twenty minutes each at 0, 1 and 2 lanes in use on `laptop`: a lane costs 2 GiB and 10% CPU, no pressure: the rules recommend 4. */
function seed(a: TestApp): void {
  const start = Date.now() - 24 * 60 * MIN;
  const samples: MachineSample[] = [];
  for (const k of [0, 1, 2]) {
    for (let i = 0; i < 20; i++) {
      samples.push({
        machineId: 'laptop', at: new Date(start + (k * 20 + i) * MIN).toISOString(), cores: 8, cpuBusyFrac: 0.1 + k * 0.1,
        memTotalBytes: 16 * GIB, memAvailableBytes: (12 - 2 * k) * GIB, diskFreeBytes: 50 * GIB, diskTotalBytes: 100 * GIB, lanesBusy: k, lanesMax: 2,
      });
    }
  }
  a.user().store.machineHistory.record(samples);
}

const RULES_REASON = 'no resource pressure up to 2 lanes in use; a lane uses about 2.0 GiB of memory and 10% CPU: room for 2 more';
const laptop = async (a: TestApp) => (await a.api<LaneTuningPlan>('GET', '/api/lanes/plan')).body.machines.find((m) => m.machineId === 'laptop')!;
const ofType = async (a: TestApp, type: string): Promise<DomainEvent[]> => a.events(`types=${type}&limit=1000`);
const view = async (a: TestApp) => (await a.api<MinorDecisionsView>('GET', '/api/minor-decisions')).body;

async function setPoint(a: TestApp, token: string, point: string, patch: Record<string, unknown>) {
  const r = await a.ui(`/ui/api/minor-decisions/points/${point}`, patch, { token });
  expect(r.status).toBe(200);
}

describe('the lane count as a decider call', () => {
  it('in shadow, Jev picks from the lanes the rules allow; the rules\' recommendation stands; an admin\'s Apply is compared with the pick', async () => {
    const jev = fakeJev((ask) => (ask.point === 'lane-count' ? { ok: true, pick: '3', confidence: 0.9 } : undefined));
    const a = await boot(['laptop'], jev);
    seed(a);
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    const asked = jev.asks.filter((x) => x.point === 'lane-count');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.options.map((o) => o.id)).toEqual(['1', '2', '3', '4']);
    expect(asked[0]!.options.find((o) => o.id === '2')!.label).toContain('configured now');
    expect(asked[0]!.options.find((o) => o.id === '4')!.label).toContain('the rules recommend it');
    expect(asked[0]!.state).toMatchObject({
      machine: 'laptop', configured: 2, headroom: 4, rules: { lanes: 4, reason: RULES_REASON, confidence: 0.33 },
      usage: { band: 'free', usedFrac: 0 }, bounds: { minLanes: 1, maxLanes: 8 },
      laneLoad: expect.arrayContaining([expect.objectContaining({ lanesBusy: 2, samples: 20 })]),
      laneReliability: expect.any(Array),
    });
    const [picked] = await ofType(a, 'minor_decision.picked');
    expect(picked!.data).toMatchObject({ point: 'lane-count', machineId: 'laptop', pick: '3', confidence: 0.9, mode: 'shadow', applied: false, notApplied: 'shadow' });
    expect(await laptop(a)).toMatchObject({ lanes: 4, reason: RULES_REASON, confidence: 0.33, apply: { to: 4 } });
    expect(await laptop(a)).not.toHaveProperty('decidedBy');
    const [recommended] = await ofType(a, 'lanes.recommended');
    expect(recommended!.data).toMatchObject({ lanes: 4, configured: 2 });
    expect(recommended!.data).not.toHaveProperty('decidedBy');
    // No change, no new ask.
    expect(await a.user().engine.laneTuning.record()).toBe(0);
    expect(jev.asks.filter((x) => x.point === 'lane-count')).toHaveLength(1);

    const admin = await a.login();
    expect((await a.ui('/ui/api/lanes/apply', { machineId: 'laptop', lanes: 4 }, { token: admin })).status).toBe(200);
    const [compared] = await waitFor(async () => { const e = await ofType(a, 'minor_decision.compared'); return e.length ? e : undefined; });
    expect(compared!.data).toMatchObject({ point: 'lane-count', pick: '3', actual: '4', agreed: false });
    const point = (await view(a)).points.find((p) => p.point === 'lane-count');
    expect(point).toMatchObject({ mode: 'shadow', asked: 1, picked: 1, compared: 1, agreed: 0 });
    expect((await view(a)).recent[0]).toMatchObject({ point: 'lane-count', machineId: 'laptop', pick: '3', actual: '4' });
  });

  it('active, a sure pick is the machine\'s recommendation, with the rules\' own beside it; an admin applies it', async () => {
    const jev = fakeJev((ask) => (ask.point === 'lane-count' ? { ok: true, pick: '3', confidence: 0.9 } : undefined));
    const a = await boot(['laptop'], jev);
    const admin = await a.login();
    await setPoint(a, admin, 'lane-count', { mode: 'active' });
    seed(a);
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    const r = await laptop(a);
    expect(r).toMatchObject({
      configured: 2, lanes: 3, headroom: 4, confidence: 0.9, decidedBy: 'jev', apply: { to: 3 },
      rules: { lanes: 4, reason: RULES_REASON, confidence: 0.33 },
    });
    expect(r.reason).toBe(`Jev picked 3 lanes at 90%; the rules: 4 lanes, ${RULES_REASON}`);
    const [recommended] = await ofType(a, 'lanes.recommended');
    expect(recommended!.data).toMatchObject({ lanes: 3, confidence: 0.9, decidedBy: 'jev', rules: { lanes: 4 } });
    const [picked] = await ofType(a, 'minor_decision.picked');
    expect(picked!.data).toMatchObject({ point: 'lane-count', applied: true });

    expect((await a.ui('/ui/api/lanes/apply', { machineId: 'laptop', lanes: 3 }, { token: admin })).status).toBe(200);
    const [applied] = await ofType(a, 'lanes.applied');
    expect(applied!.data).toMatchObject({ from: 2, to: 3, confidence: 0.9, reason: expect.stringMatching(/^Jev picked 3 lanes/) });
    // An applied pick is compared only through an override.
    expect(await ofType(a, 'minor_decision.compared')).toEqual([]);
  });

  it('active, a pick below the threshold leaves the rules\' recommendation', async () => {
    const jev = fakeJev((ask) => (ask.point === 'lane-count' ? { ok: true, pick: '1', confidence: 0.5 } : undefined));
    const a = await boot(['laptop'], jev);
    await setPoint(a, await a.login(), 'lane-count', { mode: 'active' });
    seed(a);
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    expect(await laptop(a)).toMatchObject({ lanes: 4, reason: RULES_REASON });
    expect((await ofType(a, 'minor_decision.picked'))[0]!.data).toMatchObject({ applied: false, notApplied: 'below_threshold' });
  });
});

describe('the job\'s machine as a decider call', () => {
  const claimOf = async (a: TestApp, jobId: string) => (await ofType(a, 'job.claimed')).find((e) => e.jobId === jobId)!;

  it('in shadow, the job goes where the decider puts it, and Jev\'s pick is compared with that machine', async () => {
    const jev = fakeJev((ask) => (ask.point === 'job-machine' ? { ok: true, pick: 'laptop', confidence: 0.95 } : undefined));
    const a = await boot(['desk', 'laptop'], jev);
    const job = await a.pull({}, { executor: 'where' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ machine: 'desk' });
    const picked = await waitFor(async () => (await ofType(a, 'minor_decision.picked')).find((e) => e.jobId === job.id));
    expect(picked.data).toMatchObject({ point: 'job-machine', pick: 'laptop', applied: false });
    const ask = jev.asks.find((x) => x.point === 'job-machine')!;
    expect(ask.options.map((o) => o.id)).toEqual(['desk', 'laptop']);
    expect(ask.state).toMatchObject({ job: { executor: 'where' }, machines: expect.arrayContaining([expect.objectContaining({ id: 'laptop', lanes: 2 })]) });
    const compared = await waitFor(async () => (await ofType(a, 'minor_decision.compared')).find((e) => e.jobId === job.id));
    expect(compared.data).toMatchObject({ point: 'job-machine', pick: 'laptop', actual: 'desk', agreed: false, decidedBy: 'placement' });
  });

  it('active, a sure pick for a waiting job is where it goes', async () => {
    const jev = fakeJev((ask) => (ask.point === 'job-machine' ? { ok: true, pick: 'laptop', confidence: 0.95 } : undefined));
    const a = await boot(['desk', 'laptop'], jev);
    const token = await a.login();
    await setPoint(a, token, 'job-machine', { mode: 'active' });
    expect((await a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(200);
    const job = await a.pull({}, { executor: 'where' });
    await a.waitForStatus(job.id, 'held');
    const picked = await waitFor(async () => (await ofType(a, 'minor_decision.picked')).find((e) => e.jobId === job.id));
    expect(picked.data).toMatchObject({ point: 'job-machine', pick: 'laptop', applied: true });
    expect((await a.ui('/ui/api/queue/order', { jobIds: [job.id] }, { token })).status).toBe(200);
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ machine: 'laptop' });
    expect(String((await claimOf(a, job.id)).data.reason)).toContain('Jev picked laptop at 95%');
  });

  it('with one machine there is nothing to pick: Jev is not asked', async () => {
    const jev = fakeJev(() => ({ ok: true, pick: 'laptop', confidence: 1 }));
    const a = await boot(['laptop'], jev);
    const job = await a.pull({}, { executor: 'where' });
    await a.waitForStatus(job.id, 'finished');
    expect(jev.asks.filter((x) => x.point === 'job-machine')).toEqual([]);
  });
});
