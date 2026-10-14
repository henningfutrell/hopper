// Issue #559, opt-in: the OpenFGA adapter and the default access model against a real OpenFGA server.
// HOPPER_TEST_OPENFGA_URL names it (http://127.0.0.1:<port>), HOPPER_TEST_OPENFGA_KEY its preshared key when it
// has one. Each run makes a store of its own. Issue #581: the requester tuples, and a check from a job, a box and a user.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOpenFgaServer } from '../../src/authz/openfga.ts';
import { compileAccessModel, DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
import { approvalTuples, requesterTuples } from '../../src/authz/objects.ts';

const URL_ = process.env.HOPPER_TEST_OPENFGA_URL;

describe.skipIf(!URL_)('OpenFGA, for real (opt-in)', () => {
  it('stores the model and tuples, and checks with the job told as a contextual tuple', async () => {
    const server = createOpenFgaServer({ url: URL_!, key: () => process.env.HOPPER_TEST_OPENFGA_KEY });
    const storeId = await server.store(undefined, `hopper-test-${randomUUID()}`);
    expect(await server.store(storeId, 'ignored')).toBe(storeId);
    const modelId = await server.writeModel(storeId, compileAccessModel(DEFAULT_ACCESS_MODEL));
    const role = { kind: 'aws-role', name: '123456789012/read-only' } as const;
    const read = approvalTuples('aws-diag', { operation: 'read', asset: role });
    const writeGrant = approvalTuples('aws-diag', { operation: 'write', asset: role }).grant;
    await server.write(storeId, modelId, { writes: [read.grant, read.approval, writeGrant], deletes: [] });
    expect((await server.tuples(storeId)).length).toBe(3);

    const job = { subject: 'job:admin/j1', relation: 'running', object: 'template:aws-diag' };
    const ask = (relation: string, contextual = [job]) =>
      server.check(storeId, modelId, { subject: 'job:admin/j1', relation, object: read.grant.object }, contextual);
    expect(await ask('can_read')).toBe(true);
    expect(await ask('can_write')).toBe(false);
    expect(await ask('can_read', [])).toBe(false);

    await server.write(storeId, modelId, { writes: [], deletes: [read.approval] });
    expect(await ask('can_read')).toBe(false);
    await expect(server.writeModel(storeId, { schema_version: '1.1', type_definitions: [{ type: 'a', relations: { r: { computedUserset: { relation: 'r' } } } }] }))
      .rejects.toMatchObject({ refused: true });
  });

  it('takes the requester tuples, and allows a job, its box and its user through an approved template, never a box of another', async () => {
    const server = createOpenFgaServer({ url: URL_!, key: () => process.env.HOPPER_TEST_OPENFGA_KEY });
    const storeId = await server.store(undefined, `hopper-test-${randomUUID()}`);
    const modelId = await server.writeModel(storeId, compileAccessModel(DEFAULT_ACCESS_MODEL));
    const cluster = { kind: 'cluster', name: 'prod' } as const;
    const read = approvalTuples('kube', { operation: 'read', asset: cluster });
    const who = requesterTuples([
      { userId: 'admin', jobs: [{ jobId: 'j1', machine: 'kbox' }], boxes: [{ machine: 'kbox', template: 'kube' }] },
      { userId: 'bob', jobs: [{ jobId: 'j2', machine: 'my box' }], boxes: [{ machine: 'my box', template: 'other' }] },
    ]);
    await server.write(storeId, modelId, { writes: [read.grant, read.approval, ...who], deletes: [] });
    const ask = (subject: string, relation = 'can_read') => server.check(storeId, modelId, { subject, relation, object: read.grant.object }, []);
    for (const subject of ['job:admin/j1', 'machine:admin/kbox', 'user:admin']) expect(await ask(subject)).toBe(true);
    expect(await ask('job:admin/j1', 'can_write')).toBe(false);
    for (const subject of ['job:bob/j2', 'machine:bob/my%20box', 'user:bob']) expect(await ask(subject)).toBe(false);

    // The job ends: its tuples go, and so does its access and its user's.
    await server.write(storeId, modelId, { writes: [], deletes: who.filter((t) => t.subject.includes('j1') || t.object.includes('j1')) });
    expect(await ask('job:admin/j1')).toBe(false);
    expect(await ask('user:admin')).toBe(false);
    expect(await ask('machine:admin/kbox')).toBe(true);
  });

  it('reports a server it cannot reach as unreachable, not refused', async () => {
    const server = createOpenFgaServer({ url: 'http://127.0.0.1:9', key: () => undefined });
    await expect(server.store(undefined, 'x')).rejects.not.toMatchObject({ refused: true });
  });
});
