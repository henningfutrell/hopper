// Issue #658: the hopper's own secrets on Vault, the page's pure model. Each says what the hopper keeps it
// for, its last 4 characters, who set it and when, how it is kept and where it is changed; each audit entry says what
// happened to which secret and by whom. Nothing on the page is a value.
import { describe, expect, it } from 'vitest';
import { auditLine, mayKeepInBackend, systemSecretLine, systemSecretTitle, systemSecretWhere } from '../../ui/src/model/vault-system.ts';
import type { SystemSecretView } from '../../ui/src/model/wire.ts';

const AT = '2026-10-10T12:00:00Z';
const secret = (name: string, kind: SystemSecretView['kind'], o: Partial<SystemSecretView> = {}): SystemSecretView => ({ name, kind, scope: 'user', setBy: 'hopper', setAt: AT, ...o });

describe('a system secret on the page (issue #658)', () => {
  it('says what it is for and where it is changed, for each kind', () => {
    expect(systemSecretTitle(secret('connected-account.github.access-token', 'connected-account'))).toBe('GitHub connection: access token');
    expect(systemSecretTitle(secret('connected-account.github.refresh-token', 'connected-account'))).toBe('GitHub connection: refresh token');
    expect(systemSecretTitle(secret('webhook.3f2c.signing-secret', 'webhook'))).toBe('Webhook signing secret');
    expect(systemSecretTitle(secret('sign-in.corp.clientSecret', 'sign-in'))).toBe('Sign-in realm corp: client secret');
    expect(systemSecretTitle(secret('sign-in.dir.bindPassword', 'sign-in'))).toBe('Sign-in realm dir: bind password');
    expect(systemSecretTitle(secret('typesafe-api-key', 'typesafe'))).toBe('TypeSafe API key (Jev)');
    expect(systemSecretWhere({ kind: 'webhook' })).toBe('Settings → Webhooks');
    expect(systemSecretWhere({ kind: 'sign-in' })).toBe('Settings → Sign-in');
    // The GitHub webhook secret (issue #1079): the whole hopper's.
    expect(systemSecretTitle(secret('github-webhook-secret', 'github-webhook'))).toBe('GitHub webhook secret');
    expect(systemSecretWhere({ kind: 'github-webhook' })).toBe('Settings → GitHub webhook');
    expect(mayKeepInBackend(secret('github-webhook-secret', 'github-webhook', { scope: 'instance' }))).toBe(false);
    // The cloud link key (issue #467): the whole hopper's, made by the hopper.
    expect(systemSecretTitle(secret('cloud-link.key', 'cloud-link'))).toBe('cloud link key: private half');
    expect(systemSecretWhere({ kind: 'cloud-link' })).toBe('Settings → hopper.io');
    expect(mayKeepInBackend(secret('cloud-link.key', 'cloud-link', { scope: 'instance' }))).toBe(false);
  });

  it('says set, its last 4 characters, who and that it is sealed', () => {
    const line = systemSecretLine(secret('webhook.3f2c.signing-secret', 'webhook', { last4: 'wxyz', setBy: 'Ada' }));
    expect(line).toMatch(/^Set — ends in wxyz — .* by Ada · sealed$/);
    expect(systemSecretLine(secret('sign-in.corp.clientSecret', 'sign-in', { scope: 'instance' }))).toContain('the whole hopper');
  });

  it('an audit entry says what happened, to which secret, by whom', () => {
    expect(auditLine({ seq: 1, at: AT, type: 'vault.secret_set', name: 'webhook.3f2c.signing-secret', by: 'Ada', detail: 'rotated' })).toMatch(/ · webhook\.3f2c\.signing-secret · rotated · Ada$/);
    expect(auditLine({ seq: 2, at: AT, type: 'vault.secret_read', name: 'connected-account.github.access-token', by: 'hopper', detail: 'GitHub' })).toMatch(/ · read by the hopper \(GitHub\)$/);
    expect(auditLine({ seq: 3, at: AT, type: 'vault.secret_migrated', name: 'sign-in.corp.clientSecret', detail: 'moved from sign-in' })).toMatch(/ · moved into the vault$/);
    expect(auditLine({ seq: 4, at: AT, type: 'vault.refused', name: 'typesafe-api-key', detail: "a job's ask refused (job j1): no" })).toMatch(/refused to a job — a job's ask refused \(job j1\): no$/);
  });

  it('one kept in a vault backend says where, and that the hopper holds it in memory only; only a user\'s TypeSafe key and webhook secrets may be', () => {
    const kept = secret('typesafe-api-key', 'typesafe', { last4: 'ABCD', setBy: 'Ada', backend: { name: 'my-vault', reference: 'jev#key' } });
    expect(systemSecretLine(kept)).toMatch(/ · kept in vault backend my-vault at jev#key, held in memory only$/);
    expect(mayKeepInBackend(kept)).toBe(true);
    expect(mayKeepInBackend(secret('webhook.3f2c.signing-secret', 'webhook'))).toBe(true);
    for (const s of [secret('connected-account.github.access-token', 'connected-account'), secret('artifact-content-key', 'artifact'), secret('sign-in.corp.clientSecret', 'sign-in', { scope: 'instance' })]) {
      expect(mayKeepInBackend(s)).toBe(false);
    }
  });
});
