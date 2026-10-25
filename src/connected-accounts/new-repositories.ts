// New repositories of one connected account (issue #2795, design.md "New repositories"): after each read of what the
// account reaches (installations.ts), the new-repository policy adds a new repository to the job repositories, and the
// source syncs, or holds it as a new-repository ask for a person (src/domain/new-repositories.ts). A change of the policy
// is applied at once to what the last read reached. Kept in the user's settings, by the account's key (keyed.ts).
import { findNewRepositories, type NewRepositoryAsk, type NewRepositoryChange, type NewRepositoryPolicy } from '../domain/new-repositories.ts';
import type { UserSettingsRepository } from '../domain/ports.ts';
import type { AppInstallation, ConnectedAccountProvider } from '../domain/types.ts';
import { PROVIDER_NAME } from './at-rest.ts';

export interface NewRepositoriesOptions {
  settings: Pick<UserSettingsRepository, 'getNewRepositories' | 'setNewRepositories' | 'getJobRepositories' | 'setJobRepositories'>;
  /** What the last read reached, for this account; undefined: not read yet. */
  reached(provider: ConnectedAccountProvider): AppInstallation[] | undefined;
  /** A repository another account has for its jobs (issue #1448); absent: none. */
  taken?(repository: string): boolean;
  now(): Date;
  log(line: string): void;
  /** The job repositories changed: the source syncs now. */
  changed(provider: ConnectedAccountProvider): void;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function createNewRepositories(o: NewRepositoriesOptions) {
  const found = (provider: ConnectedAccountProvider, installations: AppInstallation[]): void => {
    const chosen = o.settings.getJobRepositories(provider);
    const f = findNewRepositories(o.settings.getNewRepositories(provider), installations.flatMap((i) => i.repositories), chosen, (r) => o.taken?.(r) ?? false, o.now().toISOString());
    o.settings.setNewRepositories(provider, f.record);
    if (f.asked.length > 0) o.log(`hopper: ${PROVIDER_NAME[provider]} new repositories wait for a person in Sources: ${f.asked.join(', ')}`);
    if (f.accepted.length === 0) return;
    o.settings.setJobRepositories(provider, [...chosen, ...f.accepted]);
    o.log(`hopper: ${PROVIDER_NAME[provider]} new repositories added to the job repositories by the new-repository policy: ${f.accepted.join(', ')}`);
    o.changed(provider);
  };
  return {
    found,
    /** The policy and the open asks, as the account's status says them: never an ask of a job repository. */
    view(provider: ConnectedAccountProvider): { newRepositories: { policy: NewRepositoryPolicy; asks: NewRepositoryAsk[] } } {
      const r = o.settings.getNewRepositories(provider), chosen = o.settings.getJobRepositories(provider);
      return { newRepositories: { policy: r.policy, asks: r.asks.filter((a) => !chosen.some((c) => same(c, a.repository))) } };
    },
    change(provider: ConnectedAccountProvider, c: NewRepositoryChange): void {
      const r = o.settings.getNewRepositories(provider), dismiss = c.dismiss ?? [];
      o.settings.setNewRepositories(provider, { ...r, ...(c.policy ? { policy: c.policy } : {}), asks: r.asks.filter((a) => !dismiss.some((d) => same(d, a.repository))) });
      if (c.policy) o.log(`hopper: ${PROVIDER_NAME[provider]} new-repository policy set: ${c.policy.mode}, ${Object.keys(c.policy.owners).length} owners of their own`);
      const reached = o.reached(provider);
      if (c.policy && reached) found(provider, reached);
    },
  };
}
