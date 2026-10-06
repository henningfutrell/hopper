// The first person to sign in with GitHub becomes admin (issue #239, docs/sign-in.md "The first GitHub
// admin"). Recorded once, in the sign-in config (`githubAdmin`), so it holds across restarts and survives
// realms set up from the environment, which replace only the realms. Only a hopper nobody has signed in to
// with GitHub yet records one: on a hopper where someone already has, the rule makes nobody admin.
import type { Identity } from '../domain/types.ts';
import type { InstanceStore } from '../domain/ports.ts';
import { loadSignInConfig, type AuthConfig } from './config.ts';

type Instance = Pick<InstanceStore, 'signInConfig' | 'identities' | 'tx'>;

/** Record `who` as the first GitHub admin; the sign-in config with it, or undefined when someone signed in with GitHub before. */
export function claimGithubAdmin(instance: Instance, who: Identity): AuthConfig | undefined {
  return instance.tx(() => {
    const store = instance.signInConfig;
    const version = store.version();
    const current = store.read();
    if (current.githubAdmin) return undefined;
    const github = current.realms.filter((r) => r.type === 'github').map((r) => r.name);
    if (!github.includes(who.realm) || instance.identities.anyIn(github)) return undefined;
    const next = { ...current, githubAdmin: { realm: who.realm, subject: who.subject } };
    const config = loadSignInConfig(next);
    return store.write(next, version) ? config : undefined;
  });
}

/**
 * The hopper's admin (issue #240, docs/sign-in.md "The instance admin"): the user the first GitHub admin
 * signs in as while that realm is on; with none recorded, the oldest user. Undefined: nobody yet. Only
 * their admin sessions do what is the instance's (issue #241); a login code makes nobody this admin.
 */
export function instanceAdminUser(config: AuthConfig, userOf: (realm: string, subject: string) => string | undefined, oldest: string | undefined): string | undefined {
  const first = config.githubAdmin;
  if (first && config.realms.some((r) => r.name === first.realm && r.type === 'github' && r.enabled)) return userOf(first.realm, first.subject);
  return oldest;
}
