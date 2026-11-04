// The sweep of stale head branches (issue #2914, design.md "Head branch deletion"), the sync loop's half: in a round of every
// follow, after the census, at most once an hour, the source lists the branches of its job repositories and keeps a deletion
// for each stale one (`JobSource.sweepHeadBranches`). A pull request a job not ended names is left: that job may read its branch.
import { HEAD_BRANCH_SWEEP_EVERY_MS } from '../domain/head-branches.ts';
import type { JobSource } from '../domain/ports.ts';
import { ENDED_STATUSES, type Job } from '../domain/types.ts';
import type { AfterDoneContext } from './after-done.ts';

export function headBranchSweep(c: Pick<AfterDoneContext, 'store' | 'now'>) {
  /** When each source's last sweep worked, by its name. */
  const lastAt = new Map<string, number>();
  return async function sweep(source: JobSource, listed: Job[]): Promise<void> {
    if (!source.sweepHeadBranches || source.paused?.() !== undefined) return;
    const now = c.now();
    const last = lastAt.get(source.name);
    if (last !== undefined && now - last < HEAD_BRANCH_SWEEP_EVERY_MS) return;
    const live = new Set(listed.map((j) => c.store.jobs.get(j.id) ?? j).filter((j) => !(ENDED_STATUSES as readonly string[]).includes(j.status)).flatMap((j) => {
      const pr = (j.sourceState?.source as { pullRequest?: unknown } | undefined)?.pullRequest;
      return typeof pr === 'string' ? [pr.toLowerCase()] : [];
    }));
    try {
      if (await source.sweepHeadBranches({ live: (url) => live.has(url.toLowerCase()) })) lastAt.set(source.name, now);
    } catch (e) {
      console.warn(`hopper: ${source.name}: the sweep of head branches failed, asked again at the next round: ${(e as Error).message}`);
    }
  };
}
