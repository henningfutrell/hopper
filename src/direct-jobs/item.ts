// A direct job as its source's item (issue #901): the brief, then the hopper's own context block — the routing labels,
// what the submitter authorized, who submitted it, the repository it may open a pull request on, and what done means.
// The job is told its brief and results stay in the hopper: nothing of them goes to GitHub, or anywhere else. Pure.
import { authorizesVault, DEFAULT_DIRECT_EXECUTOR, DEFAULT_DIRECT_PRIORITY, directKey, type DirectJob } from '../domain/direct-jobs.ts';
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

/** The prompt the job runs: the brief, then the context block. */
export function directPrompt(d: DirectJob): string {
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
    OUTPUTS_LINE,
    DONE_LINE,
  ].join('\n');
}

/** The direct job as the item its source offers, and the job runs. */
export function directItem(d: DirectJob, url: string): SourceItem {
  const priority = d.priority ?? DEFAULT_DIRECT_PRIORITY;
  return {
    key: directKey(d.id), url, title: d.title, body: d.brief, prompt: directPrompt(d),
    env: { HOPPER_DIRECT_JOB: d.id, ...(d.repo ? { HOPPER_REPO: d.repo } : {}) },
    author: d.submittedBy.person, priority, priorityReason: d.priority === undefined ? 'default' : 'submitted',
    labels: [...d.labels], ...(d.repo ? { repo: d.repo } : {}),
    executor: d.executor ?? DEFAULT_DIRECT_EXECUTOR,
    // A person signed in submitted it: through the UI session, a box token a person minted, or the operator CLI.
    origin: 'trusted',
  };
}
