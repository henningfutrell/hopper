// Vault grants (issue #652, requirement 5, design.md "Vault grants"): a user's vault, wherever it runs, gives a box's job
// nothing — no vault secret, no minted credential — until a person granted that job's item the vault. The ask passes the
// same checks as any delivery first (box.ts): a refusal there is the vault's own, with its own reason. A job of a box with
// no grant is refused, and the hopper asks a person: a grant ask, kept in memory, shown on the Vault page, one event per
// job. A person grants or revokes through the UI session, after Access (the route's); the grant is kept for the item, so
// Run again and Rework keep it. The template's approved scope still bounds what a granted job gets: the vault decides that.
import type { Clock, UserStore } from '../domain/ports.ts';
import { grantKeyOf, noGrant, type VaultGrantAsk } from '../domain/vault-grants.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { AT_WORK, boxAsk, type ClientTarget } from './box.ts';
import type { VaultResult } from './service.ts';
import type { Vault } from './vault.ts';

export function withVaultGrants(v: Vault, o: {
  store: Pick<UserStore, 'events' | 'jobs' | 'vaultGrants' | 'tx'>;
  clock: Clock;
  targets: () => ClientTarget[];
  holds: (parts: ProxyTokenParts) => boolean;
}): Vault {
  const { events, jobs, vaultGrants } = o.store;
  /** The open asks, by job. */
  const asks = new Map<string, VaultGrantAsk>();

  /** Undefined: the vault answers (no box, or granted). Else the refusal, after the ask is recorded. */
  function gate(token: string, machineKey: string, name: string): { machine: string; template: string; job: string; reason: string } | undefined {
    const box = boxAsk({ targets: o.targets, holds: o.holds, job: (id) => jobs.get(id), holdsTemplate: (t) => v.view().templates.some((x) => x.name === t) }, token, machineKey);
    if ('refused' in box) return undefined;
    const { machine: m, job } = box;
    const key = grantKeyOf(job);
    if (vaultGrants.get(key)) return undefined;
    const open = asks.get(job.id);
    if (open) {
      if (!open.names.includes(name)) open.names.push(name);
    } else {
      asks.set(job.id, { job: job.id, key, machine: m.name, template: m.template, names: [name], askedAt: o.clock.now().toISOString() });
      events.append({ type: 'vault.grant_asked', jobId: job.id, machineId: m.name, data: { job: job.id, key, machine: m.name, template: m.template, name } });
    }
    return { machine: m.name, template: m.template, job: job.id, reason: noGrant(job.id) };
  }

  /** The asks of jobs still at work whose item has no grant. */
  const open = (): VaultGrantAsk[] => [...asks.values()].filter((a) => {
    const at = AT_WORK.includes(jobs.get(a.job)?.status ?? '') && !vaultGrants.get(a.key);
    if (!at) asks.delete(a.job);
    return at;
  }).map((a) => ({ ...a, names: [...a.names] }));

  const missing = (jobId: string): VaultResult => ({ ok: false, code: 'not_found', error: `job ${jobId} not found` });

  return {
    ...v,
    view: () => ({ ...v.view(), grantAsks: open(), grants: vaultGrants.list() }),
    async deliver(ask, machineKey) {
      const refused = gate(ask.token, machineKey, ask.name);
      if (!refused) return v.deliver(ask, machineKey);
      events.append({ type: 'vault.refused', jobId: refused.job, machineId: refused.machine, data: { name: ask.name, machine: refused.machine, template: refused.template, job: refused.job, reason: refused.reason } });
      return { refused: refused.reason };
    },
    async mint(ask, machineKey) {
      const refused = gate(ask.token, machineKey, `${ask.mint} ${ask.operation} ${ask.asset}`);
      if (!refused) return v.mint(ask, machineKey);
      events.append({
        type: 'vault.mint_refused', jobId: refused.job, machineId: refused.machine,
        data: { mint: { kind: ask.mint, operation: ask.operation, asset: ask.asset }, machine: refused.machine, template: refused.template, job: refused.job, reason: refused.reason },
      });
      return { refused: refused.reason };
    },
    grant(jobId, by) {
      const job = jobs.get(jobId);
      if (!job) return missing(jobId);
      const key = grantKeyOf(job);
      o.store.tx(() => {
        if (vaultGrants.get(key)) return;
        vaultGrants.put({ key, job: job.id, by, at: o.clock.now().toISOString() });
        events.append({ type: 'vault.granted', jobId: job.id, data: { job: job.id, key, by } });
      });
      for (const a of asks.values()) if (a.key === key) asks.delete(a.job);
      return { ok: true };
    },
    revokeGrant(jobId, by) {
      const job = jobs.get(jobId);
      if (!job) return missing(jobId);
      const key = grantKeyOf(job);
      const removed = o.store.tx(() => {
        if (!vaultGrants.remove(key)) return false;
        events.append({ type: 'vault.grant_revoked', jobId: job.id, data: { job: job.id, key, by } });
        return true;
      });
      return removed ? { ok: true } : { ok: false, code: 'conflict', error: `job ${jobId} has no vault grant to revoke` };
    },
  };
}
