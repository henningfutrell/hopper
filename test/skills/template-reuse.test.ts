// Issue #998: a template request whose needs are those of a template already approved — the same operation profiles, no
// vault secret, nothing waiting for a person — uses that template, whatever its name, and makes no second one. A template
// with a secret, or one that waits for a person, is not used for it. Pure.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { previewTemplate, requestedName, requestTemplate, needsOf, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const ROLE: OperationProfile = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } };
const NEEDS = 'read/aws-role/123456789012/readonly';

const template = (name: string, o: Partial<TemplateView> = {}): TemplateView => ({
  name, image: IMAGE, secrets: [], profiles: [ROLE], savedAt: '2030-01-01T00:00:00.000Z', readOnly: true,
  check: { version: '2030-01-01T00:00:00.000Z', state: 'passed', at: '2030-01-01T00:01:00.000Z', probes: [] },
  approval: { image: IMAGE, secrets: [], by: 'Ada', at: '2030-01-01T00:00:30.000Z' },
  pending: { secrets: [], image: false, profiles: [] }, gives: [], radius: { level: 'low', reasons: [] }, ...o,
}) as TemplateView;

function user(...kept: TemplateView[]) {
  const templates = new Map(kept.map((t) => [t.name, t]));
  const saved: string[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    templates: () => [...templates.values()],
    async save(t) {
      saved.push(t.name);
      templates.set(t.name, { ...t, savedAt: '2030-01-02T00:00:00.000Z', pending: { secrets: [], image: true, profiles: [...t.profiles] }, gives: [], radius: { level: 'low', reasons: [] } } as unknown as TemplateView);
      return { ok: true };
    },
    approve: async () => ({ ok: true }),
    approveProfile: async () => ({ ok: true }),
    policy: () => undefined,
    image: IMAGE,
  };
  return { u, saved };
}

describe('a request for the needs of an approved template (issue #998)', () => {
  it('uses that template, whatever its name, and makes no second one', async () => {
    const { u, saved } = user(template('aws-readonly'));
    const r = await requestTemplate(u, NEEDS, 'job j1', 'j1');
    expect(r).toMatchObject({ status: 200, template: 'aws-readonly' });
    expect('text' in r && r.text).toContain('template aws-readonly is ready, approved by a person');
    expect(saved).toEqual([]);
    expect(previewTemplate(u, NEEDS)).toMatchObject({ template: 'aws-readonly', exists: 'same', waits: [] });
  });

  it('prefers it to the template the needs name when that one waits for a person', async () => {
    const name = requestedName(needsOf(NEEDS) as OperationProfile[]);
    const { u, saved } = user(template(name, { approval: undefined, pending: { secrets: [], image: true, profiles: [ROLE] } }), template('aws-readonly'));
    expect(await requestTemplate(u, NEEDS, 'job j1', 'j1')).toMatchObject({ status: 200, template: 'aws-readonly' });
    expect(saved).toEqual([]);
  });

  it('does not use a template that holds a vault secret, waits for a person, or has other profiles', async () => {
    for (const other of [
      template('with-secret', { secrets: ['AWS_KEY'] }),
      template('not-approved', { approval: undefined, pending: { secrets: [], image: true, profiles: [ROLE] } }),
      template('wider', { profiles: [ROLE, { operation: 'read', asset: { kind: 'cluster', name: 'lab' } }] }),
    ]) {
      const { u, saved } = user(other);
      const r = await requestTemplate(u, NEEDS, 'job j1', 'j1');
      expect(r).toMatchObject({ template: expect.stringMatching(/^asked-/) });
      expect(saved).toHaveLength(1);
    }
  });
});
