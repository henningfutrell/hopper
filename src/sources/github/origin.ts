// An issue's origin at intake (issue #652, domain/intake-origin.ts): who wrote it, and who added the label and the
// assignment the hopper takes it by — the newest of each, from its events. Each act counts only when a trusted actor did
// it, not through an app or as a bot; this hopper's own Assign to me is the user's act. An issue a job filed is never of
// a trusted origin. Not trusted: the text a person approved, when its title and body hash the same, makes it approved;
// else it is a request card. A new request card's text records `source.request_opened` once (issue #798), so it notifies;
// a card that leaves Intake with no approval or decline records `source.request_withdrawn` (issue #1067, part 4).
// An open issue with `hopper:done` whose job here ended was reopened (issue #1126): it is a request card again, the
// reopened card (`reopenedRequest`), whatever its origin, so a person decides whether the item runs again — unless its pull
// request merged into the landing branch and waits on its batch run (issue #1175, `awaitingBatch`): its issue closes when
// the batch reaches the tested branch, so it is not offered again — or its batch run promoted it and the issue is still
// open (issue #1232, `closePromoted`): the hopper closes the issue, once, so it is done and not offered again.
import {
  FILED_BY_JOB, FILED_BY_JOB_REASON, isBotLogin, requestHash, untrustedReason, type ActorRef, type IntakeRequest, type ItemHistory, type JobOrigin, type OriginActor, type OriginRole,
} from '../../domain/intake-origin.ts';
import type { IntakeContext, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import type { GitHubApi, GitHubIssue, IssueEvent } from './api.ts';
import { DONE_OPEN } from './discover.ts';

/** An issue's origin: trusted or approved (it may be taken), else the request card a person approves. */
export type OriginVerdict = { origin: JobOrigin } | { request: IntakeRequest };

export const REQUEST_REASON = 'a request: approve it to take it';
/** A reopened card (issue #1126). */
export const REOPENED_REASON = 'reopened after its job was done: approve it to run it again';
/** Why a reopened card is a request. */
export const REOPENED_WHY = 'reopened after its job was done';
/** A done item whose merge waits on its batch run (issue #1175). */
export const AWAITS_BATCH = 'done: merged into the landing branch; its batch run closes the issue';
/** A done item its batch run promoted, whose open issue the hopper closed (issue #1232). */
export const PROMOTED_CLOSED = 'done: promoted to the tested branch with its batch; the issue is closed';
/** The same, when its close failed: asked again at the next sync. */
export const PROMOTED_OPEN = 'done: promoted to the tested branch with its batch; closing the issue failed, asked again at the next sync';
/** Why a card is a request when Access cannot be asked: no auto-approval holds then (issue #1268). */
export const UNCHECKED = 'trusted actors cannot be checked';
/** A request card a person declined (issue #1035). */
export const DECLINED_REASON = 'a request you declined: an edit to its title or body shows it again';

export type Act = Omit<OriginActor, 'trusted'>;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** One act from its newest event. `own`: this hopper did it for the user (Assign to me), so it is the user's act. */
export function actOf(role: OriginRole, e: IssueEvent | undefined, own: { login: string } | undefined): Act {
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
      ...(unavailable ? [`${UNCHECKED}: ${unavailable.reason}`] : []),
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
  return { ...x, reason: r.reopened ? REOPENED_REASON : REQUEST_REASON, action: 'approve', group: 'request', request: r };
}

/**
 * The reopened card of an issue (issue #1126): its text as read, and the item's history. Its acts are not read: a person
 * approves it whatever its origin, and the origin is judged again at the sync after the approval.
 */
export function reopenedRequest(issue: Pick<GitHubIssue, 'title' | 'body' | 'author'>, history: ItemHistory): IntakeRequest {
  return { hash: requestHash(issue), title: issue.title, body: issue.body, author: issue.author, actors: [], why: [REOPENED_WHY], reopened: history };
}

/**
 * The outcomes with each `done, but the issue is still open` whose merge waits on its batch run (issue #1175) said so: in
 * the pull request waiting group, with no action, and so no reopened card.
 */
export function awaitingBatch(outcomes: readonly IntakeOutcome[], intake: Pick<IntakeContext, 'awaitsBatch'> | undefined): IntakeOutcome[] {
  const waits = intake?.awaitsBatch;
  if (!waits) return [...outcomes];
  return outcomes.map((x) => (x.reason === DONE_OPEN && waits(x.key) ? { ...x, reason: AWAITS_BATCH, group: 'pr-waiting' } : x));
}

/**
 * The outcomes with each `done, but the issue is still open` whose pull request its batch run promoted (issue #1232) closed:
 * the hopper closes the issue as completed, as the batch run's text would have, and records the close
 * (`work_item.issue_closed`, `via: landing`), so the ledger holds it closed and a later reopen is a person's. No comment.
 * A close that fails is asked again at the next sync, and said, with no reopened card.
 */
export async function closePromoted(api: Pick<GitHubApi, 'closeAsCompleted'>, seen: readonly GitHubIssue[], outcomes: readonly IntakeOutcome[],
  intake: Pick<IntakeContext, 'promotedOpen' | 'record'> | undefined): Promise<IntakeOutcome[]> {
  const promoted = intake?.promotedOpen;
  if (!intake || !promoted) return [...outcomes];
  const out: IntakeOutcome[] = [];
  for (const x of outcomes) {
    const issue = x.reason === DONE_OPEN && promoted(x.key) ? seen.find((i) => i.url === x.key) : undefined;
    if (!issue) { out.push(x); continue; }
    try {
      await api.closeAsCompleted(issue.repo, issue.number);
      intake.record('work_item.issue_closed', { key: x.key, reason: 'completed', via: 'landing' });
      out.push({ ...x, reason: PROMOTED_CLOSED, group: 'other' });
    } catch (err) {
      out.push({ ...x, reason: `${PROMOTED_OPEN}: ${(err as Error).message}`, group: 'other' });
    }
  }
  return out;
}

/**
 * The reopened cards of a sync (issue #1126): of the issues listed (`seen`) whose outcome is `done, but the issue is still
 * open`, those whose job here ended, each read again for its body. The listing lists them as every open labelled issue, so
 * no GitHub delivery is needed.
 */
export async function reopenedRequests(api: Pick<GitHubApi, 'getIssue'>, seen: readonly GitHubIssue[], outcomes: readonly IntakeOutcome[],
  rerunnable: ((keys: string[]) => Set<string>) | undefined, intake: Pick<IntakeContext, 'history'> | undefined): Promise<Map<string, IntakeRequest>> {
  const doneOpen = outcomes.filter((x) => x.reason === DONE_OPEN).map((x) => x.key);
  const ended = rerunnable && doneOpen.length > 0 ? rerunnable(doneOpen) : new Set<string>();
  const requests = new Map<string, IntakeRequest>();
  for (const i of seen.filter((x) => ended.has(x.url))) {
    const issue = await api.getIssue(i.repo, i.number);
    if (issue.state === 'open') requests.set(i.url, reopenedRequest(issue, intake?.history?.(i.url) ?? { jobs: [] }));
  }
  return requests;
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

/** A GitHub issue URL's `owner/name`, lowercased; undefined for any other key. */
const repoOfKey = (key: string): string | undefined => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(key)?.[1]?.toLowerCase();

/**
 * Record `source.request_withdrawn` for each request card of this source the work-item ledger has waiting for approval that
 * this sync no longer offers (issue #1067, part 4): its issue closed, its label or assignee went, or it is of a trusted
 * origin now. Only for an issue of a repository the sync listed (`repos`, none in `repoErrors`): an issue not listed is not
 * known to be gone. `seen` forgets the withdrawn texts, so a card back in Intake opens again.
 */
export function withdrawRequests(source: string, intake: IntakeContext, offered: ReadonlyMap<string, IntakeRequest>, listed: { repos: readonly string[]; repoErrors: Record<string, string> }, seen: Set<string>): void {
  const errored = new Set(Object.keys(listed.repoErrors).map((r) => r.toLowerCase()));
  const read = new Set(listed.repos.map((r) => r.toLowerCase()).filter((r) => !errored.has(r)));
  for (const key of intake.requestsWaiting()) {
    const repo = repoOfKey(key);
    if (offered.has(key) || repo === undefined || !read.has(repo)) continue;
    intake.record('source.request_withdrawn', { source, key });
    for (const id of [...seen]) if (id.startsWith(`${key} `)) seen.delete(id);
  }
}
