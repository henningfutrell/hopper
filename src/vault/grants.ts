// Vault grants (issue #652, requirement 5, design.md "Vault grants"): a user's vault, wherever it runs, gives a box's job
// — or a job's Windows sandbox step (issue #731), or its box step (issue #1875) — nothing — no vault secret, no minted credential — until a person granted that job's item the vault. The ask passes the
// same checks as any delivery first (box.ts): a refusal there is the vault's own, with its own reason. A job of a box with
// no grant is refused, and the hopper asks a person: a grant ask, kept in memory, shown on the Vault page, one event per
// job. A person grants or revokes through the UI session, after Access (the route's); the grant is kept for the item, so
// Run again and Rework keep it. The template's approved scope still bounds what a granted job gets: the vault decides that.
// A person, or a delegate approver (issue #1138), may deny an ask instead: it goes, and that job asks no more.
// The standing read grant (issue #1472), the user's setting, off by default, is the one grant no person makes: on, a job
// on a box of a template whose needs the read policy holds entirely as reads gets the vault with no person, one
// `vault.granted` event for each job. It covers that box only, and that job only, until it ends; turned off, it grants
// no job that has not asked yet. A job whose trust stamp is below `approved` (issue #655 part 7) gets none: a person grants it.
// Nor does a job on a template that sandbox strictness (brake 2, part 8) asks a person for.
// Scope grants (issue #2923): a person's grant of a job's ask is kept for the ask's scope — its template or Windows
// host, and the job's repository —, so a later job that asks from the same scope gets the vault with no person, one
// `vault.granted` for each job, under the same brakes as the standing read grant. Revoke ends it at the next ask. A grant
// of an item whose newest job ended goes by itself (`vault.grant_revoked`, `by` `its job ended`), so no stale row piles up.
import type { Clock, UserStore } from '../domain/ports.ts';
import { jobBrake } from '../domain/intake-strictness.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import { ENDED_BY, scopeGrantView, scopeKeyOf, scopeOf, scopeBy, withJob, type VaultPlace } from '../domain/vault-scope-grants.ts';
import { directIdOf, grantItemOf, grantKeyOf, grantView, noGrant, readsOnlyInPolicy, STANDING_READ_GRANTER, type VaultGrantAsk } from '../domain/vault-grants.ts';
import { DEFAULT_SANDBOX_STRICTNESS, personBrake } from '../domain/sandbox-strictness.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { AT_WORK, boxAsk, type ClientTarget } from './box.ts';
import type { VaultResult } from './service.ts';
import type { Vault } from './vault.ts';

export function withVaultGrants(v: Vault, o: {
  store: Pick<UserStore, 'events' | 'jobs' | 'vaultGrants' | 'vaultScopeGrants' | 'tx' | 'directJobs' | 'settings'>;
  clock: Clock;
  targets: () => ClientTarget[];
  holds: (parts: ProxyTokenParts) => boolean;
  /** The jobs a person denied. Default: a set of its own. */
  denied?: Set<string>;
}): Vault {
  const { events, jobs, vaultGrants, vaultScopeGrants: scopes } = o.store;
  /** The open asks, by job. */
  const asks = new Map<string, VaultGrantAsk>();
  /** The jobs whose ask a person denied (issue #1138): still refused, they ask no more. */
  const denied = o.denied ?? new Set<string>();
  /** The jobs the standing read grant granted (issue #1472): each keeps it while at work, whatever the setting is now. */
  const standing = new Set<string>();

  /**
   * Whether the standing read grant lets `job` ask from a box of `template`: recorded once for each job. Never for a job
   * below `approved` or its intake strictness (issue #655 parts 7, 12), one it granted before too, nor for a template sandbox strictness (brake 2, part
   * 8) asks a person for.
   */
  function standingGrant(job: Job, template: string): boolean {
    if (!noPersonFor(job, { template })) return false;
    const t = v.view().templates.find((x) => x.name === template);
    if (!t || !readsOnlyInPolicy(t, o.store.settings.getReadPolicy())) return false;
    if (standing.has(job.id)) return true;
    if (o.store.settings.getSandboxApprovals()?.standingReadGrant !== true) return false;
    for (const id of standing) if (!AT_WORK.includes(jobs.get(id)?.status ?? '')) standing.delete(id);
    standing.add(job.id);
    events.append({ type: 'vault.granted', jobId: job.id, data: { job: job.id, key: grantKeyOf(job), by: STANDING_READ_GRANTER } });
    return true;
  }

  /**
   * Whether a grant no person makes now may cover `job` from `place`: never below `approved` or its intake strictness
   * (issue #655 parts 7, 12), nor on a template sandbox strictness (brake 2, part 8) asks a person for.
   */
  function noPersonFor(job: Job, place: VaultPlace): boolean {
    if (jobs.gate2Hold(job, jobBrake(o.store.settings.getIntakeStrictness(), job)) !== undefined) return false;
    if (!('template' in place)) return true;
    const t = v.view().templates.find((x) => x.name === place.template);
    return !t || !personBrake(o.store.settings.getSandboxStrictness() ?? DEFAULT_SANDBOX_STRICTNESS, t);
  }

  /** Whether a person's scope grant covers `job`'s ask from `place` (issue #2923): `vault.granted` once for each job. */
  function scopeGrant(job: Job, place: VaultPlace): boolean {
    const g = scopes.get(scopeKeyOf(scopeOf(job, place)));
    if (!g || !noPersonFor(job, place)) return false;
    const added = withJob(g, job.id);
    if (added) o.store.tx(() => {
      scopes.put(added);
      events.append({ type: 'vault.granted', jobId: job.id, data: { job: job.id, key: grantKeyOf(job), by: scopeBy(g), scope: g.key } });
    });
    return true;
  }

  /** Whether `job` may use the vault from `place`: its item's grant, or a scope grant of the scope. */
  const granted = (job: Job, place: VaultPlace): boolean => vaultGrants.get(grantKeyOf(job)) !== undefined || scopeGrant(job, place);

  /** The place an open ask of `job` names, if any. */
  const placeOf = (a: VaultGrantAsk | undefined): VaultPlace | undefined =>
    a?.template !== undefined ? { template: a.template } : a?.windowsHost !== undefined ? { windowsHost: a.windowsHost } : undefined;

  /**
   * Takes back each grant of an item whose newest job ended (issue #2923): it gives nothing, and Run again asks again. Not
   * a direct job's that its submission made: the submission authorized the vault for its item, Run again too.
   */
  function expireEnded(): void {
    for (const g of vaultGrants.list()) {
      const item = itemOf(g.key), newest = item.newest;
      if (!newest || !TERMINAL_STATUSES.includes(newest.status) || grantView(g, item).made === 'submit') continue;
      o.store.tx(() => {
        if (vaultGrants.remove(g.key)) events.append({ type: 'vault.grant_revoked', jobId: newest.id, data: { job: newest.id, key: g.key, by: ENDED_BY } });
      });
    }
  }

  /** Records that `job` asked for `name` with no grant, from `where`: one ask per job, one event. */
  function ask(job: Job, name: string, where: { machine: string; template: string } | { windowsHost: string } | { box: string; template: string }): void {
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
    const box = boxAsk({ targets: o.targets, holds: o.holds, job: (id) => jobs.get(id), holdsTemplate: (t) => v.view().templates.some((x) => x.name === t) }, token, machineKey);
    if ('refused' in box) return undefined;
    const { machine: m, job } = box;
    if (granted(job, { template: m.template }) || standingGrant(job, m.template)) return undefined;
    ask(job, name, { machine: m.name, template: m.template });
    return { machine: m.name, template: m.template, job: job.id, reason: noGrant(job.id) };
  }

  /** The asks of jobs still at work, not quarantined (issue #655 part 6), whose item has no grant. */
  const open = (): VaultGrantAsk[] => [...asks.values()].filter((a) => {
    const job = jobs.get(a.job);
    const place = placeOf(a);
    const at = job !== undefined && AT_WORK.includes(job.status) && jobs.opensDoors(job) && !vaultGrants.get(a.key) && !(place && scopes.get(scopeKeyOf(scopeOf(job, place))));
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
    view: () => {
      expireEnded();
      return {
        ...v.view(),
        grantAsks: open().map((a) => ({ ...a, item: grantItemOf(a.key, itemOf(a.key)) })),
        grants: vaultGrants.list().map((g) => grantView(g, itemOf(g.key))),
        scopeGrants: scopes.list().map((g) => scopeGrantView(g, (id) => jobs.get(id))),
      };
    },
    async deliver(ask, machineKey) {
      const refused = gate(ask.token, machineKey, ask.name);
      if (!refused) return v.deliver(ask, machineKey);
      events.append({ type: 'vault.refused', jobId: refused.job, machineId: refused.machine, data: { name: ask.name, machine: refused.machine, template: refused.template, job: refused.job, reason: refused.reason } });
      return { refused: refused.reason };
    },
    // A Windows sandbox step's secret (issue #731): the same grant, for the job whose step it is.
    async forStep(a) {
      // A step schedule's run (issue #2716): its schedule's grant is the hopper's to check, before it asks.
      if (a.job === undefined) return v.forStep(a);
      const job = jobs.get(a.job);
      if (job && !granted(job, a.template !== undefined ? { template: a.template } : { windowsHost: a.host })) {
        ask(job, a.name, a.template !== undefined ? { box: a.host, template: a.template } : { windowsHost: a.host });
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
    grant(jobId, by, how = {}) {
      const job = jobs.get(jobId);
      if (!job) return missing(jobId);
      const key = grantKeyOf(job);
      // A grant of where the job asks from is a scope grant of that scope (issue #2923); with no place known, the item's.
      const place = how.item ? undefined : how.place ?? placeOf(asks.get(job.id));
      if (place) {
        const scope = scopeOf(job, place), scopeKey = scopeKeyOf(scope);
        o.store.tx(() => {
          const had = scopes.get(scopeKey);
          if (had && (had.runs || !how.runs)) return;
          scopes.put(had ? { ...had, runs: true } : { ...scope, key: scopeKey, by, at: o.clock.now().toISOString(), jobs: [job.id], ...(how.runs ? { runs: true as const } : {}) });
          events.append({ type: 'vault.granted', jobId: job.id, data: { job: job.id, key, by, scope: scopeKey } });
        });
        asks.delete(job.id);
        return { ok: true };
      }
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
    revokeScopeGrant(scopeKey, by) {
      const g = scopes.get(scopeKey);
      if (!g) return { ok: false, code: 'conflict', error: `no scope grant of ${scopeKey} to revoke` };
      const last = g.jobs.at(-1) ?? '';
      o.store.tx(() => {
        scopes.remove(scopeKey);
        events.append({ type: 'vault.grant_revoked', ...(last ? { jobId: last } : {}), data: { job: last, key: scopeKey, by, scope: scopeKey } });
      });
      return { ok: true };
    },
    denyGrant(jobId, by) {
      const job = jobs.get(jobId);
      if (!job) return missing(jobId);
      if (!open().some((a) => a.job === job.id)) return { ok: false, code: 'conflict', error: `no grant ask waits for job ${jobId}` };
      asks.delete(job.id);
      // A job no longer at work asks no more: its denial goes (issue #1402).
      for (const id of denied) if (!AT_WORK.includes(jobs.get(id)?.status ?? '')) denied.delete(id);
      denied.add(job.id);
      events.append({ type: 'vault.grant_denied', jobId: job.id, data: { job: job.id, key: grantKeyOf(job), by } });
      return { ok: true };
    },
  };
}
