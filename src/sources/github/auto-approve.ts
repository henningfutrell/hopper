// Auto-approval at the GitHub source (issue #1268, domain/intake-auto-approve.ts): of a sync's request cards, those a rule
// approves. For each card it reads who added `hopper:high`, who reopened a reopened card, and who edited its title or body;
// the logins the card's own acts did not answer for are asked of Access once for the sync. A card whose events or edits
// cannot be read, or whose trusted actors cannot be checked, waits for a person; so does one a person took into Intake
// (issue #1176), which asks for a request card, not a job.
import { requestHash, type IntakeRequest, type OriginActor } from '../../domain/intake-origin.ts';
import { FILED_BY_JOB_REASON, isBotLogin } from '../../domain/intake-origin.ts';
import { autoApproval, autoApprovedReason, LABEL_HIGH, type AutoApproval } from '../../domain/intake-auto-approve.ts';
import type { IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import type { GitHubApi, GitHubIssue, IssueEvent } from './api.ts';
import { actOf, UNCHECKED, type Act } from './origin.ts';

/** A request card and the issue it is of. */
export interface AutoApproveCard { issue: Pick<GitHubIssue, 'repo' | 'number' | 'url' | 'labels'>; request: IntakeRequest }

/** The cards of a sync's requests, each with its issue as listed or read (`issues`); a request with no issue there is left out. */
export function cardsOf(requests: ReadonlyMap<string, IntakeRequest>, issues: readonly GitHubIssue[]): AutoApproveCard[] {
  return [...requests].flatMap(([url, request]) => { const issue = issues.find((i) => i.url === url); return issue ? [{ issue, request }] : []; });
}

/** The outcome of a card the hopper approved: no action, until the next sync takes it; undefined when none did. */
export const autoOutcome = (x: IntakeOutcome, a: AutoApproval | undefined): IntakeOutcome | undefined => (a ? { ...x, reason: autoApprovedReason(a), group: 'other' } : undefined);

type Read = { card: AutoApproveCard; high?: Act; reopened?: Act; editors: Act[] };

const newest = (events: IssueEvent[], pick: (e: IssueEvent) => boolean) => events.filter(pick).sort((a, b) => a.at.localeCompare(b.at)).at(-1);

/** One card's acts, or undefined when they cannot be read. */
async function readCard(api: Pick<GitHubApi, 'issueEvents' | 'issueEdits'>, card: AutoApproveCard): Promise<Read | undefined> {
  const { repo, number } = card.issue;
  try {
    const events = await api.issueEvents(repo, number);
    const edits = api.issueEdits ? await api.issueEdits(repo, number) : [];
    const high = card.issue.labels.includes(LABEL_HIGH) ? actOf('labelled', newest(events, (e) => e.event === 'labeled' && e.label === LABEL_HIGH), undefined) : undefined;
    const reopened = card.request.reopened ? actOf('author', newest(events, (e) => e.event === 'reopened'), undefined) : undefined;
    const editors = edits.map((e): Act => ({ role: 'author', login: e.editor, ...(isBotLogin(e.editor) ? { app: e.editor } : {}) }));
    return { card, ...(high ? { high } : {}), ...(reopened ? { reopened } : {}), editors };
  } catch (err) {
    console.warn(`hopper: auto-approval of ${card.issue.url} could not read its events: ${(err as Error).message}`);
    return undefined;
  }
}

/** The cards a rule approves, each with its rule and actor. Off, or no setting: none. */
export async function autoApprovals(api: Pick<GitHubApi, 'issueEvents' | 'issueEdits'>, trust: Pick<IntakeTrust, 'trusted' | 'autoApproval' | 'approvedText' | 'takenIn'>,
  cards: readonly AutoApproveCard[], connected: string): Promise<Map<string, AutoApproval>> {
  const out = new Map<string, AutoApproval>();
  const setting = trust.autoApproval?.();
  if (!setting?.on) return out;
  const reads: Read[] = [];
  for (const card of cards) {
    const guarded = card.request.why.some((w) => w === FILED_BY_JOB_REASON || w.startsWith(UNCHECKED)) || card.request.approved !== undefined
      || trust.takenIn?.(card.issue.url) === true;
    const read = guarded ? undefined : await readCard(api, card);
    if (read) reads.push(read);
  }
  const known = new Map<string, boolean>();
  for (const a of cards.flatMap((c) => c.request.actors)) if (a.login && !a.app) known.set(a.login.toLowerCase(), a.trusted);
  const asked = [...new Set(reads.flatMap((r) => [r.high, r.reopened, ...r.editors]).flatMap((a) => (a?.login && !a.app && !known.has(a.login.toLowerCase()) ? [a.login.toLowerCase()] : [])))];
  const answers = asked.length > 0 ? await trust.trusted(asked.map((login) => ({ login })), connected) : new Map();
  const judge = (a: Act | undefined): OriginActor | undefined => a && ({ ...a, trusted: !a.app && a.login !== undefined && (known.get(a.login.toLowerCase()) ?? answers.get(a.login.toLowerCase())?.allowed === true) });
  for (const r of reads) {
    const acts = [r.high, r.reopened, ...r.editors];
    if (acts.some((a) => a?.login && answers.get(a.login.toLowerCase())?.unavailable)) continue;
    const approved = trust.approvedText(r.card.issue.url);
    const found = autoApproval({
      actors: r.card.request.actors, reopenedCard: r.card.request.reopened !== undefined, editors: r.editors.map((e) => judge(e)!),
      ...(r.high ? { high: judge(r.high)! } : {}), ...(r.reopened ? { reopened: judge(r.reopened)! } : {}),
      textApproved: approved !== undefined && requestHash(approved) === r.card.request.hash, guards: [],
    }, setting);
    if (found) out.set(r.card.issue.url, found);
  }
  return out;
}
