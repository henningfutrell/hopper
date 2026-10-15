// Untracked pull requests (issue #1176, design.md "Untracked pull requests"): every open pull request of a job repository is
// in the ledger — a job names it, or an item's pull request is it — or it is an **untracked pull request**, listed with the
// one reason the hopper does not track it: it links no issue, its issue is not in Intake, its base is not the landing
// branch, its item's job follows another pull request, or no job made it. One whose issue is not in Intake offers that
// issue to Intake (`take_in`, Take into Intake). Pure: the source reads the open pull requests, the store says what is tracked.
import { closingReferences } from './cross-references.ts';
import type { IntakeWriteBehind } from './intake.ts';

export const UNTRACKED_REASONS = ['no_issue', 'issue_not_in_intake', 'wrong_base', 'second_pull_request', 'not_by_a_job'] as const;
/**
 * Why an open pull request is not tracked: `no_issue`, its text closes no issue of its repository and is part of none;
 * `issue_not_in_intake`, its issue is no work item (no label, no assignee, or not of the user); `wrong_base`, its issue is a
 * work item, and its base is not the repository's landing branch nor another open pull request's head;
 * `second_pull_request`, its issue is a work item whose job follows another pull request (`followed`): one item, two pull
 * requests, and the hopper tends only the one its job follows; `not_by_a_job`,
 * its issue is a work item, and no job of it names this pull request (a person's, a second one, or one moved to the landing
 * branch that no job follows yet).
 */
export type UntrackedReason = (typeof UNTRACKED_REASONS)[number];

/** An open pull request as the census reads it. `base` absent: GitHub did not say. */
export interface CensusPullRequest { url: string; title?: string; base?: string; headRef: string; body: string; createdAt: string }

/** An untracked pull request, with the issue it links (`part`: "Part of #N") and why it is not tracked. */
export interface UntrackedPullRequest {
  repo: string;
  url: string;
  title?: string;
  base?: string;
  issue?: { number: number; url: string; part: boolean };
  reason: UntrackedReason;
  /** The pull request a job of its issue's item follows: this one is a second one (`second_pull_request`). */
  followed?: string;
  /** `take_in`: its issue is not in Intake, and Take into Intake offers it (its source's intake action). */
  offer?: 'take_in';
  /** The job source whose census listed it: where Take into Intake goes. Set when the list is answered. */
  source?: string;
  /** The hopper moved it to the landing branch (issue #1176): a job's branch, on a base from before. */
  retargeted?: { from: string; to: string };
  /** Take into Intake's GitHub write on its issue, after the answer (issue #1194): running, or failed with why. Set when the list is answered. */
  writeBehind?: IntakeWriteBehind;
}

/** What the store says of the open pull requests. */
export interface CensusFacts {
  /** A job names the pull request, or the ledger holds it as an item's pull request. */
  tracked(url: string): boolean;
  /** The ledger holds the issue (its URL) as a work item. */
  issueTracked(url: string): boolean;
  /** The pull request a job of the item (the issue's URL) follows; undefined: none. */
  followedOf(url: string): string | undefined;
  /** The repository's landing branch; undefined: it has no landing batches, and no base is wrong. */
  landing(repo: string): string | undefined;
}

const PART_OF = /(?<![\w-])part\s+of\s+#(\d+)(?![\w/])/i;

/** The issue of `repo` the pull request's text closes, else the one it is part of ("Part of #N"); undefined: none. */
export function issueOfPullRequest(body: string, repo: string): { number: number; part: boolean } | undefined {
  const closes = closingReferences(body, repo).find((r) => r.repo.toLowerCase() === repo.toLowerCase());
  if (closes) return { number: closes.number, part: false };
  const part = PART_OF.exec(body);
  return part ? { number: Number(part[1]), part: true } : undefined;
}

/** The URL of issue `n` of the pull request `url`'s repository. */
const issueUrlOf = (url: string, n: number): string => url.replace(/\/pull\/\d+\/?$/, `/issues/${n}`);
const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/** The untracked pull requests among `prs`, the open ones of `repo`, each with its reason, by number. */
export function untrackedPullRequests(repo: string, prs: readonly CensusPullRequest[], facts: CensusFacts): UntrackedPullRequest[] {
  const heads = new Set(prs.map((p) => p.headRef));
  const landing = facts.landing(repo);
  const out: UntrackedPullRequest[] = [];
  for (const pr of [...prs].sort((a, b) => numberOf(a.url) - numberOf(b.url))) {
    if (facts.tracked(pr.url)) continue;
    const linked = issueOfPullRequest(pr.body, repo);
    const issue = linked && { ...linked, url: issueUrlOf(pr.url, linked.number) };
    const offBase = landing !== undefined && pr.base !== undefined && pr.base !== landing && !heads.has(pr.base);
    const inIntake = issue !== undefined && facts.issueTracked(issue.url);
    const followed = inIntake ? facts.followedOf(issue.url) : undefined;
    const reason: UntrackedReason = !issue ? 'no_issue' : !inIntake ? 'issue_not_in_intake' : offBase ? 'wrong_base' : followed ? 'second_pull_request' : 'not_by_a_job';
    out.push({
      repo, url: pr.url, ...(pr.title ? { title: pr.title } : {}), ...(pr.base ? { base: pr.base } : {}), ...(issue ? { issue } : {}), reason,
      ...(followed ? { followed } : {}), ...(reason === 'issue_not_in_intake' ? { offer: 'take_in' as const } : {}),
    });
  }
  return out;
}


/**
 * An untracked pull request whose issue was just taken into Intake (issue #1238): no longer offered, its reason as the next
 * census gives it — off the landing branch, or by no job, as no job of the new item follows one yet — until that census.
 */
export function takenIntoIntake(u: UntrackedPullRequest, landing: string | undefined): UntrackedPullRequest {
  const { offer: _offer, ...rest } = u;
  return { ...rest, reason: landing !== undefined && u.base !== undefined && u.base !== landing ? 'wrong_base' : 'not_by_a_job' };
}
