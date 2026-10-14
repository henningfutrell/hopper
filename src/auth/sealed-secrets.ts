// The sign-in realms' secrets in the instance's vault (issue #658, design.md "The vault's system scope"): `clientSecret`
// and `bindPassword` (SECRET_SETTINGS) are system secrets of the whole hopper (`sign-in.<realm>.<setting>`), sealed under
// the master key, never in the `sign-in` record. A hopper without its master key (limited, issue #659) keeps a realm's
// secret given meanwhile in the record, as before #658, so it still signs people in; its next start with the key moves it. Everything else reads and writes the sign-in config as before: `read` gives each realm its
// secrets, opened; `write` keeps each one given in the vault, removes each one left out, and stores the record without
// them, in one transaction. The version covers the secrets too (when each last changed), so a sign-in service that
// follows the stored version applies a replaced secret at once, and an edit made against an older one is refused.
import { createHash } from 'node:crypto';
import type { SignInConfigRepository, StoredRealm, StoredSignIn } from '../domain/ports.ts';
import type { SystemSecretName } from '../domain/vault.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { SECRET_SETTINGS } from './config.ts';
import type { RealmType } from '../domain/types.ts';

const PREFIX = 'sign-in.';
/** The system secret a realm's secret setting is kept as. */
export const realmSecretName = (realm: string, setting: string): SystemSecretName => `${PREFIX}${realm}.${setting}`;
const settingsOf = (r: StoredRealm): readonly string[] => SECRET_SETTINGS[r.type as RealmType] ?? [];

/** The record without the realms' secrets: what the `sign-in` record keeps. */
export function withoutSecrets(s: StoredSignIn): StoredSignIn {
  return { ...s, realms: s.realms.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !settingsOf(r).includes(k))) as StoredRealm) };
}

/**
 * The record as the operator CLI checks it (issue #658): each realm secret the vault keeps (`held`, its vault rows)
 * stands in as set, so a record without them still loads. Never a value: a placeholder.
 */
export function withHeldSecrets(value: unknown, held: readonly string[]): unknown {
  const s = value as StoredSignIn | undefined;
  if (!s || !Array.isArray(s.realms)) return value;
  return {
    ...s,
    realms: s.realms.map((r) => {
      const out: StoredRealm = { ...r };
      for (const k of settingsOf(r)) if (out[k] === undefined && held.includes(`system/${realmSecretName(r.name, k)}`)) out[k] = '(kept in the vault)';
      return out;
    }),
  };
}

/** The realms' secrets the record holds in it (a record from before issue #658, or one the operator CLI wrote). */
export function secretsIn(s: StoredSignIn): { name: SystemSecretName; value: string }[] {
  return s.realms.flatMap((r) => settingsOf(r).flatMap((k) => (typeof r[k] === 'string' ? [{ name: realmSecretName(r.name, k), value: r[k] }] : [])));
}

export function sealedSignIn(o: {
  raw: SignInConfigRepository;
  system: SystemSecrets;
  tx<T>(fn: () => T): T;
  /** Why a secret could not be opened: said once per secret and reason. */
  logger: { warn(line: string): void };
}): SignInConfigRepository {
  const said = new Set<string>();
  const kept = (): string[] => o.system.list().filter((s) => s.name.startsWith(PREFIX)).map((s) => s.name);

  function read(): StoredSignIn {
    const record = o.raw.read();
    return {
      ...record,
      realms: record.realms.map((r) => {
        const out: StoredRealm = { ...r };
        for (const k of settingsOf(r)) {
          if (typeof out[k] === 'string') continue; // the operator CLI wrote one in: it is moved at the next start
          try {
            const value = o.system.open(realmSecretName(r.name, k), 'sign-in');
            if (value !== undefined) out[k] = value;
          } catch (e) {
            // Fails closed: a realm whose secret cannot be opened (its key missing) signs nobody in until it can be.
            if (out.enabled !== false) out.enabled = false;
            const line = `hopper: sign-in realm ${r.name} is off until its ${k} can be opened: ${(e as Error).message}`;
            if (!said.has(line)) { said.add(line); o.logger.warn(line); }
          }
        }
        return out;
      }),
    };
  }

  function version(): string {
    const secrets = o.system.list().filter((s) => s.name.startsWith(PREFIX)).map((s) => `${s.name} ${s.setAt}`).sort();
    return createHash('sha256').update(`${o.raw.version()}\n${secrets.join('\n')}`).digest('hex');
  }

  return {
    read,
    version,
    write(next, at) {
      return o.tx(() => {
        if (version() !== at) return false;
        const raw = o.raw.version();
        if (o.system.problem()) {
          // Limited: what is given stays in the record; a realm read as off because its secret cannot be opened keeps the
          // switch the record has.
          const record = o.raw.read();
          const held = new Set(kept().map((n) => n.split('.')[1]));
          const realms = next.realms.map((r) => {
            const was = record.realms.find((x) => x.name === r.name);
            if (!was || !held.has(r.name) || !settingsOf(r).every((k) => r[k] === undefined)) return r;
            const { enabled: _off, ...rest } = r;
            return (was.enabled === undefined ? rest : { ...rest, enabled: was.enabled }) as StoredRealm;
          });
          return o.raw.write({ ...next, realms }, raw);
        }
        const now = read();
        const wanted = new Map(secretsIn(next).map((s) => [s.name as string, s.value]));
        const had = new Map(secretsIn(now).map((s) => [s.name as string, s.value]));
        for (const [name, value] of wanted) {
          if (had.get(name) === value && o.system.stored(name as SystemSecretName) !== undefined) continue;
          const r = o.system.keep(name as SystemSecretName, value, 'the sign-in config');
          if (!r.ok) throw new Error(`sign-in: ${name}: ${r.error}`);
        }
        for (const name of kept()) if (!wanted.has(name)) o.system.drop(name as SystemSecretName, 'the sign-in config');
        return o.raw.write(withoutSecrets(next), raw);
      });
    },
  };
}
