// What the hopper watches of a job's own wait (issue #1508, design.md "Watched items"): a wait on an item, or on an outside
// event whose text names items — an issue or a pull request of any repository (`o/r#N`, `name#N` in the job's owner unless
// the text names it with an owner too, issue #2066; `issue N` in its own repository, a link), a workflow run (`<repo> run N`,
// `workflow run N`, a link). At each sync of the job's source each one is read (`JobSource.endedWatched`); once every one a
// wait names ended — closed, merged, the run completed —, the job wakes (`job.waited_items_ended`), though it ended before
// the watch began; but not an outside wait for one that ended before the wait began (`endedBeforeWait`, issue #2219). A wait on the job's own command is the pane's
// (`paneCarriesWait`): it wakes when that pane is lost. An outside wait the hopper watches no way is not (issue #2338). Pure.
import type { Job } from './types.ts';

/** A thing a wait names that the hopper reads: an issue or a pull request (one GitHub number), or a workflow run. */
export type WatchedRef = { kind: 'issue'; repo: string; number: number } | { kind: 'run'; repo: string; runId: number };

/**
 * The state of a watched thing that does not exist (issue #1691): no such repository, item or run, or one the hopper's connection
 * cannot read (GitHub answers both alike, issue #2066). It never ends.
 */
export const NOT_FOUND = 'not_found';

/**
 * A watched thing seen ended: an issue `closed`, a pull request `merged` or `closed`, a run completed with its conclusion; or
 * one that does not exist, `not_found`. `at` (issue #2219): when it ended, when the source says (an issue's close, a pull
 * request's merge or close).
 */
export interface WatchedEnd { ref: WatchedRef; url: string; state: string; at?: string }

/** A watched thing, and the jobs whose waits name it. */
export interface Watched { ref: WatchedRef; jobIds: string[] }

type WaitingJob = Pick<Job, 'id' | 'status' | 'wait' | 'source'>;

const NAME = String.raw`[A-Za-z0-9][\w.-]*`;
const LINK = new RegExp(String.raw`github\.com\/(${NAME}\/${NAME})\/(issues|pull|actions\/runs)\/(\d+)`, 'g');
const NUMBERED = new RegExp(String.raw`(?<![\w./-])(?:(${NAME})\/)?(${NAME})#(\d+)\b`, 'g');
const ISSUE_WORD = /\b(?:issue|item)\s+#?(\d+)\b/gi;
const RUN = new RegExp(String.raw`(?<![\w./-])(?:(${NAME})\/)?(${NAME})\s+run\s+#?(\d{5,})\b`, 'g');
/** Words before "run" that name no repository: the run is in the job's own. */
const NOT_A_REPO = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'its', 'this', 'that', 'until', 'when', 'after', 'and', 'or', 'to', 'workflow', 'actions', 'ci', 'deploy', 'deployment', 'github']);

export const watchKey = (r: WatchedRef): string => `${r.kind}:${r.repo.toLowerCase()}#${r.kind === 'issue' ? r.number : r.runId}`;

/** The items `text` names, in the order it names them; `ownRepo` for a name with no owner, or none at all. */
function refsIn(text: string, ownRepo: string | undefined): WatchedRef[] {
  const owner = ownRepo?.split('/')[0];
  // `guessed`: a name with no owner, put in the job's owner; dropped when the text names that item with its owner too.
  const found: { at: number; ref: WatchedRef; guessed?: boolean }[] = [];
  const named = (o: string | undefined, name: string): string | undefined => (o ? `${o}/${name}` : owner ? `${owner}/${name}` : undefined);
  for (const m of text.matchAll(LINK)) {
    found.push({ at: m.index, ref: m[2] === 'actions/runs' ? { kind: 'run', repo: m[1]!, runId: Number(m[3]) } : { kind: 'issue', repo: m[1]!, number: Number(m[3]) } });
  }
  for (const m of text.matchAll(NUMBERED)) {
    const repo = named(m[1], m[2]!);
    if (repo) found.push({ at: m.index, ref: { kind: 'issue', repo, number: Number(m[3]) }, guessed: !m[1] });
  }
  for (const m of text.matchAll(ISSUE_WORD)) if (ownRepo) found.push({ at: m.index, ref: { kind: 'issue', repo: ownRepo, number: Number(m[1]) } });
  for (const m of text.matchAll(RUN)) {
    const own = !m[1] && NOT_A_REPO.has(m[2]!.toLowerCase());
    const repo = own ? ownRepo : named(m[1], m[2]!);
    if (repo) found.push({ at: m.index, ref: { kind: 'run', repo, runId: Number(m[3]) }, guessed: !m[1] && !own });
  }
  // Issue #2066: `hopper#2042` beside `octo/hopper#2042` is that one, not the job's owner's.
  const nameKey = (r: WatchedRef) => watchKey({ ...r, repo: r.repo.split('/')[1]! });
  const written = new Set(found.filter((f) => !f.guessed).map((f) => nameKey(f.ref)));
  const seen = new Set<string>();
  return found.filter((f) => !f.guessed || !written.has(nameKey(f.ref))).sort((a, b) => a.at - b.at).map((f) => f.ref)
    .filter((r) => !seen.has(watchKey(r)) && seen.add(watchKey(r)));
}

/**
 * What the hopper watches of `job`'s own wait: the item it waits on, or the items the text of an outside wait (or one with
 * nothing recorded) names. Never the job's own issue: its close ends the job (issue #1460). None while it does not wait.
 */
export function watchedOf(job: WaitingJob): WatchedRef[] {
  const w = job.wait;
  if (job.status !== 'waiting_on' || !w) return [];
  const own = job.source?.repo;
  const notOwn = (r: WatchedRef) => !(r.kind === 'issue' && own && r.repo.toLowerCase() === own.toLowerCase() && r.number === job.source?.number);
  const on = w.on;
  if (on?.kind === 'item') {
    const repo = on.repo ?? own;
    return repo ? [{ kind: 'issue' as const, repo, number: on.number }].filter(notOwn) : [];
  }
  if (on && on.kind !== 'outside') return [];
  return refsIn([w.for, w.until ?? '', on?.what ?? ''].join('\n'), own).filter(notOwn);
}

/**
 * Whether `end` came before `job`'s wait on an outside event (or one with nothing recorded) began (issue #2219): an item its
 * text names that had ended already is what the job knew, not the event it waits for, so it does not end the wait. A wait on
 * an item still ends on one that ended before (issue #1356), and an item that does not exist is still said at once.
 */
export function endedBeforeWait(job: Pick<Job, 'wait'>, end: Pick<WatchedEnd, 'state' | 'at'> | undefined): boolean {
  const w = job.wait;
  if (!w || !end?.at || end.state === NOT_FOUND || (w.on && w.on.kind !== 'outside')) return false;
  return Date.parse(end.at) < Date.parse(w.since);
}

/** The things all `jobs`' waits watch, each once, with the jobs that watch it. */
export function watchedItems(jobs: WaitingJob[]): Watched[] {
  const out = new Map<string, Watched>();
  for (const j of jobs) {
    for (const ref of watchedOf(j)) {
      const k = watchKey(ref);
      const w = out.get(k) ?? { ref, jobIds: [] };
      w.jobIds.push(j.id);
      out.set(k, w);
    }
  }
  return [...out.values()];
}

/** What ended, or was not found, in a few words: what the woken job is told. */
export const endedNote = (ended: Pick<WatchedEnd, 'url' | 'state'>[]): string =>
  ended.map((e) => (e.state === NOT_FOUND
    ? `${e.url} cannot be read: no such repository or item, or the hopper has no access to it, so the wait never ends on it; check the owner and name you wrote`
    : /\/actions\/runs\//.test(e.url) ? `${e.url} completed (${e.state})` : `${e.url} was ${e.state}`)).join('; ');

/**
 * A wait only its pane can end (issue #1508): on its own command. Lost with its pane, it never ends. An outside event the
 * hopper watches nothing of is no longer the pane's (issue #2338): a person ends it, or the check-in or time the job named.
 */
export function paneCarriesWait(job: WaitingJob): boolean {
  if (job.status !== 'waiting_on' || !job.wait) return false;
  return Boolean(job.wait.ownCommand) || job.wait.on?.kind === 'own_command';
}
