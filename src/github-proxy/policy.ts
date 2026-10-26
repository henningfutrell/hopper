// What a job may ask the hopper to do on GitHub (issue #563, design.md "GitHub through the hopper"): the
// operations, the request's shape, and the check against who asks. Pure: no I/O, no clock.
//
// The hopper acts for a job with the GitHub connection of the job's own user (issue #1380): a job may file and read
// issues, comment, open a pull request from its pushed branch, mark one ready for review (issue #1275: on its own
// repository or another job repository, where its change may belong), edit or close a pull request it opened or its work
// item's (issue #1734), close its own issue as completed (issue #652: it holds no GitHub token of its own), and read pull requests and a failed
// check's log (issue #993), on its user's job repositories; it reads (`READS`) on any repository the connection sees
// (issue #1015): the job repositories decide intake and where a job files issues, not what it reads. On any other
// repository (issue #1806) a job opens a pull request from a branch it pushed — it pushes wherever its user can, and GitHub
// alone refuses —, and marks ready, edits or closes only one it opened (`PR_OWNED`); it files and comments on no issue there.
// Nothing a job asks for carries labels or assignees: a filed issue never becomes a job by itself.
// An issue a job files is a child of the job's own issue (issue #729, issue lineage): a follow-up, or — `required` — a
// required child, linked as a GitHub sub-issue, so the parent is not done while it is open.
// The contribution flow (issue #429): with the user's Contribution on, a job of a repository its user cannot
// push to may have the hopper fork it into the user's account (`repo.fork`), open its pull request there from the fork
// (`--head <login>:<branch>`), and file, read and comment on issues on that fork — the **job's fork**, a fork of the
// job's own repository owned by the user, as GitHub says (the broker reads it): the fork is no job repository.
import { z } from 'zod';
import { isCommand } from '../domain/comment-command.ts';
import { LOOK_ONLY } from '../domain/direct-jobs.ts';
import { RESEND_KEY } from '../domain/post-key.ts';

export const PROXY_OPS = [
  'issue.create', 'issue.comment', 'issue.view', 'issue.comments', 'issue.close', 'pr.create', 'pr.view', 'pr.diff', 'pr.commits', 'pr.checks',
  'pr.reviews', 'pr.status', 'pr.ready', 'pr.edit', 'pr.close', 'repo.view', 'repo.fork', 'check.log', 'run.list', 'run.view',
] as const;
export type ProxyOp = (typeof PROXY_OPS)[number];

const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be owner/name');
const number = z.coerce.number().int().positive();
const text = (max: number) => z.string().min(1).max(max);
const branch = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/, 'a branch name: letters, digits, . _ / -');
/** A pull request's head: a branch, or `<owner>:<branch>` for a branch of a fork (issue #429). */
const head = z.string().regex(/^(?:[A-Za-z0-9-]{1,39}:)?[A-Za-z0-9._/-]{1,200}$/, 'a branch name, or owner:branch for a fork\'s');
/** A resend key (issue #1607): hopper-gh makes one for each issue create, comment, pull request create (issue #1959) and bug report (issue #2813), the same each time it sends it. */
const key = z.string().regex(RESEND_KEY, 'a resend key: 8 to 64 letters, digits, _ or -');
/** A workflow run's event, as GitHub names it: `push`, `pull_request`, `workflow_dispatch`. */
const event = z.string().regex(/^[a-z_]{1,40}$/, 'an event: lower-case letters and _, as push or pull_request');
/** A flag: from a form it comes as the text `true`. */
const flag = z.union([z.literal('true'), z.literal(true)]).transform(() => true as const);

/** One request, as the hopper takes it: the operation and only the fields it uses. GitHub's limits on titles and bodies. */
export const proxyRequest = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('issue.create'), repo, title: text(256), body: text(60_000), required: flag.optional(), key: key.optional() }),
  z.strictObject({ op: z.literal('issue.comment'), repo, number, body: text(60_000), key: key.optional() }),
  z.strictObject({ op: z.literal('issue.view'), repo, number }),
  z.strictObject({ op: z.literal('issue.comments'), repo, number }),
  z.strictObject({ op: z.literal('issue.close'), repo, number }),
  z.strictObject({ op: z.literal('pr.create'), repo, head, base: branch.optional(), title: text(256), body: text(60_000), key: key.optional() }),
  z.strictObject({ op: z.literal('pr.view'), repo, number }),
  // The repo queries of a pull request (issue #1074): its diff, its commits, the check runs of its head commit.
  z.strictObject({ op: z.literal('pr.diff'), repo, number }),
  z.strictObject({ op: z.literal('pr.commits'), repo, number }),
  z.strictObject({ op: z.literal('pr.checks'), repo, number }),
  // Its reviews (issue #1072): each review, and what the latest of each reviewer decides.
  z.strictObject({ op: z.literal('pr.reviews'), repo, number }),
  // Where a pull request stands (issue #1072): answered from the hopper's records first, GitHub only for one it does not know.
  z.strictObject({ op: z.literal('pr.status'), repo, number }),
  z.strictObject({ op: z.literal('pr.ready'), repo, number }),
  // A pull request's title or body changed, or the pull request closed with no merge (issue #1734): one the job owns only.
  z.strictObject({ op: z.literal('pr.edit'), repo, number, title: text(256).optional(), body: text(60_000).optional() })
    .refine((r) => r.title !== undefined || r.body !== undefined, 'pr edit needs --title or --body (or --body-file)'),
  z.strictObject({ op: z.literal('pr.close'), repo, number }),
  z.strictObject({ op: z.literal('repo.view'), repo }),
  z.strictObject({ op: z.literal('repo.fork'), repo }),
  // A failed check's full log (issue #993): `number` is its GitHub Actions job, the last number of the check's link.
  z.strictObject({ op: z.literal('check.log'), repo, number }),
  // A repository's workflow runs, of a branch and an event when named, and one run's jobs (issue #2318): `number` is the run's id.
  z.strictObject({ op: z.literal('run.list'), repo, branch: branch.optional(), event: event.optional() }),
  z.strictObject({ op: z.literal('run.view'), repo, number }),
]);
export type ProxyRequest = z.infer<typeof proxyRequest>;

/**
 * A job's bug report on the hopper itself (issue #694, design.md "Report a bug"): not an act of the hopper's connection
 * but of the job's own user's, by Report a bug's own path; so it has no repository of its own to check — it always goes
 * to the hopper's. `commentOn` adds it to a similar open report; `force` files it even with one. `key`: its resend key
 * (issue #2813), which hopper-gh makes and sends again when no answer came: the same key files it once.
 */
export const REPORT_OP = 'report.bug';
export const reportRequest = z.strictObject({
  op: z.literal(REPORT_OP), title: text(200), body: text(10_000), commentOn: number.optional(),
  force: flag.optional(), key: key.optional(),
});
export type ReportRequest = z.infer<typeof reportRequest>;

/**
 * A wait on a pull request's checks (issue #1072 part 2, `pr wait`): asked as `pr.status`; while the checks of a pull
 * request the hopper follows run, the answer comes on the job's stream (issue #613) once they end. `timeout`: the most
 * seconds to wait (the stream's default, an hour, unless said). `for` (issue #1210): `mergeable` waits instead for the next
 * mergeability the hopper sees of it; `checks`, the default.
 */
export const WAIT_OP = 'pr.wait';
export const waitRequest = z.strictObject({ op: z.literal(WAIT_OP), repo, number, timeout: number.optional(), for: z.enum(['checks', 'mergeable']).optional() });
export type WaitRequest = z.infer<typeof waitRequest>;

/** Who asks: the job, and the repository it came from. */
export interface ProxyAsker {
  jobId: string;
  /** The job's own repository (its source's, or its parent's for a fork); absent: none. */
  repo?: string;
  /** The number of the job's own issue in that repository; absent: none. */
  issue?: number;
  /** Whether the user's Contribution is on (issue #429). */
  contribution?: boolean;
  /** The login of the job's user's connection, which acts for it: the owner of the job's fork. */
  login?: string;
  /** A direct query's job (issue #2184): it only reads. */
  lookOnly?: boolean;
  /** The request's repository when GitHub says it is the job's fork: the user's fork of the job's own repository. */
  fork?: string;
  /** Whether the user can push to the job's own repository, as GitHub says, when read (for `repo.fork`). */
  canPush?: boolean;
  /**
   * For `pr.edit` and `pr.close` (issue #1734): whether the job opened that pull request, or it is its work item's or the one
   * it tends; for `pr.edit` also one its issue names (issues #2151, #2227).
   */
  ownsPullRequest?: boolean;
  /** Why the job does not own that pull request (issue #2227), for the refusal. */
  notOwned?: string;
}

/** Why a job's comment is refused (issue #655 part 21): a comment command nominates an issue, and a job nominates none. */
export const JOB_COMMAND = 'a job writes no comment command (/hopper run, research or propose): only a person nominates an issue';

/** Why a job may not work through a fork now (issue #429). */
export const CONTRIBUTION_OFF = 'contributing through a fork is off: a person turns it on in Settings → Contribution';

/** What a job may ask on its fork: issues, and reads. Its pull request goes on the repository the fork is of. */
const ON_FORK: readonly ProxyOp[] = ['issue.create', 'issue.comment', 'issue.view', 'issue.comments', 'pr.view', 'pr.diff', 'pr.commits', 'pr.checks', 'pr.reviews', 'pr.status', 'repo.view', 'run.list', 'run.view'];

/**
 * What only reads (issue #1015): a job asks them on any repository its user's connection sees. Each is a **repo
 * query** (issue #1074): answered from the repo-query cache when it can be (repo-query.ts).
 */
export const READS: readonly ProxyOp[] = ['issue.view', 'issue.comments', 'pr.view', 'pr.diff', 'pr.commits', 'pr.checks', 'pr.reviews', 'pr.status', 'repo.view', 'check.log', 'run.list', 'run.view'];
export const isRead = (op: ProxyOp): boolean => READS.includes(op);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * What a job asks of one pull request (issue #1806): on a repository the hopper does not work on, only of a pull request it
 * opened, or its work item's (`ownsPullRequest`).
 */
export const PR_OWNED: readonly ProxyOp[] = ['pr.ready', 'pr.edit', 'pr.close'];

/** Whether the asker may have the request done; else why not, in words the job can act on. */
export function checkRequest(req: ProxyRequest, asker: ProxyAsker, jobRepositories: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (asker.lookOnly && !isRead(req.op)) return { ok: false, reason: LOOK_ONLY };
  const onFork = asker.fork !== undefined && same(asker.fork, req.repo);
  const anywhere = req.op === 'pr.create' || (PR_OWNED.includes(req.op) && asker.ownsPullRequest === true);
  if (!onFork && !READS.includes(req.op) && !anywhere && !jobRepositories.some((r) => same(r, req.repo))) {
    return { ok: false, reason: PR_OWNED.includes(req.op)
      ? `${req.repo} is not one of the repositories the hopper works on: there a job marks ready, edits or closes only a pull request it opened`
      : `${req.repo} is not one of the repositories the hopper works on, so it does nothing there for a job but open a pull request from a branch it pushed` };
  }
  if (onFork && req.op === 'pr.create') {
    return { ok: false, reason: `open the pull request on ${asker.repo}, from the fork: --repo ${asker.repo} --head ${asker.login}:<branch>` };
  }
  if (onFork && !ON_FORK.includes(req.op)) {
    return { ok: false, reason: `on the job's fork ${req.repo} a job files, reads and comments on issues, and reads pull requests: not ${req.op}` };
  }
  const ownRepo = asker.repo !== undefined && same(asker.repo, req.repo);
  if (req.op === 'repo.fork') {
    if (!ownRepo) return { ok: false, reason: `a job forks only its own repository${asker.repo ? ` (${asker.repo})` : ', and this job has none'}` };
    if (!asker.contribution) return { ok: false, reason: CONTRIBUTION_OFF };
    if (asker.canPush) return { ok: false, reason: `your user can push to ${req.repo}: push a branch there, with no fork` };
  }
  const forkOwner = req.op === 'pr.create' && req.head.includes(':') ? req.head.split(':')[0]! : undefined;
  if (forkOwner !== undefined && !ownRepo) {
    return { ok: false, reason: `a job opens a pull request from its user's fork only on its own repository${asker.repo ? ` (${asker.repo})` : ', and this job has none'}` };
  }
  if (forkOwner !== undefined && !asker.contribution) return { ok: false, reason: CONTRIBUTION_OFF };
  if (forkOwner !== undefined && !(asker.login && same(asker.login, forkOwner))) {
    return { ok: false, reason: `a job opens a pull request from a fork only from its user's own (${asker.login ?? 'no login'}), not ${forkOwner}` };
  }
  if (req.op === 'issue.create' && req.required && (asker.repo === undefined || asker.issue === undefined)) {
    return { ok: false, reason: 'a required child is a child of the job\'s own issue, and this job has none: file it with no --required' };
  }
  if (req.op === 'issue.close' && !(ownRepo && asker.issue === req.number)) {
    return { ok: false, reason: `a job closes only its own issue${asker.repo && asker.issue !== undefined ? ` (${asker.repo}#${asker.issue})` : ', and this job has none'}` };
  }
  if (req.op === 'issue.comment' && isCommand(req.body)) return { ok: false, reason: JOB_COMMAND };
  if ((req.op === 'pr.edit' || req.op === 'pr.close') && !asker.ownsPullRequest) {
    return { ok: false, reason: `a job edits or closes only a pull request it opened, the one it tends or its work item's, and edits one its issue names: not ${req.repo}#${req.number}${asker.notOwned ? `: ${asker.notOwned}` : ''}` };
  }
  return { ok: true };
}

/** The job's issue a filed issue is a child of (issue #729), and whether the job marked it required. */
export interface IssueParent { repo: string; number: number; required: boolean }

/**
 * The label a routed child gets (issue #1510): the job sources' default label, as the Add PR checks job's
 * (src/repo-checks/service.ts), so a source of that repository lists it.
 */
export const ROUTE_LABEL = 'hopper';

/**
 * What every issue filed through the hopper carries at its end: its parent, the job's issue (issue #729: GitHub links
 * the mention back on the parent), that the hopper filed it for a job, which one, and that it waits for a person: to triage
 * a follow-up, or, for a required child the hopper routed (issue #1510), to approve its request card. Ids
 * only — GitHub text names no person and no machine (repo law); the hopper's event log has who asked and from where,
 * under the request id.
 */
export function filedNote(jobId: string, requestId: string, parent?: IssueParent): string {
  const ref = parent && `${parent.repo}#${parent.number}`;
  const lineage = !parent ? '' : parent.required ? `Required child of ${ref}: that issue is not done while this one is open.\n` : `Follow-up of ${ref}.\n`;
  const waits = parent?.required
    ? 'Routed by the hopper: Intake lists it as a request card, and a person approves it before a job takes it.'
    : 'It is not a job: it waits for a person to triage it.';
  return `\n\n---\n${lineage}Filed through hopper for job \`${jobId}\` (request \`${requestId}\`). ${waits}`;
}

/**
 * What the job does next once its fork is made (issue #429): clone the fork, read the repository's contributing rules and
 * follow them, push to the fork, open the pull request on the repository from the fork; and where its issue goes.
 */
export function contributionSteps(upstream: string, fork: string, url: string, login: string, issues: string | undefined): string {
  const filing = issues === undefined ? `${upstream} takes no issues, and the issues of ${fork} could not be turned on: put what an issue would say in the pull request.`
    : issues === upstream ? `File an issue, when you need one, on ${upstream}.`
      : `${upstream} takes no issues: file an issue, when you need one, on ${fork} (--repo ${fork}), and name ${upstream} and its issue in the body.`;
  return [
    `Clone the fork: git clone ${url}.git (GitHub can take a few seconds to make it: try again when it is not there yet).`,
    'Before you make a branch, read the repository\'s contributing rules: CONTRIBUTING.md (also in .github/ and docs/), the pull request template (.github/PULL_REQUEST_TEMPLATE.md, .github/pull_request_template.md or .github/PULL_REQUEST_TEMPLATE/), CODE_OF_CONDUCT.md, and a CLA if it names one.',
    'Follow them: the branch name, the commit style, the tests to run, and the template for the pull request body. When a CLA needs a person to sign it, ask.',
    `Push your branch to the fork. Open the pull request on ${upstream}, from the fork: sh "$HOPPER_GH" pr create --repo ${upstream} --head ${login}:<branch> --title TITLE --body-file FILE.`,
    filing,
  ].join(' ');
}
