// Issue #1977: a template request whose template would run an image that is not published is refused at once, with
// the reason, before any template is saved. Before, the template was saved and approved, and its read-only check failed
// later with "manifest unknown". An image the check cannot judge (its registry not reached) does not refuse a request.
import { describe, expect, it } from 'vitest';
import type { TemplateView } from '../../src/domain/vault.ts';
import { TEST_IMAGE } from '../../src/sandbox/box-image.ts';
import { requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const E2E = { secrets: 'test-saml-idp-users', egress: 'auth-dev.example.dev:443', image: 'test' };

function user(missing: readonly string[]) {
  const templates = new Map<string, TemplateView>();
  const asked: string[] = [];
  const u: TemplateRequestUser = {
    template: (name) => templates.get(name),
    templates: () => [...templates.values()],
    async save(t) {
      templates.set(t.name, { ...t, pending: { secrets: [...t.secrets], image: true, egress: [...(t.egress ?? [])], profiles: [...t.profiles] }, gives: [], radius: { level: 'medium', reasons: [] } } as unknown as TemplateView);
      return { ok: true };
    },
    approve: async () => ({ ok: true }),
    approveProfile: async () => ({ ok: true }),
    policy: () => undefined,
    imageProblem: async (image) => {
      asked.push(image);
      return missing.includes(image) ? `the image ${image} is not published: its registry answers manifest unknown` : undefined;
    },
    image: IMAGE,
  };
  return { u, templates, asked };
}

describe('a template request for an image that is not published (issue #1977)', () => {
  it('is refused at once with the reason, and no template is saved', async () => {
    const { u, templates, asked } = user([TEST_IMAGE]);
    const r = await requestTemplate(u, E2E, 'job j1', 'j1');
    expect(r.status).toBe(400);
    expect('reason' in r && r.reason).toBe(`the image ${TEST_IMAGE} is not published: its registry answers manifest unknown. A box of this template could not start, so the hopper makes no template of it. Ask with another --image, or ask a person to publish it.`);
    expect(templates.size).toBe(0);
    expect(asked).toEqual([TEST_IMAGE]);
  });

  it('goes on when the image is published, or when its registry cannot say', async () => {
    const { u, templates } = user([]);
    expect((await requestTemplate(u, E2E, 'job j1', 'j1')).status).toBe(202);
    expect([...templates.values()][0]!.image).toBe(TEST_IMAGE);
  });

  it('asks no registry for a template it asked for before: a poll of a waiting job stays as fast as before', async () => {
    const { u, asked } = user([]);
    expect((await requestTemplate(u, E2E, 'job j1', 'j1')).status).toBe(202);
    expect((await requestTemplate(u, E2E, 'job j1', 'j1')).status).toBe(202);
    expect(asked).toEqual([TEST_IMAGE]);
  });
});
