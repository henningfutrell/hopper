// The system scope on Settings → Vault (issue #658, design.md "The vault's system scope"): the hopper's own secrets, the
// user's and the whole hopper's, as metadata — kind, last 4 characters, who set it and when, whether it can be opened —
// and the one audit trail of them: every set, replace, rotation, removal, move, read by the hopper and refused ask of a
// job, from the user's event log. Never a value.
import type { EventLog } from '../domain/ports.ts';
import type { DomainEvent, EventType } from '../domain/types.ts';
import { isSystemSecret, systemSecretName, type SystemSecretAudit, type VaultView } from '../domain/vault.ts';
import type { SystemSecrets } from './system.ts';
import type { Vault } from './vault.ts';

/** How many audit entries the view carries, newest first. */
export const SYSTEM_AUDIT_SHOWN = 50;
const AUDITED: readonly EventType[] = ['vault.secret_set', 'vault.secret_removed', 'vault.secret_read', 'vault.secret_migrated', 'vault.refused'];

/** What an audit entry says beyond its type: never a value. */
function detailOf(e: DomainEvent): string | undefined {
  const d = e.data as { replaced?: boolean; rotated?: boolean; purpose?: string; from?: string; reason?: string; job?: string };
  if (e.type === 'vault.secret_set') return d.rotated ? 'rotated' : d.replaced ? 'replaced' : 'set';
  if (e.type === 'vault.secret_read') return d.purpose;
  if (e.type === 'vault.secret_migrated') return d.from ? `moved from ${d.from}` : undefined;
  if (e.type === 'vault.refused') return `a job's ask refused${d.job ? ` (job ${d.job})` : ''}: ${d.reason ?? ''}`;
  return undefined;
}

export function systemAudit(events: Pick<EventLog, 'recent'>): SystemSecretAudit[] {
  return events.recent(1000, [...AUDITED])
    .filter((e) => isSystemSecret(String((e.data as { name?: unknown }).name ?? '')))
    .slice(0, SYSTEM_AUDIT_SHOWN)
    .map((e) => {
      const d = e.data as { name: string; by?: string };
      const detail = detailOf(e);
      return { seq: e.seq, at: e.at, type: e.type, name: systemSecretName(d.name), ...(d.by ? { by: d.by } : {}), ...(detail ? { detail } : {}) };
    });
}

export function systemScopeView(o: { system: SystemSecrets; instance?: SystemSecrets; events: Pick<EventLog, 'recent'> }): NonNullable<VaultView['system']> {
  return { secrets: [...o.system.list(), ...(o.instance?.list() ?? [])], audit: systemAudit(o.events) };
}

/** The vault, its view carrying the system scope. */
export function withSystemScope(v: Vault, o: { system: SystemSecrets; instance?: SystemSecrets; events: Pick<EventLog, 'recent'> }): Vault {
  return { ...v, view: () => ({ ...v.view(), system: systemScopeView(o) }) };
}
