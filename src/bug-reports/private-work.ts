// A job's report keeps nothing of its private work (issue #2812, design.md "Report a bug"), pure. A job files its report on
// the hopper's public repository, and it worked in repositories that may be private. Before the report is kept and sent,
// its title and body lose what only makes sense inside that work: links off the hopper's repository, the repositories the
// job worked in and their issue and pull request numbers, branch names, file paths that are not the hopper's, commit ids
// that are not the hopper's, run and other long ids, and names from the owner's environment (machines, the host, cloud
// resource names). What was removed is listed, by kind, never by value.
import type { Job } from '../domain/types.ts';
import { REPORT_REPO } from './context.ts';

/** What the hopper knows of a job's private work: from its own record and its GitHub proxy events. */
export interface PrivateWork {
  /** The repositories the job worked in, `owner/name`; the hopper's own is never private work. */
  repos: readonly string[];
  /** Issue and pull request numbers in those repositories. */
  numbers: readonly number[];
  /** Branch names the job pushed or named. */
  branches: readonly string[];
  /** Directories of the job's work on its machine: its work tree. */
  dirs: readonly string[];
  /** Names from the owner's environment: the host name, the job's machines. */
  names: readonly string[];
}

/** What the hopper's own repository holds, so a report about the hopper keeps it. */
export interface HopperOwn {
  /** A path in the hopper's own source tree, relative to its root. */
  isPath(path: string): boolean;
  /** Commit ids in the text that are the hopper's own. */
  commits: ReadonlySet<string>;
}

/** Each kind of thing the scrub removes, as the report's row and the job's answer name it. */
export type RemovedKind = 'link' | 'repository' | 'issue or pull request number' | 'branch name' | 'file path' | 'commit id' | 'long id' | 'environment name';

export interface Scrubbed { text: string; removed: RemovedKind[] }

const HOPPER_URL = new RegExp(`^https?://github\\.com/${REPORT_REPO.replace('/', '\\/')}(?:[/#?]|$)`, 'i');
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+/gi;
const ARN = /\barn:aws[\w-]*:[^\s`'"<>()]+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const REPO_REF = /(?<![\w./-])([A-Za-z0-9][\w.-]*\/[\w.-]+)#(\d+)\b/g;
/** A token with a slash: a path, or `owner/name`. A `:line` or `:line:column` after it goes with it. */
const SLASHED = /(?<![\w./~@-])(?:(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)*|[\w.@-]+(?:\/[\w.@-]+)+)\/?(?::\d+(?::\d+)?)?/g;
/** The hopper's own routes: what a report about the hopper names. */
const HOPPER_ROUTE = /^\/(?:api|ui|job|client|github|tunnel|artifact-content|artifact-link)(?:\/|$)/;
/** Punctuation that ends a sentence, not a link or a path. */
const TRAILING = /[.,;:!?]+$/;
/** `fn` of the match without its trailing punctuation, the punctuation put back. */
const keepTrailing = (fn: (m: string) => string) => (m: string): string => {
  const end = TRAILING.exec(m)?.[0] ?? '';
  return fn(m.slice(0, m.length - end.length)) + end;
};
/** Seven to forty hex digits: a commit id, when it holds a digit and a letter. */
const HEX = /\b[0-9a-f]{7,40}\b/gi;
const LONG_NUMBER = /\b\d{8,}\b/g;

const MASK: Record<RemovedKind, string> = {
  link: '[a link]', repository: '[a repository]', 'issue or pull request number': '[a number]', 'branch name': '[a branch]',
  'file path': '[a file path]', 'commit id': '[a commit id]', 'long id': '[an id]', 'environment name': '[a name]',
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** A whole word (or name) as a pattern: not inside a longer name. */
const wordOf = (s: string, flags = 'g'): RegExp => new RegExp(`(?<![\\w.\\/-])${escape(s)}(?![\\w\\/-]|\\.\\w)`, flags);

/** `text` with the job's private work removed, and the kinds removed, in the order first met. */
export function scrubPrivateWork(text: string, work: PrivateWork, own: HopperOwn): Scrubbed {
  const removed = new Set<RemovedKind>();
  const isHopper = (repo: string): boolean => repo.toLowerCase() === REPORT_REPO;
  const repos = work.repos.filter((r) => !isHopper(r));
  const owners = new Set(repos.map((r) => r.split('/')[0]!.toLowerCase()));
  const mask = (kind: RemovedKind): string => {
    removed.add(kind);
    return MASK[kind];
  };
  let t = text.replace(URL_RE, keepTrailing((u) => (HOPPER_URL.test(u) ? u : mask('link'))));
  t = t.replace(ARN, () => mask('environment name'));
  for (const dir of [...work.dirs].filter((d) => d.length > 1).sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`${escape(dir.replace(/\/+$/, ''))}(?:\\/[\\w.@-]+)*\\/?`, 'g'), () => mask('file path'));
  }
  t = t.replace(REPO_REF, (m, repo: string) => (isHopper(repo) ? m : mask('repository')));
  for (const repo of [...repos].sort((a, b) => b.length - a.length)) t = t.replace(wordOf(repo, 'gi'), () => mask('repository'));
  for (const branch of [...work.branches].map((b) => b.replace(/^refs\/heads\//, '')).filter((b) => b.length > 2).sort((a, b) => b.length - a.length)) {
    t = t.replace(wordOf(branch), () => mask('branch name'));
  }
  t = t.replace(SLASHED, keepTrailing((m) => {
    const bare = m.replace(/:\d+(?::\d+)?$/, '').replace(/^\.\//, '').replace(/\/$/, '');
    if (isHopper(bare) || own.isPath(bare) || HOPPER_ROUTE.test(bare)) return m;
    const segments = bare.split('/');
    const looksLikePath = /^[~./]/.test(m) || segments.length > 2 || /[.\d_]/.test(segments.at(-1)!);
    if (looksLikePath) return mask('file path');
    return owners.has(segments[0]!.toLowerCase()) ? mask('repository') : m;
  }));
  // A repository's own name, alone, is the private work too.
  for (const name of new Set(repos.map((r) => r.split('/')[1]!).filter((n) => n.length > 2 && n.toLowerCase() !== 'hopper'))) {
    t = t.replace(wordOf(name, 'gi'), () => mask('repository'));
  }
  for (const n of new Set(work.numbers)) t = t.replace(new RegExp(`(?<![\\w&])#${n}\\b`, 'g'), () => mask('issue or pull request number'));
  t = t.replace(UUID, () => mask('long id'));
  t = t.replace(HEX, (h) => (/\d/.test(h) && /[a-f]/i.test(h) && !own.commits.has(h.toLowerCase()) ? mask('commit id') : h));
  t = t.replace(LONG_NUMBER, () => mask('long id'));
  for (const name of [...new Set(work.names)].filter((n) => n.length > 2).sort((a, b) => b.length - a.length)) {
    t = t.replace(wordOf(name, 'gi'), () => mask('environment name'));
  }
  return { text: t, removed: [...removed] };
}

/** The candidates for a commit id in `text`, lower case: what the caller asks the hopper's own repository about. */
export const commitCandidates = (text: string): string[] =>
  [...new Set([...text.matchAll(HEX)].map((m) => m[0].toLowerCase()).filter((h) => /\d/.test(h) && /[a-f]/.test(h)))];

/** What a job's proxy events say of its work: the repositories, numbers and branches it named. */
export function privateWorkOfEvents(events: readonly { type: string; data: unknown }[]): Pick<PrivateWork, 'repos' | 'numbers' | 'branches'> {
  const repos = new Set<string>();
  const numbers = new Set<number>();
  const branches = new Set<string>();
  for (const e of events) {
    if (!e.type.startsWith('github_proxy.')) continue;
    const d = (e.data ?? {}) as { repo?: unknown; number?: unknown; refs?: unknown; fork?: unknown };
    if (typeof d.repo !== 'string' || d.repo.toLowerCase() === REPORT_REPO) continue;
    repos.add(d.repo);
    if (typeof d.fork === 'string') repos.add(d.fork);
    if (typeof d.number === 'number') numbers.add(d.number);
    if (Array.isArray(d.refs)) for (const r of d.refs) if (typeof r === 'string') branches.add(r.replace(/^refs\/heads\//, ''));
  }
  return { repos: [...repos], numbers: [...numbers], branches: [...branches] };
}

/** A job's private work: its item's repository and number, its work tree, its machines, and what its proxy events name. */
export function privateWorkOf(job: Job, events: readonly { type: string; data: unknown }[], hostname: string): PrivateWork {
  const fromEvents = privateWorkOfEvents(events);
  const own = job.source?.repo && job.source.repo.toLowerCase() !== REPORT_REPO;
  const cwd = job.spec.payload['cwd'];
  return {
    repos: [...new Set([...(own ? [job.source!.repo!] : []), ...fromEvents.repos])],
    numbers: [...new Set([...(own && job.source!.number !== undefined ? [job.source!.number] : []), ...fromEvents.numbers])],
    branches: fromEvents.branches,
    dirs: [job.workTree, typeof cwd === 'string' ? cwd : undefined].filter((d): d is string => !!d),
    names: [hostname, job.spec.machineId, job.resumeOn, job.linkLost?.machine, job.laneId?.replace(/\/lane-\d+$/, '')].filter((n): n is string => !!n),
  };
}
