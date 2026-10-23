// Issue #1875: a template request that names vault secrets, the hopper's test image and egress hosts. The template holds
// what the request names, under a name of its own; the needs may be none; and no policy or toggle approves a secret or
// an egress host: the template waits for a person. A job names an image only from the hopper's own list.
// Issue #2146: a request may name box tools beside the ones its needs use; the policies approve them as the needs' tools.
import { describe, expect, it } from 'vitest';
import type { TemplateView } from '../../src/domain/vault.ts';
import { TEST_IMAGE } from '../../src/sandbox/box-image.ts';
import { askOf, extrasOf } from '../../src/skills/template-ask.ts';
import { previewTemplate, requestedName, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const ALL_ON = { skipTemplateApproval: true, skipSandboxApproval: true, autoApprove: { levels: ['low', 'medium', 'high'] } } as never;
const E2E = { secrets: 'test-saml-idp-users keycloak-admin-password', egress: 'Auth-Dev.Example.dev:443', image: 'test' };

/** A user whose vault keeps templates in a map; a save leaves its secrets and egress hosts waiting until it is approved. */
function user(o: { policy?: string[]; skips?: never } = {}) {
  const templates = new Map<string, TemplateView>();
  const saved: Parameters<TemplateRequestUser['save']>[0][] = [];
  const calls: string[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    templates: () => [...templates.values()],
    async save(t) {
      saved.push(t);
      templates.set(t.name, { ...t, pending: { secrets: [...t.secrets], image: true, egress: [...(t.egress ?? [])], profiles: [...t.profiles] }, gives: [], radius: { level: 'medium', reasons: [] } } as unknown as TemplateView);
      return { ok: true };
    },
    async approve(name, by) {
      calls.push(`approve ${name} by ${by}`);
      const t = templates.get(name)!;
      templates.set(name, { ...t, approval: { by } as never, pending: { secrets: [], image: false, egress: [], profiles: [] } });
      return { ok: true };
    },
    async approveProfile(name, profile, by) {
      calls.push(`approve ${profile.operation}/${profile.asset.kind}/${profile.asset.name} by ${by}`);
      return { ok: true };
    },
    policy: () => (o.policy ? { assets: o.policy } : undefined),
    approvals: () => o.skips ?? { skipTemplateApproval: false, skipSandboxApproval: false },
    image: IMAGE,
  };
  return { u, saved, calls, templates };
}

describe('a template request with secrets, an image and egress hosts (issue #1875)', () => {
  it('saves what it names, with no needs, and waits for a person whatever the policies and toggles say', async () => {
    const { u, saved, calls } = user({ policy: ['cluster/lab'], skips: ALL_ON });
    const r = await requestTemplate(u, E2E, 'job j1', 'j1');
    expect(r.status).toBe(202);
    expect('text' in r && r.text).toContain('a vault secret or an egress host is approved by a person only');
    expect(calls).toEqual([]);
    expect(saved).toEqual([expect.objectContaining({
      image: TEST_IMAGE, secrets: ['keycloak-admin-password', 'test-saml-idp-users'], egress: ['auth-dev.example.dev:443'], profiles: [], readOnly: false,
    })]);
  });

  it('is ready once a person approves it, and the answer names what it gives and the sandbox ask by its name', async () => {
    const { u, templates } = user();
    const first = await requestTemplate(u, E2E, 'job j1', 'j1');
    const name = 'template' in first ? first.template : '';
    await u.approve(name, 'a person');
    const r = await requestTemplate(u, E2E, 'job j2', 'j2');
    expect(r).toMatchObject({ status: 200, template: name });
    expect('text' in r && r.text).toContain('vault secret keycloak-admin-password, vault secret test-saml-idp-users, egress to auth-dev.example.dev:443, image test');
    expect('text' in r && r.text).toContain(`sandbox --template ${name} --wait`);
    expect(templates.size).toBe(1);
  });

  it('names the template from the extras too, and the needs alone as before', () => {
    const plain = requestedName([{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }]);
    expect(requestedName([{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }], { secrets: [], egress: [] })).toBe(plain);
    expect(requestedName([{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }], { secrets: ['a'], egress: [] })).not.toBe(plain);
  });

  it('a template a person changed is refused, not taken as asked', async () => {
    const { u, templates } = user();
    const first = await requestTemplate(u, E2E, 'job j1', 'j1');
    const name = 'template' in first ? first.template : '';
    templates.set(name, { ...templates.get(name)!, egress: ['auth-dev.example.dev:443', 'other.example.dev:443'] });
    const r = await requestTemplate(u, E2E, 'job j2', 'j2');
    expect(r.status).toBe(409);
  });

  it('uses another approved template that gives exactly what it asks, and never one that gives more', async () => {
    const { u, templates } = user();
    const base = { image: TEST_IMAGE, secrets: ['keycloak-admin-password', 'test-saml-idp-users'], egress: ['auth-dev.example.dev:443'], profiles: [], approval: { by: 'a person' }, pending: { secrets: [], image: false, egress: [], profiles: [] } };
    templates.set('wider', { ...base, name: 'wider', secrets: [...base.secrets, 'more'] } as unknown as TemplateView);
    templates.set('e2e', { ...base, name: 'e2e' } as unknown as TemplateView);
    expect(await requestTemplate(u, E2E, 'job j1', 'j1')).toMatchObject({ status: 200, template: 'e2e' });
  });

  it('a secret alone needs no needs; no needs and no secret or host is refused', async () => {
    const { u } = user();
    expect((await requestTemplate(u, { secrets: 'keycloak-admin-password' }, 'job j1', 'j1')).status).toBe(202);
    expect((await requestTemplate(u, { image: 'test' }, 'job j1', 'j1')).status).toBe(400);
  });

  it('the preview shows the image, the extras and that a person approves', () => {
    const { u } = user({ skips: ALL_ON });
    expect(previewTemplate(u, E2E)).toMatchObject({ image: TEST_IMAGE, approvedBy: 'a person', needs: expect.arrayContaining(['egress to auth-dev.example.dev:443']) });
  });
});

describe('the extras read (issue #1875)', () => {
  it('refuses an image reference, a host that is not host:port, a system secret and too many', () => {
    expect(extrasOf({ image: 'docker.io/evil:latest' })).toMatch(/one of the hopper's box images: box, test/);
    expect(extrasOf({ egress: 'https://auth-dev.example.dev' })).toMatch(/is not host:port/);
    expect(extrasOf({ egress: '*.example.dev:443' })).toMatch(/is not host:port/);
    expect(extrasOf({ secrets: 'system/github-token' })).toMatch(/no vault secret's name/);
    expect(extrasOf({ secrets: Array.from({ length: 9 }, (_, i) => `s${i}`).join(' ') })).toMatch(/at most 8/);
  });

  it('reads each list sorted, lowercase hosts, each once', () => {
    expect(extrasOf({ secrets: 'b,a b', egress: 'B.dev:443 b.dev:443' })).toEqual({ secrets: ['a', 'b'], egress: ['b.dev:443'] });
  });

  it('takes the fields from a skill request body', () => {
    const body: Record<string, string> = { needs: 'read/cluster/lab', egress: 'a.dev:443', why: 'x' };
    expect(askOf((k) => body[k])).toEqual({ needs: 'read/cluster/lab', egress: 'a.dev:443' });
  });
});

describe('a template request with box tools (issue #2146)', () => {
  const OBSERVE = { needs: 'read/cluster/utility', tools: 'promtool jq logcli' };

  it('adds the tools it names to the needs\' tools, under a name of its own, and the read policy approves it', async () => {
    const { u, saved, calls } = user({ policy: ['cluster/utility'] });
    const r = await requestTemplate(u, OBSERVE, 'job j1', 'j1');
    const name = 'template' in r ? r.template : '';
    expect(saved).toEqual([expect.objectContaining({ tools: ['helm', 'jq', 'kubectl', 'logcli', 'promtool'], secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'utility' } }], readOnly: true })]);
    expect(name).not.toBe(requestedName([{ operation: 'read', asset: { kind: 'cluster', name: 'utility' } }]));
    expect(calls).toEqual([`approve ${name} by the read policy`]);
  });

  it('uses the template it made again, and the answer names the tools', async () => {
    const { u, templates } = user({ policy: ['cluster/utility'] });
    const first = await requestTemplate(u, OBSERVE, 'job j1', 'j1');
    const r = await requestTemplate(u, { ...OBSERVE, tools: 'jq,logcli promtool' }, 'job j2', 'j2');
    expect(r).toMatchObject({ template: 'template' in first ? first.template : '' });
    expect(templates.size).toBe(1);
    expect(previewTemplate(u, OBSERVE)).toMatchObject({ needs: expect.arrayContaining(['tool jq', 'tool logcli', 'tool promtool']) });
  });

  it('a tool the hopper does not add is refused', async () => {
    const { u } = user();
    expect(await requestTemplate(u, { ...OBSERVE, tools: 'jq nmap' }, 'job j1', 'j1')).toMatchObject({ status: 400, reason: expect.stringContaining('nmap is not a tool the hopper adds to a box') });
  });

  it('reads the tools in the catalog\'s order, each once, and takes them from a skill request body', () => {
    expect(extrasOf({ tools: 'promtool JQ jq' })).toEqual({ secrets: [], egress: [], tools: ['jq', 'promtool'] });
    expect(extrasOf({ tools: ' ' })).toEqual({ secrets: [], egress: [] });
    const body: Record<string, string> = { needs: 'read/cluster/utility', tools: 'jq' };
    expect(askOf((k) => body[k])).toEqual({ needs: 'read/cluster/utility', tools: 'jq' });
  });
});
