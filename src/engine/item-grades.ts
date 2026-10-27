// Item grades in the grade pass (issue #2845 part 5, design.md "Item grades"): after the jobs' grades, each work item that
// ended done or failed is graded from its jobs' grades when it is due — one of its jobs was graded again, it ended since
// its grade was kept (a new end, or none kept), or the grading part of the settings changed —, and only a grade that
// changed is written, in the pass's transaction. An item that ended long ago and was never graded stays so: the pass reads
// the RECENT items that ended last, and the items of the jobs it grades.
import type { GradeRow, GradeSettings } from '../domain/grades.ts';
import { gradedItemState, itemGradeOf, type ItemGradeRow } from '../domain/item-grades.ts';
import type { UserStore } from '../domain/store.ts';
import type { WorkItem } from '../domain/work-items.ts';

/** The items that ended last, read at each pass. */
const RECENT = 200;

const same = (a: ItemGradeRow, b: ItemGradeRow): boolean =>
  JSON.stringify({ ...a, user: undefined, gradedAt: undefined }) === JSON.stringify({ ...b, user: undefined, gradedAt: undefined });

/** The item grades the pass writes: `changed`, the job grades it writes; `regrade`, the kept item grades of `since` on are due too. */
export function itemGradesDue(store: UserStore, changed: readonly GradeRow[], settings: GradeSettings, now: Date, regrade?: string): ItemGradeRow[] {
  const items = new Map<string, WorkItem>(store.workItems.list({ state: ['done', 'failed'], limit: RECENT }).map((i) => [i.key, i]));
  const keys = new Set<string>();
  for (const r of changed) {
    const key = store.jobs.get(r.jobId)?.source?.key;
    if (key) keys.add(key);
  }
  const recent = new Map(store.grades.listItems({ keys: [...items.keys()] }).map((g) => [g.key, g]));
  for (const i of items.values()) {
    const kept = recent.get(i.key);
    if (!kept || kept.endedAt !== i.stateSince || kept.state !== i.state) keys.add(i.key);
  }
  if (regrade !== undefined) for (const g of store.grades.listItems({ since: regrade })) keys.add(g.key);
  const fresh = new Map(changed.map((r) => [r.jobId, r]));
  const out: ItemGradeRow[] = [];
  for (const key of keys) {
    const item = items.get(key) ?? store.workItems.get(key);
    if (!item || !gradedItemState(item.state)) continue;
    const rows = store.jobs.idsOfItem(key).flatMap((id) => {
      const r = fresh.get(id) ?? store.grades.get(id);
      return r ? [r] : [];
    });
    const g = itemGradeOf({ key, state: item.state, stateSince: item.stateSince }, rows, settings, now);
    const kept = recent.get(key) ?? store.grades.getItem(key);
    if (g && !(kept && same(kept, g))) out.push(g);
  }
  return out;
}
