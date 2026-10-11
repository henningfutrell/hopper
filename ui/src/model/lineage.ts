// Issue lineage (issue #729): the links the hopper recorded as jobs filed child issues through it
// (`job.child_issue_filed`), folded into what a job's card shows of its issue — its parent, its children, required or
// follow-up, and how many descendants it has in all. Pure: the store reads the events (store/lineage.ts).
import type { DomainEvent } from './wire.ts';

interface IssueAt { repo: string; number: number }

/** One recorded link: a child issue of a parent issue, and whether the job that filed it marked it required. */
export interface LineageLink { parent: IssueAt; child: IssueAt & { url?: string }; required: boolean }

/** An issue on the card: short (`#N`) in the repository it is shown from, its URL, and whether it is a required child. */
export interface LineageIssue { ref: string; url: string; required: boolean }

/** What a card shows of its issue's lineage: its parent (absent: none recorded), its children, its descendants in all. */
export interface Lineage { parent?: LineageIssue; children: LineageIssue[]; descendants: number }

const keyOf = (i: IssueAt): string => `${i.repo.toLowerCase()}#${i.number}`;
const isIssue = (v: unknown): v is IssueAt =>
  typeof v === 'object' && v !== null && typeof (v as IssueAt).repo === 'string' && typeof (v as IssueAt).number === 'number';

/** The links in `events`, oldest first; the same child filed twice is one link (the first). */
export function lineageLinks(events: readonly DomainEvent[]): LineageLink[] {
  const seen = new Set<string>();
  const out: LineageLink[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const { parent, child, required } = e.data as { parent?: unknown; child?: unknown; required?: unknown };
    if (e.type !== 'job.child_issue_filed' || !isIssue(parent) || !isIssue(child)) continue;
    const key = `${keyOf(parent)}>${keyOf(child)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = (child as { url?: unknown }).url;
    out.push({ parent: { repo: parent.repo, number: parent.number }, child: { repo: child.repo, number: child.number, ...(typeof url === 'string' ? { url } : {}) }, required: required === true });
  }
  return out;
}

const shown = (i: IssueAt, from: string, required: boolean, url?: string): LineageIssue => ({
  ref: i.repo.toLowerCase() === from.toLowerCase() ? `#${i.number}` : `${i.repo}#${i.number}`,
  url: url ?? `https://github.com/${i.repo}/issues/${i.number}`, required,
});

/** The lineage of issue `repo#number`; undefined when it has no recorded parent and no recorded child. */
export function lineageOf(links: readonly LineageLink[], repo: string | undefined, number: number | undefined): Lineage | undefined {
  if (repo === undefined || number === undefined) return undefined;
  const self = keyOf({ repo, number });
  const up = links.find((l) => keyOf(l.child) === self);
  const down = links.filter((l) => keyOf(l.parent) === self);
  if (!up && down.length === 0) return undefined;
  const found = new Set<string>([self]);
  for (let edge = [self]; edge.length > 0;) {
    edge = links.filter((l) => edge.includes(keyOf(l.parent)) && !found.has(keyOf(l.child))).map((l) => keyOf(l.child));
    for (const k of edge) found.add(k);
  }
  return {
    ...(up ? { parent: shown(up.parent, repo, up.required) } : {}),
    children: down.map((l) => shown(l.child, repo, l.required, l.child.url)),
    descendants: found.size - 1,
  };
}
