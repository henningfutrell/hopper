// The critical job tracker's rows as the UI has them now (issue #2203, model/critical-jobs.ts): the critical jobs the store
// holds — the queue's jobs and its locked entries —, each with its waits read from the one home of each (the questions,
// the vault, the review sections, the failures, the logins), its current step, its last few actions and its sandboxes.
// All of it lives on SSE, as every view: nothing here reads the daemon. And the browser notification, once per new wait.
import { useEffect, useMemo } from 'react';
import { useDismissed } from '@/hooks/use-dismissed';
import { attentionNotice, currentStep, lastActions, sandboxesOf, trackedJobs, waitKey, waitsOf, type TrackerWait } from '@/model/critical-jobs';
import { goalOf } from '@/model/job';
import type { DomainEvent, Job } from '@/model/wire';
import { useHopper } from './index';
import { useVault } from './vault';

export interface TrackedJob {
  job: Job;
  waits: TrackerWait[];
  step: { text: string; since: string };
  actions: DomainEvent[];
  sandboxes: string[];
}

/** `describe`: an event in plain words, the current step of a job at work. */
export function useCriticalJobs(describe: (e: DomainEvent) => string): TrackedJob[] {
  const jobs = useHopper((s) => s.jobs);
  const locked = useHopper((s) => s.locked);
  const critical = useHopper((s) => s.criticalPriority);
  const questions = useHopper((s) => s.questions);
  const reviews = useHopper((s) => s.reviews);
  const failures = useHopper((s) => s.failures);
  const logins = useHopper((s) => s.logins);
  const events = useHopper((s) => s.events);
  const vault = useVault();
  const dismissed = useDismissed();
  return useMemo(() => trackedJobs([...Object.values(jobs), ...locked], critical, dismissed).map((job) => ({
    job,
    waits: waitsOf(job, { questions, vault, reviews, failures, logins }),
    step: currentStep(job, events, describe, job.questionId ? questions.find((q) => q.id === job.questionId) : undefined),
    actions: lastActions(events, job.id, 2),
    sandboxes: sandboxesOf(job, vault),
  })), [jobs, locked, critical, questions, reviews, failures, logins, events, vault, dismissed, describe]);
}

/** The waits this page has already notified: a new one notifies once. */
const notified = new Set<string>();

/** A browser notification for each new wait of a tracked job, when the person allowed them. */
export function useAttentionNotices(tracked: readonly TrackedJob[]): void {
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    for (const t of tracked) {
      const fresh = t.waits.filter((w) => !notified.has(waitKey(t.job.id, w)));
      if (!fresh.length) continue;
      for (const w of fresh) notified.add(waitKey(t.job.id, w));
      const n = attentionNotice(goalOf(t.job), t.waits);
      try { new Notification(n.title, { body: n.body, tag: `critical:${t.job.id}` }); } catch { /* the browser refused it: the widget still shows it */ }
    }
  }, [tracked]);
}
