// Derived reads over the store, memoised so a view re-renders only when what it derives from changes.
import { useMemo } from 'react';
import { jobBoard, type JobBoard } from '@/model/board';
import { laneSpans, questionWaits, type LaneSpan, type QuestionWait } from '@/model/history';
import { goalOf, issueRef } from '@/model/job';
import { allows } from '@/model/roles';
import { awaitsOwner } from '@/model/questions';
import { awaitingSort } from '@/model/queue';
import type { Job } from '@/model/wire';
import { useHopper } from './index';

/** Every job the UI currently knows, by id. */
export function useJobIndex(): ReadonlyMap<string, Job> {
  const jobs = useHopper((s) => s.jobs);
  return useMemo(() => new Map(Object.entries(jobs)), [jobs]);
}

/** The jobs by group: what every job list and every job count on every view reads. */
export function useJobBoard(): JobBoard {
  const jobs = useHopper((s) => s.jobs);
  const order = useHopper((s) => s.waitingOrder);
  return useMemo(() => jobBoard(Object.values(jobs), order), [jobs, order]);
}

/** The lane spans since `since`, from the event log and the job store together. */
export function useLaneSpans(since: number): LaneSpan[] {
  const history = useHopper((s) => s.history);
  const jobs = useJobIndex();
  return useMemo(() => laneSpans(history, since, jobs), [history, since, jobs]);
}

/** The question waits since `since`: when jobs sat on a question, on the lane they asked from. */
export function useQuestionWaits(since: number): QuestionWait[] {
  const history = useHopper((s) => s.history);
  const jobs = useJobIndex();
  return useMemo(() => questionWaits(history, since, jobs), [history, since, jobs]);
}

/** How many open questions wait on the owner, seen or not: the nav badge (issue #499). */
export const useAwaitingOwner = (): number => useHopper((s) => s.questions.filter(awaitsOwner).length);

/** How many waiting jobs wait on the pre-sort: the Queue nav badge. */
export const useAwaitingSort = (): number => useHopper((s) => awaitingSort(Object.values(s.jobs)));

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
/** The session may change configuration (plugins, machines, routing, webhooks, rules). */
/** The session signed in with that provider's realm (issue #322): its connected account is the sign-in, not an extra. */
export const useSignedInWith = (provider: 'github'): boolean =>
  useHopper((s) => s.authed && (s.signIn?.devices ?? []).some((r) => r.type === provider && r.name === s.user?.realm));
export const useCanAdmin = (): boolean => useHopper((s) => s.authed && allows(s.user, 'admin'));
/** The session is an instance admin's (issue #240): sign-in, users, updates, the plugin store. */
export const useCanAdminInstance = (): boolean => useHopper((s) => s.authed && allows(s.user, 'admin') && s.user?.instanceAdmin === true);
