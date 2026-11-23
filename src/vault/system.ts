// The vault's system scope (issues #657, #658, design.md "The vault's system scope"): the hopper's own secrets, in a
// vault's table as `system/<name>` — a user's (their TypeSafe API key, their GitHub connection's tokens, their webhook
// subscriptions' signing secrets) or the whole hopper's (its sign-in realms' secrets, the instance's vault) —, sealed
// with the hopper's sealer under the master key (src/secrets/sealer.ts, bound to `vault:<id>/value`), never in clear:
// without the master key (the hopper limited, issue #659) none is kept. Only the hopper
// opens one, in its own process, at the moment it uses it. One way in: `keep` is the only code that writes a value, so a
// set, a replace, a renewal and a rotation are one path, each an event. A read is an event too, at most once an hour per
// secret (`READ_EVENT_EVERY_MS`): the hopper reads its GitHub token at every source poll. A person's change is the
// user's or an admin's, decided by Access (OpenFGA) each time; the vault's own operations list none and give none to a
// job (service.ts). Nothing here logs, answers or appends a value.
//
// A secret a person gives (the TypeSafe API key, a webhook's signing secret) may instead be kept in a vault backend
// (issue #658 requirement 6, design.md "System secrets in a vault backend"): the row keeps only where, no value. A
// backend reads asynchronously and the hopper reads its own secrets synchronously, so the value is read at start, when it
// is set and at each refresh (`BACKEND_READ_EVERY_MS`), and held in this process's memory only. A read that fails drops
// what was held: no stale or local copy stands in.
import { ACCESS_UNAVAILABLE, type Requester, type VaultAccess } from '../domain/access.ts';
import type { Clock, VaultRepository } from '../domain/ports.ts';
import type { NewEvent } from '../domain/types.ts';
import { isSystemSecret, systemBackendRefusal, systemSecretKind, systemSecretName, systemSecretRow, VAULT_VALUE_MAX, type SystemSecretName, type ConfiguredBackend, type SystemSecretView, type VaultSecret } from '../domain/vault.ts';
import { PREVIOUS_KEYS_VARIABLE, MASTER_KEY_VARIABLE } from '../secrets/token-box.ts';
import { SecretUnreadable, type SealerState } from '../secrets/sealer.ts';
import type { VaultResult } from './service.ts';
import { resealRows, vaultContext } from './reseal.ts';

/** How often a read of one system secret is an event: the hopper reads some of them every few seconds. */
export const READ_EVENT_EVERY_MS = 60 * 60_000;

/** How often the hopper reads again each system secret kept in a vault backend: a value changed there applies within it. */
export const BACKEND_READ_EVERY_MS = 5 * 60_000;

/** Who asks to change a system secret: the user signed in, and whether as an admin; `by` names them in the event. */
export interface SystemChanger { userId: string; admin: boolean; by: string }

/** A system secret's metadata: who set it and when, and its last 4 characters. Never its value. */
export interface SystemSecretMeta { setBy: string; setAt: string; last4?: string }

/** How a value is kept: `rotated` when the hopper made or renewed it. */
export interface KeepHow { rotated?: boolean }

export interface SystemSecrets {
  /** Its value, opened now, read by the hopper for `purpose`; undefined when none is stored. Throws SecretUnreadable when it cannot be opened. */
  open(name: SystemSecretName, purpose?: string): string | undefined;
  /** Its value as stored (sealed): what a compare-and-swap compares, never opened. Undefined when none is stored. */
  stored(name: SystemSecretName): string | undefined;
  meta(name: SystemSecretName): SystemSecretMeta | undefined;
  /** Seals and keeps `value`, after Access allows the change. */
  set(name: SystemSecretName, value: string, who: SystemChanger): Promise<SystemResult>;
  /** Removes it, after Access allows the change. */
  remove(name: SystemSecretName, who: SystemChanger): Promise<SystemResult>;
  /** Keeps `value` as the hopper itself: the one way a value is written (a renewal, a migration, an edit already allowed). */
  keep(name: SystemSecretName, value: string, by: string, how?: KeepHow): SystemResult;
  /** Removes it as the hopper itself (its subscription removed, its connection ended); false when none was kept. */
  drop(name: SystemSecretName, by: string): boolean;
  /** Keeps it in vault backend `backend` at `reference` in place of a value, after Access allows the change and the backend reads it. */
  keepInBackend(name: SystemSecretName, backend: string, reference: string, who: SystemChanger): Promise<SystemResult>;
  /** Where a vault backend keeps it; undefined when the hopper keeps it, or none is kept. */
  keptIn(name: SystemSecretName): { name: string; reference: string } | undefined;
  /** Reads again each one kept in a vault backend. Each that cannot be read, and why: what it held is dropped. Never a value. */
  refresh(): Promise<{ name: string; problem: string }[]>;
  /** Keeps `value` moved from where it was kept before (issue #658), opens it again to check it, and records the move. */
  migrate(name: SystemSecretName, value: string, from: string): SystemResult;
  /** The system secrets kept, as their page shows them: never a value. */
  list(): SystemSecretView[];
  /** Why none can be stored or opened now (no master key); undefined when one can. */
  problem(): string | undefined;
  /** Seals again, under the current master key, every system secret an older one sealed. How many. */
  resealAll(): number;
  /** The start check: each system secret that cannot be opened, and the key it needs. Never a value. */
  check(): { name: string; problem: string }[];
}

/** A vault result, or Access refusing the change. */
export type SystemResult = VaultResult | { ok: false; code: 'forbidden'; error: string };

const fail = (code: 'invalid' | 'not_found' | 'conflict' | 'forbidden' | 'unavailable', error: string): SystemResult => ({ ok: false, code, error });

/** What a value that cannot be opened needs: the key, never a new value (design.md "A connection's health"). */
function needs(e: SecretUnreadable, problem: string | undefined): string {
  if (problem) return problem;
  const id = /sealed under key (\w+)/.exec(e.message)?.[1];
  return id ? `the key it was sealed under (${id}): neither ${MASTER_KEY_VARIABLE} nor ${PREVIOUS_KEYS_VARIABLE} gives it` : e.message;
}

export function createSystemSecrets(o: {
  store: { vault: Pick<VaultRepository, 'list' | 'get' | 'add' | 'replace' | 'sealed' | 'remove'>; events: { append(e: NewEvent): unknown }; tx<T>(fn: () => T): T };
  /** The hopper's sealer under the master key: the vault's own key provider may be another. */
  keys: SealerState;
  /** Whom the secrets are kept for, as Access names them: a user's id. */
  userId: string;
  /** `instance`: the whole hopper's vault (the sign-in realms' secrets). */
  scope?: 'user' | 'instance';
  access?: VaultAccess;
  /** The vault backends the user's plugins config names now (issue #585); none when absent. */
  backends?: () => ConfiguredBackend[];
  clock: Clock;
  idGen: () => string;
  logger: { warn(line: string): void };
}): SystemSecrets {
  const { vault, events } = o.store;
  const { sealer } = o.keys;
  const unavailable = (): string => `the hopper cannot store a system secret: ${o.keys.problem}`;
  const lastRead = new Map<string, number>();
  const problems = new Map<string, string>();
  /** The values read from vault backends: in this process's memory only. */
  const held = new Map<string, string>();

  /** Access's answer for a change; a deny when there is no Access. OpenFGA not asked is `unavailable` (a 503), never a refusal (issue #696). */
  async function allowed(name: SystemSecretName, who: SystemChanger): Promise<SystemResult> {
    if (!o.access) return fail('unavailable', 'access is not part of this hopper: no system secret can be changed');
    const requester: Requester = { kind: 'user', userId: who.userId };
    const d = await o.access.decideSystemSecret({ requester, owner: o.userId, name, action: 'change', admin: who.admin });
    if (d.unavailable) return fail('unavailable', `${ACCESS_UNAVAILABLE}: ${d.reason}`);
    return d.allowed ? { ok: true } : fail('forbidden', `access refused: ${d.reason}`);
  }

  /** The value of row `s`, opened, or as last read from its backend; throws SecretUnreadable. */
  function opened(s: VaultSecret): string {
    if (s.backend) {
      const name = systemSecretName(s.name);
      const value = held.get(name);
      if (value === undefined) throw new SecretUnreadable(`the ${name} system secret ${problems.get(name) ?? `is not read from vault backend ${s.backend.name} yet`}`);
      return value;
    }
    const stored = vault.sealed(s.id) ?? '';
    if (!sealer) throw new SecretUnreadable(`the ${systemSecretName(s.name)} system secret cannot be opened: ${o.keys.problem}`);
    return sealer.open(stored, vaultContext(s.id));
  }

  function write(name: SystemSecretName, value: string, by: string, how: KeepHow, event: (row: string, replaced: boolean) => NewEvent): SystemResult {
    if (value.length === 0 || value.length > VAULT_VALUE_MAX) return fail('invalid', `the value must be 1 to ${VAULT_VALUE_MAX} characters`);
    if (!sealer) return fail('unavailable', unavailable());
    const row = systemSecretRow(name);
    const at = o.clock.now().toISOString();
    return o.store.tx(() => {
      const was = vault.get(row);
      const id = was?.id ?? o.idGen();
      const sealed = sealer.seal(value, vaultContext(id));
      const meta = { last4: value.slice(-4) };
      if (was) {
        // A value given here keeps it in the hopper again, in place of a backend.
        const { last4: _l, backend: _b, ...rest } = was;
        vault.replace({ ...rest, ...meta, changedBy: by, changedAt: at }, sealed);
      } else {
        vault.add({ id, name: row, ...meta, setBy: by, createdAt: at, changedBy: by, changedAt: at }, sealed);
      }
      problems.delete(name);
      held.delete(name);
      events.append(event(row, was !== undefined));
      return { ok: true } as const;
    });
  }

  const keep = (name: SystemSecretName, value: string, by: string, how: KeepHow = {}): SystemResult => {
    const at = vault.get(systemSecretRow(name))?.backend;
    if (at && how.rotated) return fail('conflict', `${name} is kept in vault backend ${at.name} at ${at.reference}: rotate it there`);
    return write(name, value, by, how, (row, replaced) => ({ type: 'vault.secret_set', data: { name: row, by, replaced, ...(how.rotated ? { rotated: true } : {}) } }));
  };

  /** The value `at` points at, read in its backend now; or why not, without the backend's name. Never a value in the reason. */
  async function readIn(at: { name: string; reference: string }): Promise<{ value: string } | { problem: string }> {
    const b = (o.backends?.() ?? []).find((x) => x.name === at.name);
    if (!b) return { problem: 'it is not in the plugins config: add it again in Plugins' };
    if (!b.backend) return { problem: `it cannot run: ${b.problem ?? 'unknown'}` };
    try {
      return { value: await b.backend.read(at.reference) };
    } catch (e) {
      return { problem: (e as Error).message };
    }
  }

  async function keepInBackend(name: SystemSecretName, backend: string, reference: string, who: SystemChanger): Promise<SystemResult> {
    const refused = systemBackendRefusal(name);
    if (refused) return fail('invalid', refused);
    const b = (o.backends?.() ?? []).find((x) => x.name === backend);
    if (!b) return fail('invalid', `no vault backend ${backend}: add it in Plugins first`);
    const bad = b.backend?.check(reference);
    if (bad) return fail('invalid', `${backend}: ${bad}`);
    const may = await allowed(name, who);
    if (!may.ok) return may;
    const read = await readIn({ name: backend, reference });
    if ('problem' in read) return fail('invalid', `${name} is not kept in vault backend ${backend}: it cannot read ${reference}: ${read.problem}`);
    const row = systemSecretRow(name);
    const at = o.clock.now().toISOString();
    return o.store.tx(() => {
      const was = vault.get(row);
      const where = { backend: { name: backend, reference } };
      if (was) {
        const { last4: _l, backend: _b, ...rest } = was;
        vault.replace({ ...rest, ...where, changedBy: who.by, changedAt: at }, null);
      } else {
        vault.add({ id: o.idGen(), name: row, ...where, setBy: who.by, createdAt: at, changedBy: who.by, changedAt: at }, null);
      }
      held.set(name, read.value);
      problems.delete(name);
      events.append({ type: 'vault.secret_set', data: { name: row, by: who.by, replaced: was !== undefined, backend } });
      return { ok: true } as const;
    });
  }

  async function refresh(): Promise<{ name: string; problem: string }[]> {
    const out: { name: string; problem: string }[] = [];
    for (const s of vault.list()) {
      if (!isSystemSecret(s.name) || !s.backend) continue;
      const name = systemSecretName(s.name);
      const read = await readIn(s.backend);
      // Set or changed meanwhile: what this read found is not its value any more.
      const now = vault.get(s.name);
      if (now?.backend?.name !== s.backend.name || now.backend.reference !== s.backend.reference) continue;
      if ('value' in read) {
        held.set(name, read.value);
        problems.delete(name);
        continue;
      }
      held.delete(name);
      const problem = `cannot be read from vault backend ${s.backend.name} at ${s.backend.reference}: ${read.problem}`;
      if (problems.get(name) !== problem) o.logger.warn(`hopper: system secret ${name} ${problem}`);
      problems.set(name, problem);
      out.push({ name, problem });
    }
    return out;
  }

  function drop(name: SystemSecretName, by: string): boolean {
    const row = systemSecretRow(name);
    return o.store.tx(() => {
      if (!vault.remove(row)) return false;
      problems.delete(name);
      held.delete(name);
      events.append({ type: 'vault.secret_removed', data: { name: row, by } });
      return true;
    });
  }

  return {
    open(name, purpose) {
      const s = vault.get(systemSecretRow(name));
      if (!s) return undefined;
      const value = opened(s);
      const now = o.clock.now().getTime();
      if (now - (lastRead.get(name) ?? -Infinity) >= READ_EVENT_EVERY_MS) {
        lastRead.set(name, now);
        events.append({ type: 'vault.secret_read', data: { name: s.name, by: 'hopper', ...(purpose ? { purpose } : {}) } });
      }
      return value;
    },
    stored(name) {
      const s = vault.get(systemSecretRow(name));
      return s ? vault.sealed(s.id) : undefined;
    },
    meta(name) {
      const s = vault.get(systemSecretRow(name));
      return s ? { setBy: s.changedBy, setAt: s.changedAt, ...(s.last4 ? { last4: s.last4 } : {}) } : undefined;
    },
    async set(name, value, who) {
      if (value.length === 0 || value.length > VAULT_VALUE_MAX) return fail('invalid', `the value must be 1 to ${VAULT_VALUE_MAX} characters`);
      const may = await allowed(name, who);
      return may.ok ? keep(name, value, who.by) : may;
    },
    async remove(name, who) {
      if (!vault.get(systemSecretRow(name))) return fail('not_found', `no ${name} is set`);
      const may = await allowed(name, who);
      if (!may.ok) return may;
      return drop(name, who.by) ? { ok: true } : fail('not_found', `no ${name} is set`);
    },
    keep,
    keepInBackend,
    keptIn: (name) => vault.get(systemSecretRow(name))?.backend,
    refresh,
    drop,
    migrate(name, value, from) {
      const kept = write(name, value, 'hopper', {}, (row) => ({ type: 'vault.secret_migrated', data: { name: row, from } }));
      if (!kept.ok) return kept;
      // Opened again before the old copy goes: a value that does not come back as it went in is not moved.
      const s = vault.get(systemSecretRow(name));
      let back: string | undefined;
      try { back = s ? opened(s) : undefined; } catch { back = undefined; }
      return back === value ? kept : fail('unavailable', `${name} did not open again as it was kept: the old copy is kept`);
    },
    list() {
      return vault.list().filter((s) => isSystemSecret(s.name)).map((s) => {
        const name = systemSecretName(s.name);
        const problem = problems.get(name);
        const last4 = s.backend ? held.get(name)?.slice(-4) : s.last4;
        return {
          name, kind: systemSecretKind(name), scope: o.scope ?? 'user', setBy: s.changedBy, setAt: s.changedAt,
          ...(last4 ? { last4 } : {}), ...(problem ? { problem } : {}), ...(s.backend ? { backend: s.backend } : {}),
        };
      });
    },
    problem: () => (sealer ? undefined : unavailable()),
    resealAll: () => resealRows({ vault, sealer, mine: isSystemSecret, what: 'system secret', logger: o.logger }),
    check() {
      const out: { name: string; problem: string }[] = [];
      for (const s of vault.list()) {
        // One kept in a vault backend is checked by its read (`refresh`), not here.
        if (!isSystemSecret(s.name) || s.backend) continue;
        const name = systemSecretName(s.name);
        try {
          opened(s);
          problems.delete(name);
        } catch (e) {
          if (!(e instanceof SecretUnreadable)) throw e;
          const problem = `cannot be opened: ${needs(e, o.keys.problem)}`;
          problems.set(name, problem);
          out.push({ name, problem });
        }
      }
      return out;
    },
  };
}
