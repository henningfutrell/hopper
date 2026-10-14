// Vault grants (issue #652, requirement 5, design.md "Vault grants"): a user's vault, wherever it runs, gives a box's job
// — or a job's Windows sandbox step (issue #731) — nothing — no vault secret, no minted credential — until a person granted that job's item the vault. The ask passes the
// same checks as any delivery first (box.ts): a refusal there is the vault's own, with its own reason. A job of a box with
// no grant is refused, and the hopper asks a person: a grant ask, kept in memory, shown on the Vault page, one event per
// job. A person grants or revokes through the UI session, after Access (the route's); the grant is kept for the item, so
// Run again and Rework keep it. The template's approved scope still bounds what a granted job gets: the vault decides that.
// A person, or a delegate approver (issue #1138), may deny an ask instead: it goes, and that job asks no more.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { directIdOf, grantItemOf, grantKeyOf, grantView, noGrant, type VaultGrantAsk } from '../domain/vault-grants.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { AT_WORK, boxAsk, type ClientTarget } from './box.ts';
import type { VaultResult } from './service.ts';
import type { Vault } from './vault.ts';

export function withVaultGrants(v: Vault, o: {
  store: Pick<UserStore, 'events' | 'jobs' | 'vaultGrants' | 'tx' | 'directJobs'>;
  clock: Clock;
  targets: () => ClientTarget[];
  holds: (parts: ProxyTokenParts) => boolean;
  /** Whether a box step of the job runs on the machine now (issue #1004). */
  stepsOn?: (jobId: string, machine: string) => boolean;
}): Vault {
  const { events, jobs, vaultGrants } = o.store;
  /** The open asks, by job. */
  const asks = new Map<string, VaultGrantAsk>();
  /** The jobs whose ask a person denied (issue #1138): still refused, they ask no more. */
  const denied = new Set<string>();

  /** Records that `job` asked for `name` with no grant, from `where`: one ask per job, one event. */
  function ask(job: Job, name: string, where: { machine: string; template: string } | { windowsHost: string }): void {
    if (denied.has(job.id)) return;
    const open = asks.get(job.id);
    if (open) {
      if (!open.names.includes(name)) open.names.push(name);
      return;
    }
    asks.set(job.id, { job: job.id, key: grantKeyOf(job), ...where, names: [name], askedAt: o.clock.now().toISOString() });
    events.append({ type: 'vault.grant_asked', jobId: job.id, ...('machine' in where ? { machineId: where.machine } : {}), data: { job: job.id, key: grantKeyOf(job), ...where, name } });
  }

  /** Undefined: the vault answers (no box, or granted). Else the refusal, after the ask is recorded. */
  function gate(token: string, machineKey: string, name: string): { machine: string; template: string; job: string; reason: string } | undefined {
    const box = boxAsk({ targets: o.targets, holds: o.holds, ...(o.stepsOn ? { stepsOn: o.stepsOn } : {}), job: (id) => jobs.get(id), holdsTemplate: (t) => v.view().templates.some((x) => x.name === t) }, token, machineKey);
    if ('refused' in box) return undefined;
    const { machine: m, job } = box;
    if (vaultGrants.get(grantKeyOf(job))) return undefined;
    ask(job, name, { machine: m.name, template: m.template });
    return { machine: m.name, template: m.template, job: job.id, reason: noGrant(job.id) };
  }

  /** The asks of jobs still at work whose item has no grant. */
  const open = (): VaultGrantAsk[] => [...asks.values()].filter((a) => {
    const at = AT_WORK.includes(jobs.get(a.job)?.status ?? '') && !vaultGrants.get(a.key);
    if (!at) asks.delete(a.job);
    return at;
  }).map((a) => ({ ...a, names: [...a.names] }));

  /** The item a key names (issue #1124): its newest job — a job of no source is its own key — and a direct job's submission. */
  const itemOf = (key: string) => {
    const id = directIdOf(key);
    return { newest: jobs.getBySourceKey(key) ?? jobs.get(key), direct: id ? o.store.directJobs.get(id) : undefined };
  };

  const missing = (jobId: string): VaultResult => ({ ok: false, code: 'not_found', error: `job ${jobId} not found` });

  return {
    ...v,
    // Each ask and grant names what it covers (issue #1124): the item's title, repository, link and newest job.
    view: () => ({
      ...v.view(),
      grantAsks: open().map((a) => ({ ...a, item: grantItemOf(a.key, itemOf(a.key)) })),
      grants: vaultGrants.list().map((g) => grantView(g, itemOf(g.key))),
    }),
    async deliver(ask, machineKey) {
      const refused = gate(ask.token, machineKey, ask.name);
      if (!refused) return v.deliver(ask, machineKey);
      events.append({ type: 'vault.refused', jobId: refused.job, machineId: refused.machine, data: { name: ask.name, machine: refused.machine, template: refused.template, job: refused.job, reason: refused.reason } });
      return { refused: refused.reason };
    },
    // A Windows sandbox step's secret (issue #731): the same grant, for the job whose step it is.
    async forStep(a) {
      const job = jobs.get(a.job);
      if (job && !vaultGrants.get(grantKeyOf(job))) {
        ask(job, a.name, { windowsHost: a.host });
        const reason = noGrant(job.id);
        events.append({ type: 'vault.step_refused', jobId: job.id, data: { name: a.name, host: a.host, job: job.id, reason } });
        return { refused: reason };
      }
      return v.forStep(a);
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
    denyGrant(jobId, by) {
      const job = jobs.get(jobId);
      if (!job) return missing(jobId);
      if (!open().some((a) => a.job === job.id)) return { ok: false, code: 'conflict', error: `no grant ask waits for job ${jobId}` };
      asks.delete(job.id);
      denied.add(job.id);
      events.append({ type: 'vault.grant_denied', jobId: job.id, data: { job: job.id, key: grantKeyOf(job), by } });
      return { ok: true };
    },
  };
}
