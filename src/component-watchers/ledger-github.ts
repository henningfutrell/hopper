// The ledger-vs-GitHub watcher (issue #1077, design.md "Component watchers"): the first component watcher. Each check
// samples the work-item ledger (#1067), reads those issues and pull requests on GitHub in batches, and answers the drift
// (`ledgerGitHubDrift`, src/domain/drift.ts). With no GitHub connection, the check fails and says why.
import { LEDGER_GITHUB, ledgerGitHubDrift, ledgerGitHubSample } from '../domain/drift.ts';
import type { WorkItemLedger } from '../domain/work-items.ts';
import type { GitHubStates } from './github.ts';
import type { ComponentWatcher } from './service.ts';

/** How often it checks: 15 minutes. */
export const LEDGER_GITHUB_INTERVAL_MS = 15 * 60_000;
/** A close or a merge on GitHub newer than this is no drift yet: the hopper's own follow may not have seen it. */
export const LEDGER_GITHUB_GRACE_MS = 10 * 60_000;

export function ledgerGitHubWatcher(o: {
  ledger: Pick<WorkItemLedger, 'list'>;
  github(): GitHubStates | { problem: string };
  now(): string;
  intervalMs?: number;
  graceMs?: number;
}): ComponentWatcher {
  return {
    name: LEDGER_GITHUB,
    component: 'the work-item ledger',
    truth: 'GitHub',
    intervalMs: o.intervalMs ?? LEDGER_GITHUB_INTERVAL_MS,
    async check() {
      const github = o.github();
      if ('problem' in github) throw new Error(github.problem);
      const items = o.ledger.list();
      const now = o.now();
      const urls = ledgerGitHubSample(items, now);
      const reads = urls.length === 0 ? new Map() : await github.states(urls);
      return ledgerGitHubDrift(items, reads, now, o.graceMs ?? LEDGER_GITHUB_GRACE_MS);
    },
  };
}
