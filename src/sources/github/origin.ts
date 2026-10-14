// An issue's origin at intake (issue #652, domain/intake-origin.ts): who wrote it, and who added the label and the
// assignment the hopper takes it by — the newest of each, from its events. Each act counts only when a trusted actor did
// it, not through an app or as a bot; this hopper's own Assign to me is the user's act. An issue a job filed is never of
// a trusted origin. Not trusted: the text a person approved, when its title and body hash the same, makes it approved;
// else it is a request card. A new request card's text records `source.request_opened` once (issue #798), so it notifies.
import {
  FILED_BY_JOB, FILED_BY_JOB_REASON, isBotLogin, requestHash, untrustedReason, type ActorRef, type IntakeRequest, type JobOrigin, type OriginActor, type OriginRole,
} from '../../domain/intake-origin.ts';
import type { IntakeContext, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import type { GitHubApi, GitHubIssue, IssueEvent } from './api.ts';

/** An issue's origin: trusted or approved (it may be taken), else the request card a person approves. */
export type OriginVerdict = { origin: JobOrigin } | { request: IntakeRequest };

export const REQUEST_REASON = 'a request: approve it to take it';
/** A request card a person declined (issue #1035). */
export const DECLINED_REASON = 'a request you declined: an edit to its title or body shows it again';

type Act = Omit<OriginActor, 'trusted'>;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** One act from its newest event. `own`: this hopper did it for the user (Assign to me), so it is the user's act. */
function actOf(role: OriginRole, e: IssueEvent | undefined, own: { login: string } | undefined): Act {
  if (!e) return { role };
  const bot = e.actorType === 'Bot' || isBotLogin(e.actor);
  if (own && (bot || e.viaApp)) return { role, login: own.login };
  const app = bot ? e.actor : e.viaApp;
  return { role, ...(e.actor ? { login: e.actor, ...(e.actorId !== undefined ? { id: e.actorId } : {}) } : {}), ...(app ? { app } : {}) };
}

/** Who wrote the issue, and who added `label` and the assignment to `assignee`: the newest event of each. */
export function originActs(issue: Pick<GitHubIssue, 'author' | 'authorId'>, events: IssueEvent[], label: string, assignee: string, assignedHere: boolean): Act[] {
  const newest = (pick: (e: IssueEvent) => boolean) => events.filter(pick).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const labelled = newest((e) => e.event === 'labeled' && e.label === label);
  const assigned = newest((e) => e.event === 'assigned' && e.assignee !== undefined && same(e.assignee, assignee));
  return [
    { role: 'author', login: issue.author, ...(issue.authorId !== undefined ? { id: issue.authorId } : {}), ...(isBotLogin(issue.author) ? { app: issue.author } : {}) },
    actOf('labelled', labelled, undefined),
    actOf('assigned', assigned, assignedHere ? { login: assignee } : undefined),
  ];
}

/** The events of an issue, or none when they cannot be read: its label and assignment then count as done by nobody known. */
async function eventsOf(api: GitHubApi, issue: GitHubIssue): Promise<IssueEvent[]> {
  try {
    return await api.issueEvents(issue.repo, issue.number);
  } catch (err) {
    console.warn(`hopper: the events of ${issue.url} could not be read: ${(err as Error).message}`);
    return [];
  }
}

/** The origin of each issue, by its URL: the trusted actors asked once for every login the issues name. */
export async function originsOf(api: GitHubApi, trust: IntakeTrust, issues: GitHubIssue[], label: string, connected: string): Promise<Map<string, OriginVerdict>> {
  const acts = new Map<string, Act[]>();
  for (const i of issues) acts.set(i.url, originActs(i, await eventsOf(api, i), label, connected, trust.assignedHere(i.url)));
  const asked = new Map<string, ActorRef>();
  for (const a of [...acts.values()].flat()) if (!a.app && a.login && !asked.has(a.login.toLowerCase())) asked.set(a.login.toLowerCase(), { login: a.login.toLowerCase(), ...(a.id !== undefined ? { id: a.id } : {}) });
  const answers = asked.size > 0 ? await trust.trusted([...asked.values()], connected) : new Map();
  const verdicts = new Map<string, OriginVerdict>();
  for (const i of issues) {
    const actors = acts.get(i.url)!.map((a): OriginActor => ({ ...a, trusted: !a.app && a.login !== undefined && answers.get(a.login.toLowerCase())?.allowed === true }));
    const unavailable = actors.map((a) => (a.login ? answers.get(a.login.toLowerCase()) : undefined)).find((x) => x?.unavailable);
    const why = [
      ...actors.map(untrustedReason).filter((r): r is string => r !== undefined),
      ...(FILED_BY_JOB.test(i.body) ? [FILED_BY_JOB_REASON] : []),
      ...(unavailable ? [`trusted actors cannot be checked: ${unavailable.reason}`] : []),
    ];
    const approved = trust.approvedText(i.url);
    const hash = requestHash(i);
    if (why.length === 0) verdicts.set(i.url, { origin: 'trusted' });
    else if (approved && requestHash(approved) === hash) verdicts.set(i.url, { origin: 'approved' });
    else verdicts.set(i.url, { request: { hash, title: i.title, body: i.body, author: i.author, actors, why, ...(approved ? { approved } : {}) } });
  }
  return verdicts;
}

/** An outcome with its request, if it has one: a request card, or a text a person declined (issue #1035), which waits for
 *  nobody and is offered nothing until an edit makes it a new request. */
export function requestOutcome(x: IntakeOutcome, r: IntakeRequest | undefined, trust: Pick<IntakeTrust, 'declined'>): IntakeOutcome {
  if (!r) return x;
  if (trust.declined(x.key, r.hash)) return { ...x, reason: DECLINED_REASON, group: 'declined' };
  return { ...x, reason: REQUEST_REASON, action: 'approve', group: 'request', request: r };
}

/**
 * Record `source.request_opened` for each request card whose text has none yet (issue #798): once per item and text, across
 * syncs and restarts. `seen` keeps what this process already knows, so the events are read once per text.
 */
export function openRequests(source: string, intake: IntakeContext, requests: Map<string, IntakeRequest>, seen: Set<string>): void {
  for (const [key, r] of requests) {
    const id = `${key} ${r.hash}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!intake.requestOpened(key, r.hash)) intake.record('source.request_opened', { source, key, hash: r.hash, author: r.author, why: r.why });
  }
}
