// Request cards for GitLab issues (issue #1642, design.md "Request cards from GitLab"), apart from source.ts for its size: a
// GitLab issue assigned to the account that is not of a trusted origin (origin.ts) is a request card, as on GitHub (issue
// #652). A person approves the title and description the last sync showed, recorded at once as the item's snapshot through the
// user's intake trust, and the next sync takes it as a job of origin `approved`; Decline keeps its text out until an edit.
// Nothing is written to GitLab. Approve and Decline are the only actions a GitLab card offers.
import type { IntakeAction, IntakeActionResult, IntakeOutcome, IntakeTrust } from '../domain/intake.ts';
import { requestHash, type IntakeRequest, type JobOrigin, type OriginActor } from '../domain/intake-origin.ts';
import type { GitLabAct, GitLabIssue } from '../domain/gitlab-account.ts';
import { autoApproval, type AutoApproval, type IntakeAutoApproval } from '../domain/intake-auto-approve.ts';
import { NOT_IN_SCOPE, TEXT_CHANGED_SINCE_SHOWN } from '../sources/github/intake-actions.ts';

/** An action other than Approve and Decline on a GitLab source. */
export const NOT_ON_GITLAB = 'not offered on GitLab: only Approve and Decline on a request card';

/**
 * A GitLab issue's origin: trusted or approved (it may be taken), else the request card a person approves, with who added
 * `hopper:high` when it has it (for auto-approval).
 */
export type GitLabVerdict = { origin: JobOrigin; acts: OriginActor[] } | { request: IntakeRequest; high?: OriginActor };

/** The text an issue's request is of: its title and description, as GitHub's title and body. */
const textOf = (i: Pick<GitLabIssue, 'title' | 'description'>) => ({ title: i.title, body: i.description });

/**
 * An issue's verdict from its acts and why they are not trusted (`untrustedActs`): trusted when none; approved when a person
 * approved this text; else its request card, with the text approved before when its text changed since. `high`: who added
 * `hopper:high`, when it has it.
 */
export function gitlabVerdict(i: GitLabIssue, acts: readonly GitLabAct[], why: readonly string[], trusted: ReadonlyMap<number, boolean>, trust: Pick<IntakeTrust, 'approvedText'>, high?: GitLabAct): GitLabVerdict {
  const actor = (a: GitLabAct): OriginActor => ({
    role: a.role, ...(a.account ? { login: a.account } : {}), ...(a.userId !== undefined ? { id: a.userId } : {}),
    trusted: a.userId !== undefined && trusted.get(a.userId) === true,
  });
  if (why.length === 0) return { origin: 'trusted', acts: acts.map(actor) };
  const text = textOf(i);
  const hash = requestHash(text);
  const approved = trust.approvedText(i.url);
  if (approved && requestHash(approved) === hash) return { origin: 'approved', acts: acts.map(actor) };
  const request = { hash, ...text, author: i.author, actors: acts.map(actor), why: [...why], ...(approved ? { approved } : {}) };
  return { request, ...(high ? { high: actor(high) } : {}) };
}

/**
 * The rule that approves a GitLab card (issue #1642, as GitHub's, issue #1268), or undefined: it waits for a person. `author`
 * and `high-label` only: a GitLab card is never reopened, and its acts name no app. It waits when `setting` is absent or off,
 * a guard holds (`guarded`: a person declined this text or took it into Intake), its text changed since a person approved it,
 * or someone who is no trusted actor edited it.
 */
export function gitlabAutoApproval(v: { request: IntakeRequest; high?: OriginActor }, guarded: boolean, setting: IntakeAutoApproval | undefined): AutoApproval | undefined {
  if (!setting || guarded || v.request.approved) return undefined;
  const editors = v.request.actors.filter((a) => a.role === 'edited');
  return autoApproval({
    actors: v.request.actors.filter((a) => a.role !== 'edited'), editors, ...(v.high ? { high: v.high } : {}),
    reopenedCard: false, textApproved: false, guards: [],
  }, { on: setting.on, apps: [] });
}

export interface GitLabIntakeContext {
  source: string;
  /** What the last discover listed, with each card approved since taken. */
  offered: readonly IntakeOutcome[];
  trust: Pick<IntakeTrust, 'approve' | 'decline' | 'approvedText'>;
  /** A card approved here: Intake lists it taken until a sync lists it otherwise. */
  approved(key: string, hash: string): void;
}

/** One key's Approve or Decline: undefined when done, else why not. */
function act(c: GitLabIntakeContext, x: IntakeOutcome | undefined, key: string, a: IntakeAction): string | undefined {
  if (!x) return NOT_IN_SCOPE;
  if (x.action !== 'approve') {
    // Approve again of the text approved already (a second click, another tab) is done.
    const text = a.kind === 'approve' ? c.trust.approvedText(key) : undefined;
    return text && requestHash(text) === a.hash ? undefined : `not offered: ${x.reason ?? 'taken'}`;
  }
  const r = x.request;
  if (!r || r.hash !== a.hash) return TEXT_CHANGED_SINCE_SHOWN;
  if (a.kind === 'decline') { c.trust.decline(c.source, key, r, a.acting); return undefined; }
  c.trust.approve(c.source, key, { title: r.title, body: r.body, comments: [] }, r, a.acting);
  c.approved(key, r.hash);
  return undefined;
}

/** Approve or Decline on GitLab request cards, each only on the text the last sync showed. */
export function gitlabIntakeAct(c: GitLabIntakeContext, a: IntakeAction): IntakeActionResult {
  const offered = new Map(c.offered.map((x) => [x.key, x]));
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const key of new Set(a.keys)) {
    let why: string | undefined;
    try {
      why = a.kind === 'approve' || a.kind === 'decline' ? act(c, offered.get(key), key, a) : NOT_ON_GITLAB;
    } catch (err) {
      why = (err as Error).message;
    }
    if (why === undefined) done.push(key); else failed[key] = why;
  }
  return { done, failed };
}

/** The outcomes with each card approved here taken (`fresh`: key → the hash approved), as a discover lists an item it takes. */
export function takenOn(outcomes: readonly IntakeOutcome[], fresh: ReadonlyMap<string, string>): IntakeOutcome[] {
  return outcomes.map((x) => {
    if (x.action !== 'approve' || x.request === undefined || fresh.get(x.key) !== x.request.hash) return x;
    const { reason: _reason, action: _action, group: _group, request: _request, ...taken } = x;
    return taken;
  });
}

/** A GitLab issue key's project, lowercased: `<GitLab URL>/<project>/-/issues/<iid>`, the GitLab URL `baseUrl`. */
export function projectOfKey(baseUrl: string, key: string): string | undefined {
  if (!key.startsWith(`${baseUrl}/`)) return undefined;
  return /^(.+)\/-\/issues\/\d+$/.exec(key.slice(baseUrl.length + 1))?.[1]?.toLowerCase();
}
