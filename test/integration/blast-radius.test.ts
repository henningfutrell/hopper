// Issue #542: blast radius through the real daemon, store and HTTP server. Each machine is discovered when it comes
// online and on demand, through its own connection (here a double at the MachineShell port); GET /api/blast-radius
// shows what it found, its rating with the evidence, and whether it is gated. A job whose only machine is gated is
// held at the gate saying why; an admin lets it through, and it runs. The settings (where the gate stands, what passes
// it, the rules, actor machines) are stored and apply at the next Decision. A discovery that raises the level flags
// the machine; an actor machine rated other than declared is flagged.
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { BlastRadiusView, DiscoveryFacts } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };
const PROD_WRITE: DiscoveryFacts = {
  ...NOTHING,
  bins: [...NOTHING.bins, { dir: '/usr/local/bin', name: 'aws' }],
  versions: { aws: 'aws-cli/2.17.0' },
  aws: [{
    profile: 'prod-deploy', account: '222222222222', arn: 'arn:aws:sts::222222222222:assumed-role/deploy/s', region: 'us-east-1',
    simulated: [{ action: 's3:PutObject', decision: 'allowed' }, { action: 'iam:CreateUser', decision: 'implicitDeny' }],
  }],
  credentials: { env: [], files: ['aws-config'] },
};

/** An executor that runs nothing and reaches its machine through a shell whose discovery finds `facts.now`. */
function reacher(facts: { now: DiscoveryFacts; calls: number }): Executor {
  const shell: MachineShell = {
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async keepCredential() {},
    async discover() { facts.calls += 1; return facts.now; },
  };
  return { name: 'reach', validate: () => null, run: async () => ({ kind: 'failed', error: 'not run' }), machineShell: () => shell };
}

async function boot(facts: { now: DiscoveryFacts; calls: number }, dbPath?: string): Promise<TestApp> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  const a = await startTestApp({ dbPath: path, plugins: { machines: lanes(2) }, seams: { executors: [reacher(facts)] } });
  apps.push(a);
  return a;
}

const view = async (a: TestApp) => (await a.api<BlastRadiusView>('GET', '/api/blast-radius')).body;
const local = async (a: TestApp) => (await view(a)).machines.find((m) => m.machineId === 'local')!;
const discovered = (a: TestApp) => waitFor(async () => ((await local(a)).discovery ? local(a) : undefined), { what: 'the machine discovered' });

describe('blast radius', () => {
  it('a machine is discovered when it comes online; its rating carries the evidence; a prod write machine is gated', async () => {
    const facts = { now: PROD_WRITE, calls: 0 };
    const a = await boot(facts);
    const m = await discovered(a);
    expect(m).toMatchObject({
      discoverable: true,
      discovery: { level: 'high', changes: { first: true }, facts: { versions: { aws: 'aws-cli/2.17.0' } } },
      rating: { level: 'high', reach: [expect.objectContaining({ kind: 'aws', access: 'write', prod: true, evidence: 'policy simulation allows s3:PutObject' })] },
      gated: 'rated high',
    });
    expect((await view(a)).settings).toMatchObject({ gateAt: 'high', pass: { labels: [], repos: [] }, everyMinutes: 60 });
    expect((await a.events('types=machine.discovered')).map((e) => e.data)).toEqual([expect.objectContaining({ machineId: 'local', level: 'high' })]);
  });

  it('a job whose only machine is gated is held at the gate; an admin lets it through and it runs', async () => {
    const a = await boot({ now: PROD_WRITE, calls: 0 });
    await discovered(a);
    const j = await a.pull({ op: 'echo' });
    const held = await a.waitForStatus(j.id, 'held');
    expect(held.holdReason).toBe('held at the blast-radius gate: local is rated high; only a job let through the gate runs there');

    const admin = await a.login();
    const passed = await a.ui<{ gatePass?: { at: string } }>(`/ui/api/jobs/${j.id}/gate-pass`, {}, { token: admin });
    expect(passed.status).toBe(200);
    expect(passed.body.gatePass).toBeDefined();
    await a.waitForStatus(j.id, 'finished');
    expect((await a.events('types=job.gate_passed')).map((e) => e.jobId)).toEqual([j.id]);
    // Not held at the gate (any more): refused, as the UI never offers it.
    expect((await a.ui(`/ui/api/jobs/${j.id}/gate-pass`, {}, { token: admin })).status).toBe(409);
  });

  it('settings apply at the next Decision: a pass label lets a job through; the gate off lets every job through', async () => {
    const a = await boot({ now: PROD_WRITE, calls: 0 });
    await discovered(a);
    const admin = await a.login();
    expect((await a.ui('/ui/api/blast-radius/settings', { pass: { labels: ['hopper:actor'] } }, { token: admin })).status).toBe(200);
    const labelled = await a.pull({ op: 'echo' }, { labels: ['hopper', 'hopper:actor'] });
    await a.waitForStatus(labelled.id, 'finished');

    const plain = await a.pull({ op: 'echo' });
    await a.waitForStatus(plain.id, 'held');
    await a.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: admin });
    await a.waitForStatus(plain.id, 'finished');
    expect((await a.events('types=blast_radius.settings_changed')).length).toBe(2);
  });

  it('a discovery that raises the level flags the machine and gates it; one on demand answers when done', async () => {
    const facts = { now: NOTHING, calls: 0 };
    const a = await boot(facts);
    expect(await discovered(a)).toMatchObject({ rating: { level: 'low', reasons: ['no credentials or access found'] } });
    expect((await local(a)).gated).toBeUndefined();

    facts.now = PROD_WRITE;
    const admin = await a.login();
    const r = await a.ui<BlastRadiusView>('/ui/api/blast-radius/discover', { machineId: 'local' }, { token: admin });
    expect(r.status).toBe(200);
    const m = r.body.machines.find((x) => x.machineId === 'local')!;
    expect(m.discovery).toMatchObject({
      level: 'high', grew: { from: 'low', to: 'high' },
      changes: { first: false, added: ['tool /usr/local/bin/aws', 'aws prod-deploy', 'credential file aws-config'], removed: [], level: { from: 'low', to: 'high' } },
    });
    expect(m.gated).toBe('rated high');
    expect((await a.events('types=machine.radius_grew')).map((e) => e.data)).toEqual([{ machineId: 'local', from: 'low', to: 'high' }]);
    expect((await a.ui('/ui/api/blast-radius/discover', { machineId: 'nowhere' }, { token: admin })).status).toBe(404);
  });

  it('an actor machine is gated whatever its rating, and flagged when its rating is not the level declared', async () => {
    const a = await boot({ now: NOTHING, calls: 0 });
    await discovered(a);
    const admin = await a.login();
    const r = await a.ui<BlastRadiusView>('/ui/api/blast-radius/settings', { gateAt: 'off', actors: [{ machineId: 'local', purpose: 'production deploys', expected: 'high' }] }, { token: admin });
    expect(r.status).toBe(200);
    expect(r.body.machines.find((x) => x.machineId === 'local')).toMatchObject({
      gated: 'an actor machine (production deploys)', actor: { purpose: 'production deploys', expected: 'high', mismatch: true },
    });
    const j = await a.pull({ op: 'echo' });
    expect((await a.waitForStatus(j.id, 'held')).holdReason).toBe('held at the blast-radius gate: local is an actor machine (production deploys); only a job let through the gate runs there');
    await a.ui('/ui/api/blast-radius/discover', {}, { token: admin });
    expect((await a.events('types=machine.actor_mismatch')).map((e) => e.data)).toEqual([{ machineId: 'local', expected: 'high', found: 'low' }]);
  });

  it('bad settings are refused; a viewer may not change them; they outlive a restart', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a = await boot({ now: NOTHING, calls: 0 }, db.dbPath);
    const admin = await a.login();
    for (const body of [
      { gateAt: 'always' }, { everyMinutes: 1 }, { pass: { repos: ['not a repo'] } }, { pass: { minPriority: 101 } },
      { rules: { prodPatterns: [''], prodAccounts: [], unconfirmed: 'write' } }, { rules: { prodPatterns: [], prodAccounts: ['12'], unconfirmed: 'write' } },
      { actors: [{ machineId: 'nowhere', purpose: 'x', expected: 'high' }] }, { actors: [{ machineId: 'local', purpose: '', expected: 'high' }] },
    ]) {
      expect((await a.ui('/ui/api/blast-radius/settings', body, { token: admin })).status, JSON.stringify(body)).toBe(400);
    }
    await a.ui('/ui/api/blast-radius/settings', { gateAt: 'medium', pass: { repos: ['org/infra'], minPriority: 90 } }, { token: admin });
    await a.stop();
    apps.splice(apps.indexOf(a), 1);
    const b = await boot({ now: NOTHING, calls: 0 }, db.dbPath);
    expect((await view(b)).settings).toMatchObject({ gateAt: 'medium', pass: { labels: [], repos: ['org/infra'], minPriority: 90 } });
    // The record outlives it too.
    expect((await local(b)).discovery).toBeDefined();

    const db2 = tempDbPath();
    cleanups.push(db2.cleanup);
    writeConfig(db2.dbPath, 'sign-in', { version: 1, none: { role: 'viewer' } });
    const c = await boot({ now: NOTHING, calls: 0 }, db2.dbPath);
    const viewer = (await c.ui<{ token: string }>('/ui/auth/none', {})).body.token;
    expect((await c.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: viewer })).status).toBe(403);
    expect((await c.ui('/ui/api/blast-radius/discover', {}, { token: viewer })).status).toBe(403);
  });
});
