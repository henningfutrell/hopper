// The watchers of the default branches and of the stack (issue #1077, design.md "Component watchers"). The
// default-branch-vs-checks watcher reads the head of each job repository's default branch on GitHub, with the user's own
// connection, in batches (`src/domain/drift-branches.ts`). The stack-health watcher reads the stack resources
// (`src/domain/drift-stack.ts`); it is the instance's, and answers an item only once two checks in a row found it, so a
// stack that starts or restarts with the hopper is no drift.
import { branchChecksDrift, BRANCH_CHECKS } from '../domain/drift-branches.ts';
import { STACK_HEALTH, stackHealthDrift } from '../domain/drift-stack.ts';
import { driftKey, type Drift } from '../domain/drift.ts';
import type { StackResources } from '../domain/stack-resources.ts';
import { NO_METER, NO_OPENFGA, NO_SOLR } from '../stack-resources/index.ts';
import type { GitHubBranches } from './github.ts';
import type { ComponentWatcher } from './service.ts';

/** How often the default branches are read: 15 minutes, as the ledger-vs-GitHub watcher. */
export const BRANCH_CHECKS_INTERVAL_MS = 15 * 60_000;
/** A head committed more recently than this is no drift yet: its checks may run again. */
export const BRANCH_CHECKS_GRACE_MS = 15 * 60_000;
/** How often the stack is read: 5 minutes. */
export const STACK_HEALTH_INTERVAL_MS = 5 * 60_000;

/** The problems that say the hopper is not given a part: no drift. */
const NOT_GIVEN: ReadonlySet<string> = new Set([NO_METER, NO_OPENFGA, NO_SOLR]);

export function branchChecksWatcher(o: {
  repositories(): readonly string[];
  github(): GitHubBranches | { problem: string };
  now(): string;
  intervalMs?: number;
  graceMs?: number;
}): ComponentWatcher {
  return {
    name: BRANCH_CHECKS,
    component: 'the job repositories\' default branches',
    truth: 'their checks on GitHub',
    intervalMs: o.intervalMs ?? BRANCH_CHECKS_INTERVAL_MS,
    async check() {
      const github = o.github();
      if ('problem' in github) throw new Error(github.problem);
      const repos = o.repositories();
      if (repos.length === 0) return [];
      return branchChecksDrift(await github.heads(repos), o.now(), o.graceMs ?? BRANCH_CHECKS_GRACE_MS);
    },
  };
}

export function stackHealthWatcher(o: { read(): Promise<StackResources>; now(): string; intervalMs?: number }): ComponentWatcher {
  let before = new Set<string>();
  return {
    name: STACK_HEALTH,
    component: 'the hopper\'s stack',
    truth: 'a healthy stack',
    intervalMs: o.intervalMs ?? STACK_HEALTH_INTERVAL_MS,
    instance: true,
    async check() {
      const found = stackHealthDrift(await o.read(), NOT_GIVEN, o.now());
      const id = (d: Drift, key: string) => `${driftKey(d)}/${key}`;
      const twice = found.map((d) => ({ ...d, items: d.items.filter((i) => before.has(id(d, i.key))) })).filter((d) => d.items.length > 0);
      before = new Set(found.flatMap((d) => d.items.map((i) => id(d, i.key))));
      return twice;
    },
  };
}
