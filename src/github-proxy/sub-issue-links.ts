// A job's write sent again (issue #1607). hopper-gh sends a **resend key** with each issue create and comment, and sends
// the request again with the same key when its answer is lost; the hopper keeps the key on the request's
// `github_proxy.done`, so the same key is answered from it (`replayOf`) and nothing is done twice on GitHub.
// A required child's sub-issue link that GitHub refused, or that did not answer, is kept: `job.child_issue_filed` with
// `subIssue: false` and no `job.sub_issue_linked` after it. The link pass tries each such link again, at start and every
// `SUB_ISSUE_LINK_MS`, until it is made; a link GitHub already holds counts as made.
import type { EventType, NewEvent } from '../domain/types.ts';
import { makeRequest, paginate, splitRepo, statusOf } from '../sources/github/http/http.ts';
import { messageOf, ProxyGitHubError, tokenCaller, type SubIssueOf, type TokenSource } from './api.ts';

/** How often the kept sub-issue links are tried again: 5 minutes. */
export const SUB_ISSUE_LINK_MS = 5 * 60_000;
/** How many of the newest lineage events a pass and a replay read. */
const LINEAGE_READ = 1000;

/** The events the replay and the link pass read: what `UserStore['events']` gives. */
export interface LineageEvents {
  recent(limit?: number, types?: EventType[], jobId?: string): { jobId?: string; data: Record<string, unknown> }[];
  append(event: NewEvent): unknown;
}

/** The first answer to a request with a resend key, as its events keep it. */
export interface ProxyReplay {
  requestId: string;
  number?: number;
  url: string;
  /** For an issue create: its lineage, as `job.child_issue_filed` and `job.sub_issue_linked` keep it. */
  child?: { parent: SubIssueOf; required: boolean; subIssue?: boolean; routed?: boolean };
}

type Ref = { repo: string; number: number };
const refOf = (v: unknown): Ref | undefined => {
  const r = v as Partial<Ref> | undefined;
  return typeof r?.repo === 'string' && typeof r.number === 'number' ? { repo: r.repo, number: r.number } : undefined;
};

const linkedIds = (events: LineageEvents, jobId?: string): Set<string> =>
  new Set(events.recent(LINEAGE_READ, ['job.sub_issue_linked'], jobId).map((e) => String(e.data.requestId)));

/** The first answer to the job's request with resend key `key`; undefined: none was done yet. */
export function replayOf(events: LineageEvents, jobId: string, key: string): ProxyReplay | undefined {
  const done = events.recent(LINEAGE_READ, ['github_proxy.done'], jobId).filter((e) => e.data.key === key && e.data.replayed !== true).at(-1);
  if (!done || typeof done.data.url !== 'string') return undefined;
  const requestId = String(done.data.requestId);
  const filed = events.recent(LINEAGE_READ, ['job.child_issue_filed'], jobId).find((e) => e.data.requestId === requestId);
  const parent = refOf(filed?.data.parent);
  const child = filed && parent ? {
    parent, required: filed.data.required === true,
    ...(typeof filed.data.subIssue === 'boolean' ? { subIssue: filed.data.subIssue || linkedIds(events, jobId).has(requestId) } : {}),
    ...(filed.data.routed === true ? { routed: true } : {}),
  } : undefined;
  return { requestId, ...(typeof done.data.number === 'number' ? { number: done.data.number } : {}), url: done.data.url, ...(child ? { child } : {}) };
}

/**
 * The first answer to a request with resend key `key` from `jobId`, else from an earlier job of the same issue (`sameIssue`):
 * a **fan-out key** is the issue's (issue #1909), so a Run again, a new job, files nothing an earlier job filed.
 */
export function replayOfIssue(events: LineageEvents, jobId: string, key: string, sameIssue: (otherJobId: string) => boolean): ProxyReplay | undefined {
  const own = replayOf(events, jobId, key);
  if (own) return own;
  const earlier = events.recent(LINEAGE_READ, ['github_proxy.done'])
    .filter((e) => e.data.key === key && e.data.replayed !== true && e.jobId !== undefined && e.jobId !== jobId && sameIssue(e.jobId)).at(-1);
  return earlier?.jobId ? replayOf(events, earlier.jobId, key) : undefined;
}

/** Links `child` as a sub-issue of `parent` on GitHub, unless it is one already. Throws `ProxyGitHubError`. */
export function createSubIssueLinker(o: { apiUrl: string } & TokenSource): (parent: SubIssueOf, child: SubIssueOf) => Promise<void> {
  const req = makeRequest(o.apiUrl, undefined, { kind: 'job' });
  const withToken = tokenCaller(o);
  return (parent, child) => withToken(async (token) => {
    const headers = { authorization: `token ${token}` };
    const id = ((await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(child.repo), issue_number: child.number, headers })).data as { id?: number }).id;
    if (id === undefined) throw new Error(`GitHub gave no id for ${child.repo}#${child.number}`);
    const held = await paginate<{ id?: number }>(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...splitRepo(parent.repo), issue_number: parent.number, per_page: 100 }, `token ${token}`, (d) => d as { id?: number }[]);
    if (held.some((i) => i.id === id)) return;
    await req('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...splitRepo(parent.repo), issue_number: parent.number, sub_issue_id: id, headers });
  }, (err) => new ProxyGitHubError(messageOf(err, `the sub-issue link to ${parent.repo}#${parent.number}`), statusOf(err)));
}

export interface SubIssueLinks {
  /** Tries each kept link once now. Never throws. */
  retry(): Promise<void>;
  start(): void;
  /** Ends the timer, then waits for a pass in flight: the user's runtime closes its store after this. */
  stop(): Promise<void>;
}

export function createSubIssueLinks(o: {
  events: LineageEvents;
  /** The link with the connected account of `repo` (the parent's); or why there is none now. */
  link(repo: string): ((parent: SubIssueOf, child: SubIssueOf) => Promise<void>) | { problem: string };
  log(line: string): void;
  everyMs?: number;
}): SubIssueLinks {
  async function pass(): Promise<void> {
    const linked = linkedIds(o.events);
    const kept = o.events.recent(LINEAGE_READ, ['job.child_issue_filed'])
      .filter((e) => e.data.required === true && e.data.subIssue === false && !linked.has(String(e.data.requestId)));
    for (const e of kept.reverse()) {
      const parent = refOf(e.data.parent);
      const child = refOf(e.data.child);
      if (!parent || !child) continue;
      const link = o.link(parent.repo);
      if ('problem' in link) { o.log(`hopper: sub-issue link of ${child.repo}#${child.number} to ${parent.repo}#${parent.number} waits: ${link.problem}`); continue; }
      try {
        await link(parent, child);
        o.events.append({ type: 'job.sub_issue_linked', ...(e.jobId ? { jobId: e.jobId } : {}), data: { requestId: String(e.data.requestId), parent, child: { ...child, url: String((e.data.child as { url?: unknown }).url ?? '') } } });
      } catch (err) {
        o.log(`hopper: sub-issue link of ${child.repo}#${child.number} to ${parent.repo}#${parent.number} failed, tried again later: ${(err as Error).message}`);
      }
    }
  }
  let running: Promise<void> | undefined;
  // One pass at a time: a link is never made twice by two passes at once.
  const retry = (): Promise<void> => (running ??= pass().catch((e: unknown) => { o.log(`hopper: the sub-issue link pass failed: ${(e as Error).message}`); }).finally(() => { running = undefined; }));
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    retry,
    start() {
      void retry();
      timer ??= setInterval(() => { void retry(); }, o.everyMs ?? SUB_ISSUE_LINK_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
