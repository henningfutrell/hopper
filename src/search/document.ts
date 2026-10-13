// The search documents (issue #945, design.md "Search"), pure. A job: its title, what it was asked, its status, routing
// labels, requester, machine and lane, its times; its result, its questions with their answers, why it failed and the
// failure assessor's verdict. An artifact (part 3): its title, summary, note, repository and job, and its text where that
// is cheap. An infra plan (part 3): its target, tool, summary in plain words, risks and blast radius, never the plan's own
// text. Every text is masked first (src/secrets/mask.ts): the index holds no secret, no vault value and no credential. The
// vault, connected accounts, sign-in and webhook secrets are never read here at all.
import { TEXT_KINDS, type Artifact } from '../domain/artifacts.ts';
import type { InfraPlan, PlanApproval } from '../domain/infra-plans.ts';
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

/** Whether only the owner sees what the job made: a direct job's (issue #901). */
const privateJob = (job: Job | undefined): boolean => job?.source?.kind === DIRECT_SOURCE;

/** The most bytes of an artifact read for its text: past this, its metadata alone is indexed. */
export const CONTENT_READ_MAX = 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s: string): string => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
});

/**
 * The words of HTML or SVG (a slide deck's slide text): scripts, styles and comments out, each tag a space, entities
 * decoded. Not a parser, and need not be one: search needs the words, and Solr escapes whatever it answers. Why no
 * library: none in the dependencies does this, and these few lines cost less than one more.
 */
const markupText = (s: string): string => decodeEntities(s
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' '))
  .replace(/\s+/g, ' ');

/** An artifact's text where it is cheap: a text kind, at most CONTENT_READ_MAX bytes; HTML and SVG as their words. */
export function artifactText(a: Pick<Artifact, 'kind'>, content: Buffer | undefined): string | undefined {
  if (!content || content.length > CONTENT_READ_MAX || !TEXT_KINDS.includes(a.kind)) return undefined;
  const text = content.toString('utf8');
  return a.kind === 'html' || a.kind === 'svg' ? markupText(text) : text;
}

/** `owner/repo` of an issue ref (`owner/repo#N`). */
const repoOfRef = (ref: string | undefined): string | undefined => ref?.split('#')[0] || undefined;

export function artifactDocument(o: { scope: SearchScope; artifact: Artifact; content?: Buffer; job?: Job }): SearchDocument {
  const { artifact: a } = o;
  return {
    id: searchDocumentId(o.scope, 'artifact', a.id),
    instance: o.scope.instance, user: o.scope.user, type: 'artifact', ref: a.id,
    private: privateJob(o.job),
    title: masked(a.title, TITLE_MAX) ?? a.name,
    ...optional('brief', masked([a.summary, a.note].filter(Boolean).join('\n'))),
    labels: [],
    ...optional('repo', repoOfRef(a.issue?.ref) ?? o.job?.source?.repo),
    ...optional('content', masked(artifactText(a, o.content))),
    job: a.jobId,
    created: a.createdAt, updated: a.updatedAt,
  };
}

export function planDocument(o: { scope: SearchScope; plan: InfraPlan; approval?: PlanApproval; job?: Job }): SearchDocument {
  const { plan: p, approval } = o;
  const s = p.summary;
  const brief = s ? [s.words, ...s.risks.map((r) => r.words), s.blastRadius, ...s.checks.filter((c) => !c.ok).map((c) => c.words)].join('\n') : undefined;
  return {
    id: searchDocumentId(o.scope, 'infra-plan', p.id),
    instance: o.scope.instance, user: o.scope.user, type: 'infra-plan', ref: p.id,
    private: privateJob(o.job),
    title: masked(`${p.target} (${p.tool} plan)`, TITLE_MAX) ?? p.id,
    ...optional('brief', masked(brief)),
    status: approval ? 'approved' : s?.failed ? 'failed' : 'recorded',
    labels: [],
    repo: p.repo,
    job: p.job,
    created: p.createdAt, updated: approval?.at ?? p.createdAt,
  };
}
