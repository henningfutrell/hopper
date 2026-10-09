// Issue #559: access through the real daemon, store and HTTP server, with OpenFGA as a double at the
// AuthorizationServer seam. Before every credential the vault (issue #558) mints or renews, the hopper asks
// OpenFGA whether the job's template is approved for that operation on that asset (`decideMint`); the
// approvals and the model are the hopper's, in its database, pushed to OpenFGA. Settings → Access shows each
// template's approvals with the relationship chain, revokes one, tries a check, and edits the model. Every
// decision is recorded. When OpenFGA cannot be asked, or has not taken a change yet, nothing is allowed.
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessDecisionRecord, AccessView, MintDecision } from '../../src/domain/types.ts';
import { DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const CLUSTER_X = { kind: 'cluster', name: 'x' } as const;

async function boot(o: { server?: FakeAuthorizationServer | null; dbPath?: string } = {}): Promise<{ a: TestApp; server: FakeAuthorizationServer; token: string }> {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  const server = o.server ?? createFakeAuthorizationServer();
  const a = await startTestApp({ dbPath, plugins: { machines: lanes(2) }, seams: o.server === null ? {} : { authorizationServer: server } });
  apps.push(a);
  return { a, server, token: await a.login() };
}

const view = async (a: TestApp, token: string) => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': token })).body;
const edit = <T = AccessView>(a: TestApp, token: string, body: unknown) => a.ui<T>('/ui/api/access', body, { token });
const approve = (a: TestApp, token: string, operation = 'read', template = 'kubectl-diag') =>
  edit(a, token, { action: 'approve', template, operation, asset: CLUSTER_X });
const check = (a: TestApp, token: string, operation: string, template = 'kubectl-diag') =>
  edit<AccessDecisionRecord>(a, token, { action: 'check', template, operation, asset: CLUSTER_X });

describe('access: OpenFGA decides each mint (issue #559)', () => {
  it('allows a read through an approved rule with its relationship path, denies a write on the same asset, and records both', async () => {
    const { a, token } = await boot();
    expect((await approve(a, token)).status).toBe(200);

    const read = await check(a, token, 'read');
    expect(read.status).toBe(200);
    expect(read.body.allowed).toBe(true);
    expect(read.body.path).toEqual([
      { subject: expect.stringMatching(/^job:/), relation: 'running', object: 'template:kubectl-diag' },
      { subject: 'template:kubectl-diag', relation: 'approved_for', object: 'operation_profile:read/cluster/x' },
      { subject: 'operation_profile:read/cluster/x', relation: 'grants_read', object: 'asset:cluster/x' },
    ]);

    const write = await check(a, token, 'write');
    expect(write.body.allowed).toBe(false);
    expect(write.body.reason).toMatch(/kubectl-diag is not approved to write on cluster x/);
    expect(write.body.path).toBeUndefined();

    const v = await view(a, token);
    expect(v.status.state).toBe('connected');
    expect(v.templates).toEqual([{ template: 'kubectl-diag', approvals: [expect.objectContaining({
      profile: { operation: 'read', asset: CLUSTER_X }, approvedBy: expect.any(String),
      chain: [
        { subject: 'template:kubectl-diag', relation: 'approved_for', object: 'operation_profile:read/cluster/x' },
        { subject: 'operation_profile:read/cluster/x', relation: 'grants_read', object: 'asset:cluster/x' },
      ],
    })], radius: { level: 'low', reasons: ['read on cluster x: read only'], profiles: [{ profile: { operation: 'read', asset: CLUSTER_X }, level: 'low', approved: true }] } }]);
    expect(v.decisions.map((d) => [d.operation, d.allowed])).toEqual([['write', false], ['read', true]]);
    expect(v.decisions[0]!.trial).toEqual({ by: expect.any(String) });
  });

  it('denies the next check once the approval is revoked in the UI', async () => {
    const { a, server, token } = await boot();
    await approve(a, token);
    expect((await check(a, token, 'read')).body.allowed).toBe(true);
    const approval = (await view(a, token)).templates[0]!.approvals[0]!;

    const revoked = await edit(a, token, { action: 'revoke', approval: approval.id });
    expect(revoked.status).toBe(200);
    expect(revoked.body.templates).toEqual([]);
    expect(revoked.body.revoked).toEqual([expect.objectContaining({ id: approval.id, revokedBy: expect.any(String) })]);
    const [storeId] = server.stores.keys();
    expect([...server.storeTuples(storeId!).keys()]).not.toContain('template:kubectl-diag approved_for operation_profile:read/cluster/x');

    const after = await check(a, token, 'read');
    expect(after.body.allowed).toBe(false);
    expect(after.body.reason).toMatch(/not approved to read on cluster x/);
  });

  it('gives a running job of an approved template its read, and nothing once the job is no longer live', async () => {
    const { a, token } = await boot();
    await approve(a, token);
    const job = await a.pull({ op: 'sleep', ms: 1500 });
    await a.waitForStatus(job.id, 'running');
    const request = { job: { userId: 'admin', jobId: job.id }, template: 'kubectl-diag', operation: 'read', asset: CLUSTER_X } as const;

    const live: MintDecision = await a.app.access.decideMint(request);
    expect(live.allowed).toBe(true);
    expect(live.path?.[0]).toEqual({ subject: `job:admin/${job.id}`, relation: 'running', object: 'template:kubectl-diag' });

    await a.waitForStatus(job.id, 'finished');
    const ended = await a.app.access.decideMint(request);
    expect(ended.allowed).toBe(false);
    expect(ended.reason).toMatch(/is not live \(finished\)/);
    expect((await view(a, token)).decisions[0]).toMatchObject({ job: { userId: 'admin', jobId: job.id }, allowed: false });
  });

  it('fails closed while OpenFGA is unreachable, and the access view says why', async () => {
    const { a, server, token } = await boot();
    await approve(a, token);
    server.reachable = false;

    const d = await check(a, token, 'read');
    expect(d.body.allowed).toBe(false);
    expect(d.body.reason).toMatch(/^OpenFGA cannot be asked: .*ECONNREFUSED/);
    const v = await view(a, token);
    expect(v.status).toMatchObject({ state: 'unreachable', why: expect.stringMatching(/ECONNREFUSED/) });

    server.reachable = true;
    expect((await check(a, token, 'read')).body.allowed).toBe(true);
    expect((await view(a, token)).status.state).toBe('connected');
  });

  it('fails closed with no OpenFGA set up', async () => {
    const { a, token } = await boot({ server: null });
    expect((await approve(a, token)).status).toBe(200);
    const d = await check(a, token, 'read');
    expect(d.body.allowed).toBe(false);
    expect(d.body.reason).toMatch(/HOPPER_OPENFGA_URL/);
    expect((await view(a, token)).status).toMatchObject({ state: 'not-configured', why: expect.stringMatching(/HOPPER_OPENFGA_URL/) });
  });

  it('denies while OpenFGA has not taken a revoke yet, though it would still allow', async () => {
    const { a, server, token } = await boot();
    await approve(a, token);
    const approval = (await view(a, token)).templates[0]!.approvals[0]!;
    server.reachable = false;
    expect((await edit(a, token, { action: 'revoke', approval: approval.id })).status).toBe(200);
    // OpenFGA still holds the approval; the hopper does not ask it until the revoke is pushed.
    const [storeId] = server.stores.keys();
    expect([...server.storeTuples(storeId!).keys()]).toContain('template:kubectl-diag approved_for operation_profile:read/cluster/x');
    server.reachable = true;
    const checksBefore = server.checks.length;
    const d = await check(a, token, 'read');
    expect(d.body.allowed).toBe(false);
    expect(server.checks.length).toBe(checksBefore + 1);
    expect([...server.storeTuples(storeId!).keys()]).not.toContain('template:kubectl-diag approved_for operation_profile:read/cluster/x');
  });

  it('applies a model change live, and refuses a model without a relation the hopper asks or one OpenFGA refuses', async () => {
    const { a, server, token } = await boot();
    await approve(a, token, 'read');
    const before = await view(a, token);
    expect(before.model.dsl).toBe(DEFAULT_ACCESS_MODEL);

    // Reading is allowed to anything approved for write on the same asset too: a model change, no restart.
    const widened = DEFAULT_ACCESS_MODEL.replace('define can_read: running_job from grants_read', 'define can_read: running_job from grants_read or running_job from grants_write');
    expect(widened).not.toBe(DEFAULT_ACCESS_MODEL);
    await edit(a, token, { action: 'revoke', approval: before.templates[0]!.approvals[0]!.id });
    await approve(a, token, 'write');
    expect((await check(a, token, 'read')).body.allowed).toBe(false);
    const saved = await edit(a, token, { action: 'model', dsl: widened, version: before.model.version });
    expect(saved.status).toBe(200);
    expect(saved.body.model).toMatchObject({ dsl: widened, version: before.model.version + 1 });
    const read = await check(a, token, 'read');
    expect(read.body.allowed).toBe(true);
    expect(read.body.path).toBeUndefined();

    const stale = await edit(a, token, { action: 'model', dsl: widened, version: before.model.version });
    expect(stale.status).toBe(409);
    const gap = await edit(a, token, { action: 'model', dsl: widened.replace(/\n {4}define can_apply: .*\n/, '\n'), version: before.model.version + 1 });
    expect(gap.status).toBe(400);
    expect(JSON.stringify(gap.body)).toMatch(/asset#can_apply/);
    const broken = await edit(a, token, { action: 'model', dsl: 'model\n  schema 1.1\ntype', version: before.model.version + 1 });
    expect(broken.status).toBe(400);
    server.refuseModels = 'the relation type definitions contain a cycle';
    const refused = await edit(a, token, { action: 'model', dsl: DEFAULT_ACCESS_MODEL, version: before.model.version + 1 });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/OpenFGA refused the model: the relation type definitions contain a cycle/);
    expect((await view(a, token)).model.version).toBe(before.model.version + 1);
  });

  it('fills a new OpenFGA store from the database, and puts back what was changed behind the hopper', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const first = await boot({ dbPath: db.dbPath });
    await approve(first.a, first.token);
    await first.a.stop();
    apps.splice(apps.indexOf(first.a), 1);

    // A new OpenFGA, empty: the approvals come from the hopper's database.
    const second = await boot({ dbPath: db.dbPath, server: createFakeAuthorizationServer() });
    expect((await check(second.a, second.token, 'read')).body.allowed).toBe(true);
    const [storeId] = second.server.stores.keys();
    const tuples = second.server.storeTuples(storeId!);
    for (const t of [
      { subject: 'template:kubectl-diag', relation: 'approved_for', object: 'operation_profile:write/cluster/x' },
      { subject: 'operation_profile:write/cluster/x', relation: 'grants_write', object: 'asset:cluster/x' },
    ]) tuples.set(`${t.subject} ${t.relation} ${t.object}`, t);
    expect((await check(second.a, second.token, 'write')).body.allowed).toBe(true);
    await second.a.app.access.sync();
    expect((await check(second.a, second.token, 'write')).body.allowed).toBe(false);
  });

  it('is the hopper admin\'s alone: another user reads and changes nothing', async () => {
    const { a, token } = await boot();
    const bob = await a.addUser('bob');
    const bobToken = await a.login(bob.id);
    expect((await a.api('GET', '/api/access', undefined, { 'x-hopper-session': bobToken })).status).toBe(403);
    expect((await a.ui('/ui/api/access', { action: 'approve', template: 'kubectl-diag', operation: 'read', asset: CLUSTER_X }, { token: bobToken })).status).toBe(403);
    expect((await view(a, token)).templates).toEqual([]);
  });

  it('refuses names that are not a template, an operation or an asset', async () => {
    const { a, token } = await boot();
    expect((await edit(a, token, { action: 'approve', template: 'Bad Name', operation: 'read', asset: CLUSTER_X })).status).toBe(400);
    expect((await edit(a, token, { action: 'approve', template: 'kubectl-diag', operation: 'delete', asset: CLUSTER_X })).status).toBe(400);
    expect((await edit(a, token, { action: 'approve', template: 'kubectl-diag', operation: 'read', asset: { kind: 'cluster', name: 'a#b' } })).status).toBe(400);
  });
});
