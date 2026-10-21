// Issue #1468: a template request must not leave a need stuck for every later job. A template of read needs only takes
// the read-only check, and the vault mints the check's read credentials for an aws-role, a cluster or a namespace only:
// such a request with a read need on an aws-account is refused when it is asked for, and the refusal names the need to
// ask for in its place. When a person changed a template a job asked for, the refusal names the template's needs now,
// and whether the operator CLI or Vault changed it. Pure.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { OPERATOR_CLI_NAME } from '../../src/domain/failures.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { needsOf, previewTemplate, requestedName, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const ACCOUNT = '123456789012';

function user(...kept: TemplateView[]) {
  const templates = new Map(kept.map((t) => [t.name, t]));
  const saved: string[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    templates: () => [...templates.values()],
    async save(t) {
      saved.push(t.name);
      templates.set(t.name, { ...t, savedBy: 'job j1', savedAt: '2030-01-02T00:00:00.000Z', pending: { secrets: [], image: true, egress: [], profiles: [...t.profiles] }, gives: [], radius: { level: 'low', reasons: [] } } as unknown as TemplateView);
      return { ok: true };
    },
    approve: async () => ({ ok: true }),
    approveProfile: async () => ({ ok: true }),
    policy: () => undefined,
    image: IMAGE,
  };
  return { u, saved };
}

describe('a read need on an aws-account in a template of read needs only (issue #1468)', () => {
  it('is refused when it is asked for, names the aws-role need to ask for instead, and saves nothing', async () => {
    const { u, saved } = user();
    const r = await requestTemplate(u, { needs: `read/aws-account/${ACCOUNT}` }, 'job j1', 'j1');
    expect(r.status).toBe(400);
    expect('reason' in r && r.reason).toContain(`read/aws-account/${ACCOUNT}`);
    expect('reason' in r && r.reason).toContain(`read/aws-role/${ACCOUNT}/<role>`);
    expect(saved).toEqual([]);
    expect(previewTemplate(u, { needs: `read/cluster/lab read/aws-account/${ACCOUNT}` })).toContain(`read/aws-role/${ACCOUNT}/<role>`);
  });

  it('is refused in plain words too', async () => {
    const { u } = user();
    expect((await requestTemplate(u, { needs: `aws s3 ls in account ${ACCOUNT}` }, 'job j1', 'j1')).status).toBe(400);
  });

  it('a read need on an Argo CD app is refused the same way: the vault mints nothing for it', async () => {
    const { u } = user();
    const r = await requestTemplate(u, { needs: 'read/argocd-app/web' }, 'job j1', 'j1');
    expect(r.status).toBe(400);
    expect('reason' in r && r.reason).toContain('read/argocd-app/web: a template of read needs only takes the read-only check');
  });

  it('a read need on an aws-role is asked for as before', async () => {
    const { u, saved } = user();
    expect((await requestTemplate(u, { needs: `read/aws-role/${ACCOUNT}/ReadOnly` }, 'job j1', 'j1')).status).not.toBe(400);
    expect(saved).toHaveLength(1);
  });

  it('in a template that also changes an asset it takes no check, so it is asked for as before', async () => {
    const { u, saved } = user();
    expect((await requestTemplate(u, { needs: `read/aws-account/${ACCOUNT} write/cluster/lab` }, 'job j1', 'j1')).status).not.toBe(400);
    expect(saved).toHaveLength(1);
  });
});

describe('a template a person changed since a job asked for it (issue #1468)', () => {
  const asked = `read/aws-account/${ACCOUNT} write/cluster/lab`;
  const name = requestedName(needsOf(asked) as OperationProfile[]);
  const changed = (savedBy: string): TemplateView => ({
    name, image: IMAGE, secrets: [], savedBy, savedAt: '2030-01-03T00:00:00.000Z',
    profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/ReadOnly` } }, { operation: 'write', asset: { kind: 'cluster', name: 'lab' } }],
    pending: { secrets: [], image: true, egress: [], profiles: [] }, gives: [], radius: { level: 'low', reasons: [] },
  }) as unknown as TemplateView;

  it('the refusal names its needs now, so a job can ask for those', async () => {
    const { u } = user(changed('a@example.com'));
    const r = await requestTemplate(u, { needs: asked }, 'job j1', 'j1');
    expect(r.status).toBe(409);
    expect('reason' in r && r.reason).toContain(`--needs "read/aws-role/${ACCOUNT}/ReadOnly write/cluster/lab"`);
    expect('reason' in r && r.reason).toContain(`changed template ${name} in Vault`);
  });

  it('says when the operator CLI changed it, not Vault', async () => {
    const { u } = user(changed(OPERATOR_CLI_NAME));
    const r = await requestTemplate(u, { needs: asked }, 'job j1', 'j1');
    expect(r.status).toBe(409);
    expect('reason' in r && r.reason).toContain(`changed template ${name} through the operator CLI`);
  });
});
