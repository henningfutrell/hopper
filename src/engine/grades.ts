// The grade pass (issue #2845, design.md "Grades"): every GRADES_EVERY_MS, on the host that holds its lease, the events
// after the pass's cursor name the jobs whose grade is due — a job that ended, or one whose pull request, rework,
// revert, fix issue or issue reopen came later —, and each such job that ended done or failed is graded again from its
// record, its own events, its token ledger, its completion review (issue #2846 part 3), the landing batches' reverts and
// fix issues, and its item's issue reopens. The grades it changed and the new cursor are kept in one transaction, so
// a pass a stop cut short is done again from the same cursor, on any host. The pass grades with the user's grade
// settings; when their grading part changed since the last pass, every kept grade of the last REGRADE_DAYS is due too.
import { gradingPartOf } from '../domain/grade-routing.ts';
import {
  autoGradeOf, fixIssuesOf, GRADE_EVENTS, gradedEnd, gradeFactsOf, gradeKeysOf, revertsOf, type GradeRow, type GradeSettings,
} from '../domain/grades.ts';
import type { Job } from '../domain/types.ts';
import type { UserStore } from '../domain/store.ts';
import { jobTokenView } from '../domain/token-usage.ts';

export const GRADES_EVERY_MS = 60_000;
/** Events read per query after the cursor. */
const PAGE = 2000;
const DAY = 86_400_000;
/** The first pass grades the jobs that ended in the last this many days. */
const FIRST_DAYS = 30;
/** A settings change grades again the kept grades of jobs that ended in the last this many days. */
const REGRADE_DAYS = 90;
const JOB_EVENTS = GRADE_EVENTS.filter((t) => !t.startsWith('landing_batch.') && !t.startsWith('work_item.'));
const REVERT_EVENTS = ['landing_batch.revert_opened', 'landing_batch.reverted'] as const;
const FIX_EVENTS = ['landing_batch.culprit', 'landing_batch.fix_filed'] as const;

/**
 * The jobs the events after the cursor make due, and the new cursor. A revert or a fix issue makes due the job whose pull
 * request it names; a reopen of an item's issue, the item's newest job.
 */
function dueOf(store: UserStore, now: Date): { due: Set<string>; cursor: number } {
  const cursor = store.grades.cursor();
  const due = new Set<string>();
  if (cursor === undefined) {
    const since = new Date(now.getTime() - FIRST_DAYS * DAY).toISOString();
    for (const e of store.events.between(['job.finished', 'job.failed'], since)) if (e.jobId) due.add(e.jobId);
    return { due, cursor: store.events.recent(1)[0]?.seq ?? 0 };
  }
  const types = new Set<string>(GRADE_EVENTS);
  const reverted: string[] = [], fixed: string[] = [];
  let last = cursor;
  for (let page = store.events.since(last, PAGE); page.length > 0; page = page.length < PAGE ? [] : store.events.since(last, PAGE)) {
    last = page.at(-1)!.seq;
    for (const e of page) {
      if (!types.has(e.type)) continue;
      if (e.jobId) due.add(e.jobId);
      if (e.type === 'landing_batch.reverted') reverted.push((e.data as { url: string }).url);
      if (e.type === 'landing_batch.fix_filed') fixed.push((e.data as { url: string }).url);
      if (e.type === 'work_item.issue_reopened') {
        const job = store.jobs.getBySourceKey((e.data as { key: string }).key);
        if (job) due.add(job.id);
      }
    }
  }
  if (reverted.length > 0 || fixed.length > 0) {
    const since = new Date(now.getTime() - DAY * 90).toISOString();
    const culprits = new Set([
      ...[...revertsOf(store.events.between(REVERT_EVENTS, since))].filter(([, r]) => reverted.includes(r.url)).map(([pr]) => pr),
      ...[...fixIssuesOf(store.events.between(FIX_EVENTS, since))].filter(([, r]) => fixed.includes(r.url)).map(([pr]) => pr),
    ]);
    for (const e of store.events.between(['job.pull_request_merged'], since)) {
      if (e.jobId && culprits.has((e.data as { pullRequest: string }).pullRequest)) due.add(e.jobId);
    }
  }
  return { due, cursor: last };
}

/** When the job's item's issue reopened after its end and before the item's next job. */
function reopensOf(store: UserStore, job: Job): string[] {
  const key = job.source?.key;
  if (!key || !job.finishedAt) return [];
  const ids = store.jobs.idsOfItem(key);
  const next = ids[ids.indexOf(job.id) - 1];
  const until = next === undefined ? undefined : store.jobs.get(next)?.createdAt;
  return store.events.between(['work_item.issue_reopened'], job.finishedAt)
    .filter((e) => (e.data as { key: string }).key === key && (until === undefined || e.at < until)).map((e) => e.at);
}

/** A job's grade now, or undefined when it has not ended done or failed. */
export function gradeOf(store: UserStore, jobId: string, now: Date, settings: GradeSettings = store.settings.getGradeSettings()): GradeRow | undefined {
  const job = store.jobs.get(jobId);
  if (!job || !gradedEnd(job.status)) return undefined;
  const events = store.events.recent(1000, [...JOB_EVENTS], jobId).sort((a, b) => a.seq - b.seq);
  const merged = events.find((e) => e.type === 'job.pull_request_merged');
  const reverts = merged ? revertsOf(store.events.between(REVERT_EVENTS, merged.at)) : new Map();
  const fixes = merged ? fixIssuesOf(store.events.between(FIX_EVENTS, merged.at)) : new Map();
  const tokens = jobTokenView(jobId, store.tokenLedger.list({ jobId }));
  const waste = store.completionReviews.get(jobId)?.waste.map((w) => w.kind);
  const later = { reverts, fixes, reopens: reopensOf(store, job) };
  const facts = gradeFactsOf(job, events, tokens.sessions > 0 ? tokens.total : undefined, later, settings.revertWindowDays, waste);
  return { ...gradeKeysOf(job, tokens.models[0]?.model, tokens.machines.at(-1)), facts, auto: autoGradeOf(facts, settings), gradedAt: now.toISOString() };
}

/** One pass at `now`: answers how many grades it wrote. */
export function keepGrades(store: UserStore, now: Date): number {
  const { due, cursor } = dueOf(store, now);
  const settings = store.settings.getGradeSettings();
  const part = gradingPartOf(settings);
  const regrade = store.settings.getGradedWith() !== part;
  if (regrade) for (const r of store.grades.list({ since: new Date(now.getTime() - REGRADE_DAYS * DAY).toISOString() })) due.add(r.jobId);
  const changed: GradeRow[] = [];
  for (const jobId of due) {
    const g = gradeOf(store, jobId, now, settings);
    if (!g) continue;
    const kept = store.grades.get(jobId);
    if (kept && JSON.stringify({ ...kept, user: undefined, gradedAt: undefined }) === JSON.stringify({ ...g, gradedAt: undefined })) continue;
    changed.push(g);
  }
  store.tx(() => {
    if (changed.length > 0 || cursor !== store.grades.cursor()) store.grades.save(changed, cursor);
    if (regrade) store.settings.setGradedWith(part);
  });
  return changed.length;
}
