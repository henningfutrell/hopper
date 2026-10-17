// The origin of a GitLab issue (issue #1448 part 3, design.md "Jobs through GitLab"), pure: as on GitHub (issue #652), a
// GitLab issue becomes a job only when its author, whoever added the label it is taken by and whoever assigned it to the
// account are trusted actors; on GitLab also whoever edited its title or description, as GitLab's own system notes say. Who
// is a trusted actor is Access's to decide (OpenFGA `intake#can_start_jobs`): the account is the one the hopper tells it. An
// act GitLab does not say who did is no trusted act.
import type { GitLabAct, GitLabIssue } from '../domain/gitlab-account.ts';
import type { GitLabLabelEvent, GitLabNote } from './api.ts';

/** GitLab's system note of an assignment: `assigned to @a`, `assigned to @a and @b`, `assigned to @a and unassigned @b`. */
const ASSIGNED = /^assigned to (.+?)(?: and unassigned .*)?$/;
/** GitLab's system notes of an edit of the issue's text. */
const EDITED = /^changed (title|the description)\b/;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Whether a system note assigned the issue to `account`. */
const assigns = (body: string, account: string): boolean => {
  const m = ASSIGNED.exec(body.trim());
  return m !== null && (m[1]!.match(/@[\w.-]+/g) ?? []).some((a) => same(a.slice(1), account));
};

const act = (role: GitLabAct['role'], who: { account: string; userId?: number } | undefined): GitLabAct =>
  ({ role, ...(who?.account ? { account: who.account } : {}), ...(who?.userId !== undefined ? { userId: who.userId } : {}) });

/** Who added `label` to the issue last, as its label events say; undefined when none did. */
export function labelledBy(events: readonly GitLabLabelEvent[], label: string): GitLabAct | undefined {
  const e = events.filter((x) => x.action === 'add' && same(x.label, label)).at(-1);
  return e && act('labelled', e);
}

/**
 * The acts an issue's origin is judged by: its author; who added `label` last; who assigned it to `account` last; and each
 * edit of its title or description.
 */
export function gitlabActs(issue: Pick<GitLabIssue, 'author' | 'authorId'>, events: readonly GitLabLabelEvent[], notes: readonly GitLabNote[], label: string, account: string): GitLabAct[] {
  const assigned = notes.filter((n) => assigns(n.body, account)).at(-1);
  return [
    act('author', { account: issue.author, ...(issue.authorId !== undefined ? { userId: issue.authorId } : {}) }),
    labelledBy(events, label) ?? act('labelled', undefined),
    act('assigned', assigned),
    ...notes.filter((n) => EDITED.test(n.body.trim())).map((n) => act('edited', n)),
  ];
}

const DID: Record<GitLabAct['role'], string> = { author: 'wrote it', labelled: 'added the label', assigned: 'assigned it', edited: 'edited its title or description' };

/**
 * Why the acts are not of a trusted origin, one reason each; empty: they are. `trusted`: whether the GitLab user of an id is a
 * trusted actor, as Access answered.
 */
export function untrustedActs(acts: readonly GitLabAct[], trusted: ReadonlyMap<number, boolean>): string[] {
  const why: string[] = [];
  for (const a of acts) {
    if (a.userId === undefined) { why.push(`GitLab does not say who ${DID[a.role]}`); continue; }
    if (trusted.get(a.userId) !== true) why.push(`${a.account ?? `GitLab user ${a.userId}`} ${DID[a.role]}, and is not a trusted actor`);
  }
  return [...new Set(why)];
}
