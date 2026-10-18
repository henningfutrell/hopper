// Issue #1779: a template whose read-only check failed as the vault minted nothing for a read need cannot pass until a
// person fixes the minting credential, so a request for it is refused (409), not left waiting. The refusal names the
// need, the vault's reason, and the read needs on the same account a check of another template passed with. Pure.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { ReadOnlyCheck } from '../../src/domain/read-only-check.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { needsOf, requestedName, requestTemplate, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const SAVED = '2030-01-02T00:00:00.000Z';
const REFUSED = 'STS refused the AssumeRole: AccessDenied';

function template(needs: string, check: Omit<ReadOnlyCheck, 'version' | 'at' | 'probes'>): TemplateView {
  const profiles = needsOf(needs) as OperationProfile[];
  return {
    name: requestedName(profiles), image: IMAGE, secrets: [], profiles, readOnly: true, savedBy: 'job j0', savedAt: SAVED,
    approval: { image: IMAGE, secrets: [], by: 'the read policy', at: SAVED }, pending: { secrets: [], image: false, egress: [], profiles: [] },
    gives: [], radius: { level: 'low', reasons: [] }, check: { version: SAVED, at: SAVED, probes: [], ...check },
  } as unknown as TemplateView;
}

function user(...kept: TemplateView[]): TemplateRequestUser {
  const templates = new Map(kept.map((t) => [t.name, t]));
  return {
    template: (name) => templates.get(name), templates: () => [...templates.values()],
    save: async () => ({ ok: true }), approve: async () => ({ ok: true }), approveProfile: async () => ({ ok: true }),
    policy: () => undefined, image: IMAGE,
  };
}

const READONLY = 'read/aws-role/123456789012/readonly';
const unminted = { state: 'failed' as const, unminted: [{ asset: { kind: 'aws-role' as const, name: '123456789012/readonly' }, reason: REFUSED }] };

describe('a template whose check failed on a mint (issue #1779)', () => {
  it('is refused with the need and the reason, not left waiting', async () => {
    const r = await requestTemplate(user(template(READONLY, unminted)), READONLY, 'job j1', 'j1');
    expect(r.status).toBe(409);
    expect('reason' in r && r.reason).toContain(`the vault minted no credential for read on aws-role 123456789012/readonly: ${REFUSED}`);
    expect('reason' in r && r.reason).toContain('Ask for a read need the vault mints for in its place');
  });

  it('names the read needs on the same account a check passed with', async () => {
    const other = template('read/aws-role/123456789012/hopper-read', { state: 'passed' });
    const elsewhere = template('read/aws-role/999999999999/hopper-read', { state: 'passed' });
    const r = await requestTemplate(user(template(READONLY, unminted), other, elsewhere), READONLY, 'job j1', 'j1');
    expect(r.status).toBe(409);
    expect('reason' in r && r.reason).toContain('passed a check: read/aws-role/123456789012/hopper-read. Ask for them in its place');
    expect('reason' in r && r.reason).not.toContain('999999999999');
  });

  it('a failure on a network error still waits: the check pass runs it again', async () => {
    const r = await requestTemplate(user(template(READONLY, { ...unminted, transient: true })), READONLY, 'job j1', 'j1');
    expect(r.status).toBe(202);
  });

  it('a failure with no need left unminted still waits for a person', async () => {
    const r = await requestTemplate(user(template(READONLY, { state: 'failed' })), READONLY, 'job j1', 'j1');
    expect(r.status).toBe(202);
    expect('text' in r && r.text).toContain('A person runs it again');
  });
});
