// Issue #2067: a request that names a cluster the vault cannot find (an unknown asset) is refused at once, with the
// clusters the topology lists, nearest first, and the needs to ask for in its place. No template is saved, so no job
// waits on one. A template saved before is refused the same way. Pure.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { unknownAssets } from '../../src/domain/unknown-assets.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { needsOf, previewTemplate, requestedName, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const SAVED = '2030-01-02T00:00:00.000Z';
const KNOWN = ['control-plane-eks', 'platform-cluster-eks', 'staging-eks'];

function user(kept: TemplateView[] = []) {
  const templates = new Map(kept.map((t) => [t.name, t]));
  const saved: string[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name), templates: () => [...templates.values()],
    save: async (t) => { saved.push(t.name); return { ok: true }; }, approve: async () => ({ ok: true }), approveProfile: async () => ({ ok: true }),
    policy: () => undefined, image: IMAGE,
    unknownAssets: (needs) => unknownAssets(needs, { secrets: [], overrides: [], known: KNOWN }),
  };
  return { u, saved };
}

describe('a request for an unknown cluster (issue #2067)', () => {
  it('is refused at once with the known clusters, and no template is saved', async () => {
    const { u, saved } = user();
    const r = await requestTemplate(u, { needs: 'read/cluster/staging read/cluster/control-plane' }, 'job j1', 'j1');
    expect(r.status).toBe(400);
    const reason = 'reason' in r ? r.reason : '';
    expect(reason).toContain('no cluster staging; known: staging-eks, control-plane-eks, platform-cluster-eks');
    expect(reason).toContain('no cluster control-plane; known: control-plane-eks');
    expect(reason).toContain('--needs "read/cluster/staging-eks read/cluster/control-plane-eks"');
    expect(saved).toEqual([]);
  });

  it('refuses a template saved before for it, which waits on its check', async () => {
    const profiles = needsOf('read/cluster/platform') as OperationProfile[];
    const t = {
      name: requestedName(profiles), image: IMAGE, secrets: [], profiles, readOnly: true, savedBy: 'job j0', savedAt: SAVED,
      approval: { image: IMAGE, secrets: [], by: 'the read policy', at: SAVED }, pending: { secrets: [], image: false, egress: [], profiles: [] },
      gives: [], radius: { level: 'low', reasons: [] },
    } as unknown as TemplateView;
    const r = await requestTemplate(user([t]).u, { needs: 'read/cluster/platform' }, 'job j1', 'j1');
    expect(r.status).toBe(400);
    expect('reason' in r && r.reason).toContain('no cluster platform; known: platform-cluster-eks');
  });

  it('a known cluster is asked for as before', async () => {
    const { u, saved } = user();
    const r = await requestTemplate(u, { needs: 'read/cluster/staging-eks' }, 'job j1', 'j1');
    expect(r.status).not.toBe(400);
    expect(saved).toHaveLength(1);
  });

  it('the preview says so too', () => {
    expect(previewTemplate(user().u, { needs: 'read/namespace/staging/web' })).toContain('no cluster staging; known: staging-eks');
  });
});
