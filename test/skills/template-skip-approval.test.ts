// Issue #991: skip template approval. A template the hopper makes now for a request is approved at once — its write,
// sync and apply profiles with it —, by the toggle, so no person waits. The read policy still approves what it holds
// first. Off, the template waits for a person as before. A template a person revoked is never approved again by it.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { SandboxApprovals } from '../../src/domain/sandbox-approvals.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { previewTemplate, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const same = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

/** A user whose vault keeps templates in a map: approving the template approves its reads; a profile its own approval. */
function user(o: { policy?: string[]; skips?: SandboxApprovals } = {}) {
  const templates = new Map<string, TemplateView>();
  const calls: string[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    async save(t) {
      templates.set(t.name, { ...t, profiles: t.profiles, pending: { secrets: [], image: true, profiles: [...t.profiles] }, gives: [], radius: { level: 'low', reasons: [] } } as unknown as TemplateView);
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
    policy: () => (o.policy ? { assets: o.policy } : undefined),
    approvals: () => o.skips ?? { skipTemplateApproval: false, skipSandboxApproval: false },
    image: IMAGE,
  };
  return { u, calls, templates };
}

const SKIP = { skipTemplateApproval: true, skipSandboxApproval: false };

describe('skip template approval (issue #991)', () => {
  it('approves a new template at once, its write profile with it, by the toggle', async () => {
    const { u, calls } = user({ skips: SKIP });
    const r = await requestTemplate(u, 'read/cluster/lab write/cluster/lab', 'job j1', 'j1');
    expect(r.status).toBe(200);
    expect(r).toMatchObject({ template: expect.stringMatching(/^asked-/) });
    expect('text' in r && r.text).toContain('approved by skip template approval');
    expect(calls).toEqual([expect.stringMatching(/^approve asked-\w+ by skip template approval$/), expect.stringMatching(/^approve write\/cluster\/lab by skip template approval$/)]);
  });

  it('off, the same needs wait for a person', async () => {
    const { u, calls } = user();
    const r = await requestTemplate(u, 'read/cluster/lab write/cluster/lab', 'job j1', 'j1');
    expect(r.status).toBe(202);
    expect(calls).toEqual([]);
  });

  it('the read policy approves what it holds first', async () => {
    const { u, calls } = user({ policy: ['cluster/lab'], skips: SKIP });
    await requestTemplate(u, 'read/cluster/lab', 'job j1', 'j1');
    expect(calls).toEqual([expect.stringMatching(/by the read policy$/)]);
  });

  it('never approves again a template that is there already', async () => {
    const { u, calls, templates } = user({ skips: SKIP });
    await requestTemplate(u, 'write/cluster/lab', 'job j1', 'j1');
    const [name] = [...templates.keys()];
    // A person revoked it.
    templates.set(name!, { ...templates.get(name!)!, approval: undefined, pending: { secrets: [], image: true, profiles: [] } } as TemplateView);
    calls.length = 0;
    const r = await requestTemplate(u, 'write/cluster/lab', 'job j1', 'j1');
    expect(r.status).toBe(202);
    expect(calls).toEqual([]);
  });

  it('the preview says the toggle approves it', () => {
    const { u } = user({ skips: SKIP });
    expect(previewTemplate(u, 'write/cluster/lab')).toMatchObject({ approvedBy: 'skip template approval', waits: [] });
  });
});
