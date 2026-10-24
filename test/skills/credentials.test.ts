// Issue #583: a skill that needs a credential says the kinds it takes (the first suggested) and how a person gets one; a
// service the hopper has no skill for is the job's own words, whatever the service. A job is told how to use the vault
// secret a person gave — its name, the kind, the person's words —, never a value.
import { describe, expect, it } from 'vitest';
import { askedSkill, catalogText, credentialText, skillOf, SKILLS } from '../../src/skills/catalog.ts';

describe('skills that need a credential', () => {
  it('the catalog has no skill for one outside service; it says how to ask for a credential for any service, and stays short', () => {
    expect(SKILLS.map((s) => s.name)).toEqual(['github', 'kube-diagnostics', 'aws-diagnostics', 'sandbox', 'sandbox-template', 'artifacts', 'windows-step', 'box-step', 'need-step', 'observability', 'database', 'topology', 'park', 'help']);
    expect(catalogText()).toContain('A credential for any other service: sh "$HOPPER_SKILL" SERVICE --credential "<what it takes>"');
    // Issue #1007 added need-step, issue #1905 topology, issue #1909 orchestrate, issue #2146 observability, issue #2167 park: the catalog stays short, one line per skill.
    expect(catalogText().length).toBeLessThan(1300);
  });

  it('each says what it takes, the suggested kind first, and how a person gets one or sets the tool up', () => {
    expect(skillOf('kube-diagnostics')!.credential!.kinds[0]!.id).toBe('token');
    expect(skillOf('kube-diagnostics')!.credential!.setup).toMatch(/kubectl create token/);
    expect(skillOf('aws-diagnostics')!.credential!.kinds[0]!.id).toBe('access-key');
    expect(skillOf('github')!.credential).toBeUndefined();
  });

  it('a service the hopper has no skill for is the job\'s words: what it takes is the suggested kind', () => {
    const service = askedSkill('example-api', 'an API token');
    expect(service.credential.kinds).toEqual([expect.objectContaining({ id: 'asked', title: 'an API token' })]);
    expect(credentialText(service.credential, { name: 'example-api', kind: 'asked' })).toBe(
      'Vault secret: example-api — an API token.\nUse: Read it with "$HOPPER_SECRET" get example-api, only in the command that needs it. Never print it or write it to a file.',
    );
  });

  it('tells a job how to use the secret given in the person\'s own words', () => {
    const service = askedSkill('example-api', 'an API token').credential;
    expect(credentialText(service, { name: 'team', kind: 'other', note: 'a read-only team key' })).toMatch(/^Vault secret: team — something the user described \(the user says: a read-only team key\)\.\nUse: Read it with "\$HOPPER_SECRET" get team/);
  });
});
