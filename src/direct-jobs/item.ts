// A direct job as its source's item (issue #901): the brief, then the hopper's own context block — the routing labels,
// what the submitter authorized, who submitted it, the repository it may open a pull request on, and what done means.
// The job is told its brief and results stay in the hopper: nothing of them goes to GitHub, or anywhere else. Pure.
import { authorizesVault, DEFAULT_DIRECT_EXECUTOR, DEFAULT_DIRECT_PRIORITY, DIRECT_QUERY_ENV, directKey, type DirectJob } from '../domain/direct-jobs.ts';
import type { SourceItem } from '../domain/source-item.ts';
import { nameWithoutEmail } from '../domain/users.ts';

/** What the job is told about where it came from, before its brief. */
export const PRIVATE_LINE = '[hopper direct job] A person submitted this job straight to the hopper. No GitHub issue is behind it. Its brief and its results are private: they stay in the hopper. Do not write the brief, its details or your results to GitHub or anywhere else: no issue, no comment, no gist. Open a pull request only when the brief asks for a change to the repository named below; its title, body, branch and commits describe the change in neutral terms and carry no detail of the brief.';

/**
 * Issue #946: a direct job's outputs are often not code — a diagnostic, a diagram, a presentation, a report. Each goes to
 * the hopper as an artifact, which stays private and is shown with the job; a person may promote it to GitHub later.
 */
export const OUTPUTS_LINE = 'outputs: put what you make for a person to see — a diagnostic, a diagram, a presentation, a report — as artifacts of this job (sh "$HOPPER_ARTIFACT" put). They stay private in the hopper and show with the job. Make no public link: a person decides whether any of it goes to GitHub.';

const DONE_LINE = 'done: when the work of the brief is complete. End with a short report of what you did and what you found: it is the job\'s result, which the requester reads back in the hopper. When the brief cannot be done, end failed and say why.';

const list = (xs: string[]): string => (xs.length ? xs.join(', ') : 'none');

/**
 * Issue #2184: a direct query's job only looks. It is told so before the question; the proxies refuse its writes too
 * (`LOOK_ONLY`), so the line is what the job knows, not the guard.
 */
export const QUERY_LINE = '[hopper direct query] A caller asked this question straight to the hopper. No GitHub issue is behind it. The question and your answer are private: they stay in the hopper, which sends the answer to the caller. Look only: answer the question. Change no code, infrastructure or secret. Push nothing, open no pull request, file no issue and write no comment: the hopper refuses them. Ask the vault and the sandbox only for reads. Reach a service only through what your sandbox gives: no port-forward, proxy or tunnel. When the answer needs a change, do not make it: end failed and say what a person must file as an issue.';

const QUERY_DONE_LINE = 'done: when you can answer. End with the answer, short and plain, then the evidence: where you looked and what you saw. Your last report is the answer: the hopper sends it to the caller. When you cannot answer, end failed and say why.';

/** The prompt of a direct query's job: the question, then what it may use. */
function queryPrompt(d: DirectJob): string {
  const q = d.query!;
  return [
    QUERY_LINE,
    '',
    d.brief,
    '',
    '[hopper direct query context]',
    `direct query: ${d.id} · request: ${q.requestId}`,
    `look first in: repositories ${list(q.repos ?? [])}; clusters ${list(q.clusters ?? [])}. These are hints, and allow nothing more.`,
    'vault: not granted — ask only for reads',
    `asked by: ${nameWithoutEmail(d.submittedBy.person)} (${d.submittedBy.via}) at ${d.submittedAt}`,
    OUTPUTS_LINE,
    QUERY_DONE_LINE,
  ].join('\n');
}

/** The prompt the job runs: the brief, then the context block. */
export function directPrompt(d: DirectJob): string {
  if (d.query) return queryPrompt(d);
  return [
    PRIVATE_LINE,
    '',
    d.brief,
    '',
    '[hopper direct job context]',
    `direct job: ${d.id} · title: ${d.title}`,
    `routing labels: ${list(d.labels)}`,
    `authorized by the submitter: ${list(d.authorizations)}. Do nothing that needs an authorization not on this list: ask instead.`,
    authorizesVault(d)
      ? 'vault: granted by the submitter — the vault\'s helper gives what your box\'s template holds, never more'
      : 'vault: not granted — the vault gives this job nothing',
    `submitted by: ${nameWithoutEmail(d.submittedBy.person)} (${d.submittedBy.via}) at ${d.submittedAt}`,
    d.repo ? `repository: ${d.repo} — a pull request, if the brief asks for a change, goes here` : 'repository: none — open no pull request',
    ...(d.pushRequirements?.length ? [`push requirements: the submitter set ${d.pushRequirements.map((q) => q.id).join(', ')}. Before each push, run sh "$HOPPER_REQUIREMENTS" check in the work tree; the hopper takes the push once it passes`] : []),
    OUTPUTS_LINE,
    DONE_LINE,
  ].join('\n');
}

/** The direct job as the item its source offers, and the job runs. */
export function directItem(d: DirectJob, url: string): SourceItem {
  const priority = d.priority ?? DEFAULT_DIRECT_PRIORITY;
  return {
    key: directKey(d.id), url, title: d.title, body: d.brief, prompt: directPrompt(d),
    env: { HOPPER_DIRECT_JOB: d.id, ...(d.repo ? { HOPPER_REPO: d.repo } : {}), ...(d.query ? { [DIRECT_QUERY_ENV]: d.id } : {}) },
    author: d.submittedBy.person, priority, priorityReason: d.priority === undefined ? 'default' : 'submitted',
    labels: [...d.labels], ...(d.repo ? { repo: d.repo } : {}),
    executor: d.executor ?? DEFAULT_DIRECT_EXECUTOR,
    // A person signed in submitted it: through the UI session, a box token a person minted, or the operator CLI.
    origin: 'trusted',
  };
}
