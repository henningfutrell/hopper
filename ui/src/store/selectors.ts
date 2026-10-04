// Derived reads over the store, memoised by zustand's shallow equality where they allocate.
import { useMemo } from 'react';
import { goalOf, issueRef } from '@/model/job';
import { allows } from '@/model/roles';
import type { Job } from '@/model/wire';
import { useHopper } from './index';

/** Every job the UI currently knows, by id. */
export function useJobIndex(): Map<string, Job> {
  const queue = useHopper((s) => s.queue);
  return useMemo(() => new Map([...queue.ended, ...queue.waiting, ...queue.waitingAnswer, ...queue.running].map((j) => [j.id, j])), [queue]);
}

/** A job's short name: `ref goal`, or its id prefix when the UI no longer holds the job. */
export function useJobName(): (jobId: string) => string {
  const jobs = useJobIndex();
  return useMemo(() => (id: string) => {
    const j = jobs.get(id);
    if (!j) return id.slice(0, 8);
    const ref = issueRef(j);
    return ref ? `${ref} · ${goalOf(j)}` : goalOf(j);
  }, [jobs]);
}

/** The session may cancel and approve jobs, and answer and close questions. */
export const useCanOperate = (): boolean => useHopper((s) => s.authed && allows(s.user, 'operator'));
/** The session may change configuration (plugins, machines, routing, webhooks, rules, router mode). */
export const useCanAdmin = (): boolean => useHopper((s) => s.authed && allows(s.user, 'admin'));
