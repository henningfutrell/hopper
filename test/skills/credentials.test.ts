// Issue #583: Render is a skill, next to the Kubernetes and AWS ones, and each skill that needs a credential says the kinds
// it takes (the first suggested) and how a person gets one. A job is told how to use the vault secret a person gave —
// its name, the kind, the person's words —, never a value.
import { describe, expect, it } from 'vitest';
import { askedSkill, catalogText, credentialText, skillOf, SKILLS } from '../../src/skills/catalog.ts';

describe('skills that need a credential', () => {
  it('Render is in the catalog, next to the Kubernetes and AWS skills; the catalog stays short', () => {
    expect(SKILLS.map((s) => s.name)).toEqual(['github', 'kube-diagnostics', 'aws-diagnostics', 'render']);
    expect(catalogText()).toMatch(/^render: deploy and look at services on Render/m);
    expect(catalogText().length).toBeLessThan(800);
  });

  it('each says what it takes, the suggested kind first, and how a person gets one or sets the tool up', () => {
    expect(skillOf('render')!.credential!.kinds.map((k) => k.id)).toEqual(['api-key', 'deploy-hook']);
    expect(skillOf('render')!.credential!.setup).toMatch(/Account Settings → API Keys/);
    expect(skillOf('kube-diagnostics')!.credential!.setup).toMatch(/kubectl create token/);
    expect(skillOf('aws-diagnostics')!.credential!.kinds[0]!.id).toBe('access-key');
    expect(skillOf('github')!.credential).toBeUndefined();
  });

  it('tells a job how to use the secret given: the kind\'s own use, or the person\'s words', () => {
    const render = skillOf('render')!.credential!;
    expect(credentialText(render, { name: 'render', kind: 'api-key' })).toBe(
      'Vault secret: render — A Render API key.\nUse: RENDER_API_KEY="$("$HOPPER_SECRET" get render)" render …, the key set for that one command; for the API, send the header "Authorization: Bearer <key>" to curl on stdin (-H @-).',
    );
    expect(credentialText(render, { name: 'team', kind: 'other', note: 'a read-only team key' })).toMatch(/^Vault secret: team — something the user described \(the user says: a read-only team key\)\.\nUse: Read it with "\$HOPPER_SECRET" get team/);
  });

  it('a service the hopper has no skill for is the job\'s words: what it takes is the suggested kind', () => {
    const fly = askedSkill('flyio', 'a Fly.io deploy token');
    expect(fly.credential.kinds).toEqual([expect.objectContaining({ id: 'asked', title: 'a Fly.io deploy token' })]);
    expect(credentialText(fly.credential, { name: 'flyio', kind: 'asked' })).toMatch(/^Vault secret: flyio — a Fly\.io deploy token\./);
  });
});
