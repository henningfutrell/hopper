// Issue #1001: a template the hopper makes for a job, whose every write, sync or apply need is one a person approved
// before for that asset and access (a remembered write approval, still live), and whose reads are approved with no
// person, is approved with no person: `by` a remembered write approval. A template keeps the purpose and the plan of the
// job that asked for it first, for the card a person decides on.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { REMEMBERED_APPROVER, type RememberedWrite } from '../../src/domain/remembered-writes.ts';
import type { SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { previewTemplate, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const same = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;
const OFF: SandboxApprovals = { skipTemplateApproval: false, skipSandboxApproval: false };
const remembered = (operation: RememberedWrite['operation'], kind: RememberedWrite['asset']['kind'], name: string): RememberedWrite => ({ operation, asset: { kind, name }, by: 'Ada', at: '2026-10-13T10:00:00.000Z' });

function user(o: { remembered?: RememberedWrite[]; approvals?: SandboxApprovals } = {}) {
  const templates = new Map<string, TemplateView>();
  const calls: string[] = [];
  const saved: Record<string, unknown>[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    templates: () => [...templates.values()],
    async save(t) {
      saved.push(t);
      templates.set(t.name, { ...t, pending: { secrets: [], image: true, egress: [], profiles: [...t.profiles] }, gives: [], radius: { level: 'high', reasons: [] } } as unknown as TemplateView);
      return { ok: true };
    },
    async approve(name, by) {
      calls.push(`approve ${name} by ${by}`);
      const t = templates.get(name)!;
      templates.set(name, { ...t, approval: { by } as never, pending: { ...t.pending, image: false, profiles: t.pending.profiles.filter((p) => p.operation !== 'read') } });
      return { ok: true };
    },
    async approveProfile(name, profile, by) {
      calls.push(`approve ${profile.operation}/${profile.asset.kind}/${profile.asset.name} by ${by}`);
      const t = templates.get(name)!;
      templates.set(name, { ...t, pending: { ...t.pending, profiles: t.pending.profiles.filter((p) => !same(p, profile)) } });
      return { ok: true };
    },
    policy: () => undefined,
    approvals: () => o.approvals ?? OFF,
    remembered: () => o.remembered ?? [],
    image: 'ghcr.io/henningfutrell/hopper:box-claude',
  };
  return { u, calls, saved };
}

describe('a remembered write approval (issue #1001)', () => {
  it('approves a new template whose writes are all remembered, its write profiles with it, with no person', async () => {
    const { u, calls } = user({ remembered: [remembered('write', 'aws-account', '123456789012'), remembered('apply', 'namespace', 'lab/identity')] });
    const r = await requestTemplate(u, { needs: 'read/cluster/lab write/aws-account/123456789012 apply/namespace/lab/identity' }, 'job j2', 'j2');
    expect(r.status).toBe(200);
    expect(calls).toEqual([
      expect.stringMatching(new RegExp(`^approve asked-\\w+ by ${REMEMBERED_APPROVER}$`)),
      `approve write/aws-account/123456789012 by ${REMEMBERED_APPROVER}`,
      `approve apply/namespace/lab/identity by ${REMEMBERED_APPROVER}`,
    ]);
  });

  it('a write that is not remembered waits for a person', async () => {
    const { u, calls } = user({ remembered: [remembered('write', 'aws-account', '123456789012')] });
    const r = await requestTemplate(u, { needs: 'write/aws-account/123456789012 write/namespace/lab/identity' }, 'job j2', 'j2');
    expect(r.status).toBe(202);
    expect(calls).toEqual([]);
  });

  it('a remembered write and a read the policies do not approve wait for a person', async () => {
    const { u, calls } = user({ remembered: [remembered('write', 'aws-account', '123456789012')], approvals: { ...OFF, autoApprove: { low: false, medium: false, high: false } } });
    expect((await requestTemplate(u, { needs: 'read/cluster/lab write/aws-account/123456789012' }, 'job j2', 'j2')).status).toBe(202);
    expect(calls).toEqual([]);
  });

  it('the preview says a remembered write approval approves it', () => {
    const { u } = user({ remembered: [remembered('write', 'aws-account', '123456789012')] });
    expect(previewTemplate(u, { needs: 'write/aws-account/123456789012' })).toMatchObject({ approvedBy: REMEMBERED_APPROVER, waits: [] });
  });
});

describe('the purpose and the plan of a template a job asks for (issue #1001)', () => {
  it('keeps the purpose and the plan of the ask that made it', async () => {
    const { u, saved } = user();
    await requestTemplate(u, { needs: 'write/namespace/lab/identity' }, 'job j1', 'j1', { purpose: 'Create the cluster role for X in identity namespace', plan: 'kubectl apply -f role.yaml (ClusterRole x-reader; undo: kubectl delete)' });
    expect(saved[0]).toMatchObject({ askedBy: 'j1', purpose: 'Create the cluster role for X in identity namespace', plan: 'kubectl apply -f role.yaml (ClusterRole x-reader; undo: kubectl delete)' });
  });
});
