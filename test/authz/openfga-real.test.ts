// Issue #559, opt-in: the OpenFGA adapter and the default access model against a real OpenFGA server.
// HOPPER_TEST_OPENFGA_URL names it (http://127.0.0.1:<port>), HOPPER_TEST_OPENFGA_KEY its preshared key when it
// has one. Each run makes a store of its own.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOpenFgaServer } from '../../src/authz/openfga.ts';
import { compileAccessModel, DEFAULT_ACCESS_MODEL } from '../../src/authz/model.ts';
import { approvalTuples } from '../../src/authz/objects.ts';

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

  it('reports a server it cannot reach as unreachable, not refused', async () => {
    const server = createOpenFgaServer({ url: 'http://127.0.0.1:9', key: () => undefined });
    await expect(server.store(undefined, 'x')).rejects.not.toMatchObject({ refused: true });
  });
});
