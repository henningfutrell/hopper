// Issue #1001: the auto-approve policy. A template the hopper makes now for a job is approved with no person when its blast
// radius is a level the user's policy auto-approves — by default low only: read needs, no vault secret. Each approval is
// an event that names the policy. The read policy still approves what it holds first; skip template approval still
// approves the rest when it is on.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { AUTO_APPROVER, type SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { previewTemplate, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const same = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

function user(o: { policy?: string[]; approvals?: SandboxApprovals } = {}) {
  const templates = new Map<string, TemplateView>();
  const calls: string[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    templates: () => [...templates.values()],
    async save(t) {
      templates.set(t.name, { ...t, pending: { secrets: [], image: true, profiles: [...t.profiles] }, gives: [], radius: { level: 'low', reasons: [] } } as unknown as TemplateView);
      return { ok: true };
    },
    async approve(name, by) {
      calls.push(`approve ${name} by ${by}`);
      const t = templates.get(name)!;
      templates.set(name, { ...t, approval: { by } as never, check: { passed: true } as never, pending: { ...t.pending, image: false, profiles: t.pending.profiles.filter((p) => p.operation !== 'read') } });
      return { ok: true };
    },
    async approveProfile(name, profile, by) {
      calls.push(`approve ${profile.operation}/${profile.asset.kind}/${profile.asset.name} by ${by}`);
      const t = templates.get(name)!;
      templates.set(name, { ...t, pending: { ...t.pending, profiles: t.pending.profiles.filter((p) => !same(p, profile)) } });
      return { ok: true };
    },
    policy: () => (o.policy ? { assets: o.policy } : undefined),
    approvals: () => o.approvals ?? { skipTemplateApproval: false, skipSandboxApproval: false },
    image: 'ghcr.io/henningfutrell/hopper:box-claude',
  };
  return { u, calls };
}

const OFF = { skipTemplateApproval: false, skipSandboxApproval: false };

describe('the auto-approve policy (issue #1001)', () => {
  it('by default approves a read-only template with no person, by the policy, outside the read policy too', async () => {
    const { u, calls } = user();
    const r = await requestTemplate(u, 'read/aws-account/123456789012 read/cluster/lab', 'job j1', 'j1');
    expect(r.status).not.toBe(400);
    expect(calls).toEqual([expect.stringMatching(new RegExp(`^approve asked-\\w+ by ${AUTO_APPROVER}$`))]);
  });

  it('by default a write waits for a person', async () => {
    const { u, calls } = user();
    const r = await requestTemplate(u, 'read/cluster/lab write/cluster/lab', 'job j1', 'j1');
    expect(r.status).toBe(202);
    expect(calls).toEqual([]);
  });

  it('with high on, a write template is approved by the policy, its write profile with it', async () => {
    const { u, calls } = user({ approvals: { ...OFF, autoApprove: { low: true, medium: false, high: true } } });
    const r = await requestTemplate(u, 'write/cluster/lab', 'job j1', 'j1');
    expect(r.status).toBe(200);
    expect(calls).toEqual([expect.stringMatching(new RegExp(`by ${AUTO_APPROVER}$`)), `approve write/cluster/lab by ${AUTO_APPROVER}`]);
  });

  it('with low off, a read outside the read policy waits', async () => {
    const { u, calls } = user({ approvals: { ...OFF, autoApprove: { low: false, medium: false, high: false } } });
    expect((await requestTemplate(u, 'read/cluster/lab', 'job j1', 'j1')).status).toBe(202);
    expect(calls).toEqual([]);
  });

  it('the read policy approves what it holds first', async () => {
    const { u, calls } = user({ policy: ['cluster/lab'] });
    await requestTemplate(u, 'read/cluster/lab', 'job j1', 'j1');
    expect(calls).toEqual([expect.stringMatching(/by the read policy$/)]);
  });

  it('the preview says the policy approves it, and that a write waits', () => {
    const { u } = user();
    expect(previewTemplate(u, 'read/cluster/lab')).toMatchObject({ approvedBy: AUTO_APPROVER, waits: [] });
    expect(previewTemplate(u, 'write/cluster/lab')).toMatchObject({ approvedBy: 'a person', waits: ['write on cluster lab changes the asset'] });
  });
});
