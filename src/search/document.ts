// A job as a search document (issue #945, design.md "Search"), pure: its title, what it was asked, its status, routing
// labels, requester, machine and lane, its times; its result, its questions with their answers, why it failed and the
// failure assessor's verdict. Every text is masked first (src/secrets/mask.ts): the index holds no secret, no vault value
// and no credential. The vault, connected accounts, sign-in and webhook secrets are never read here at all.
import type { DirectJob } from '../domain/direct-jobs.ts';
import { DIRECT_SOURCE } from '../domain/direct-jobs.ts';
import type { Question } from '../domain/questions.ts';
import { searchDocumentId, type SearchDocument, type SearchScope } from '../domain/search.ts';
import type { Job } from '../domain/types.ts';
import { maskSecrets } from '../secrets/mask.ts';

/** The most of one text field kept: a job's prompt can be long, and search needs its words, not all of them. */
export const FIELD_MAX = 32_000;
const TITLE_MAX = 500;

const clip = (s: string, max = FIELD_MAX): string => (s.length > max ? s.slice(0, max) : s);
const masked = (s: string | undefined, max = FIELD_MAX): string | undefined => {
  const t = s?.trim();
  return t ? clip(maskSecrets(t), max) : undefined;
};
const textOf = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === 'string' ? v : JSON.stringify(v));
const optional = <K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> => (v === undefined ? {} : { [k]: v } as Record<K, V>);

/** The machine a lane id names (`<machine>/lane-<n>`). */
const machineOfLane = (lane: string): string | undefined => {
  const i = lane.lastIndexOf('/lane-');
  return i > 0 ? lane.slice(0, i) : undefined;
};

/** The job's own words for what it is: its item's title, a direct job's, its goal, else its prompt's first line. */
function titleOf(job: Job, direct: DirectJob | undefined): string {
  const prompt = typeof job.spec.payload.prompt === 'string' ? job.spec.payload.prompt : undefined;
  return direct?.title ?? job.source?.title ?? job.spec.goal ?? prompt?.split('\n').find((l) => l.trim() !== '') ?? job.id;
}

export function jobDocument(o: { scope: SearchScope; job: Job; questions: readonly Question[]; direct?: DirectJob }): SearchDocument {
  const { job, direct } = o;
  const prompt = typeof job.spec.payload.prompt === 'string' ? job.spec.payload.prompt : undefined;
  const machine = (job.laneId ? machineOfLane(job.laneId) : undefined) ?? job.spec.machineId ?? job.resumeOn ?? o.questions.find((q) => q.raisedBy)?.raisedBy?.machineId;
  const questions = o.questions
    .map((q) => masked([q.text, q.answer].filter(Boolean).join('\n')))
    .filter((q): q is string => q !== undefined);
  const result = [textOf(job.result), job.partlyDone ? `partly done: ${job.partlyDone}` : undefined].filter(Boolean).join('\n');
  const verdict = job.assessment ? [`${job.assessment.decision}: ${job.assessment.summary}`, ...job.assessment.reasons].join('\n') : undefined;
  const requester = direct?.submittedBy.person ?? job.source?.author ?? job.spec.submittedBy;
  return {
    id: searchDocumentId(o.scope, 'job', job.id),
    instance: o.scope.instance, user: o.scope.user, type: 'job', ref: job.id,
    private: job.source?.kind === DIRECT_SOURCE || direct !== undefined,
    title: masked(titleOf(job, direct), TITLE_MAX) ?? job.id,
    ...optional('brief', masked(direct?.brief ?? prompt)),
    status: job.status,
    labels: [...new Set([...(job.source?.labels ?? []), ...(direct?.labels ?? [])])],
    ...optional('repo', job.source?.repo ?? direct?.repo),
    ...optional('source', job.source?.source),
    ...optional('requester', requester),
    ...optional('machine', machine),
    ...optional('lane', job.laneId),
    ...optional('result', masked(result)),
    ...(questions.length > 0 ? { questions } : {}),
    ...optional('failure', masked(job.error)),
    ...optional('verdict', masked(verdict)),
    created: job.createdAt, updated: job.updatedAt,
    ...optional('finished', job.finishedAt),
  };
}
