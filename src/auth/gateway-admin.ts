// The first gateway admin (issue #2996, docs/sign-in.md "The first gateway admin"): on a hopper signed in to only through
// an auth gateway, the first identity a gateway realm with `firstAdmin` on accepts becomes admin, as the first GitHub
// sign-in does (issue #239). Recorded once, as a super admin in the sign-in config, so it holds across restarts and
// survives realms set up from the environment, which replace only the realms. Only while no admin exists: no super
// admin, no local account that is admin, and no session that is admin now. After that the setting makes nobody admin.
import type { Identity } from '../domain/types.ts';
import type { InstanceStore } from '../domain/ports.ts';
import { loadSignInConfig, type AuthConfig } from './config.ts';

type Instance = Pick<InstanceStore, 'signInConfig' | 'localAccounts' | 'uiSessions' | 'tx'>;

/** Record `who` as the first gateway admin; the sign-in config with it, or undefined when its realm may not or an admin exists. */
export function claimGatewayAdmin(instance: Instance, who: Identity, now: Date): AuthConfig | undefined {
  return instance.tx(() => {
    const store = instance.signInConfig;
    const version = store.version();
    const current = store.read();
    const realm = current.realms.find((r) => r.name === who.realm);
    if (realm?.type !== 'gateway' || realm.firstAdmin !== true || realm.enabled === false) return undefined;
    const supers = current.superAdmins ?? (current.githubAdmin ? [current.githubAdmin] : []);
    if (supers.length > 0) return undefined;
    if (instance.localAccounts.list().some((a) => a.role === 'admin')) return undefined;
    const at = now.toISOString();
    if (instance.uiSessions.all().some((s) => s.role === 'admin' && (s.endsAt === undefined || s.endsAt > at))) return undefined;
    const next = { ...current, superAdmins: [{ realm: who.realm, subject: who.subject }] };
    const config = loadSignInConfig(next);
    return store.write(next, version) ? config : undefined;
  });
}
