// The Routing view's model (design.md "UI manages everything (issue #18)"): the router and
// queue-sorter pickers, and the routing rules form — drafts as typed, the whole list one Save sends.
import type { Job, PluginsReport, RoutingRule } from '../../../src/domain/types.ts';

export interface Choice {
  id: string;
  describe: string;
  builtin: boolean;
  /** The plugin the plugins config names for the role now. */
  current: boolean;
  /** Only a plugin detected available here can be selected. */
  selectable: boolean;
  status: 'available' | 'unavailable' | 'needs-setup';
  /** Why it cannot run here. */
  why?: string;
  /** What to run to set it up. */
  command?: string;
}

/** Every plugin of a one-instance role, in catalogue order. */
export function choices(report: PluginsReport, role: 'router' | 'queue-sorter'): Choice[] {
  const current = role === 'router' ? report.router.instance.plugin : report.queueSorter.instance.plugin;
  return report.plugins.filter((p) => p.role === role).map((p) => {
    const d = p.detection;
    return {
      id: p.id, describe: p.describe, builtin: p.builtin, current: p.id === current, selectable: d.status === 'available', status: d.status,
      ...(d.status === 'available' ? {} : { why: d.reason }),
      ...(d.status === 'needs-setup' ? { command: d.command } : {}),
    };
  });
}

/** One rule as the form holds it: every field a string. */
export interface RuleDraft {
  name: string;
  match: { source: string; repo: string; label: string; author: string; title: string };
  set: { machine: string; executor: string; priority: string; workTree: string };
}

export const MATCH_FIELDS = ['source', 'repo', 'label', 'author', 'title'] as const;

export function toDraft(r: RoutingRule): RuleDraft {
  const m = r.match;
  return {
    name: r.name,
    match: { source: m.source ?? '', repo: m.repo ?? '', label: m.label ?? '', author: m.author ?? '', title: m.title ?? '' },
    set: {
      machine: r.set.machine ?? '', executor: r.set.executor ?? '', priority: r.set.priority === undefined ? '' : String(r.set.priority), workTree: r.set.workTree ?? '',
    },
  };
}

const given = <K extends string>(o: Record<K, string>): Partial<Record<K, string>> =>
  Object.fromEntries(Object.entries<string>(o).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== '')) as Partial<Record<K, string>>;

/** What Save sends for one rule: empty fields left out. */
export function fromDraft(d: RuleDraft): RoutingRule {
  const { priority, ...targets } = d.set;
  return {
    name: d.name.trim(),
    match: given(d.match),
    set: { ...given(targets), ...(priority.trim() === '' ? {} : { priority: Number(priority) }) },
  };
}

/** A new rule at the end, under the next free `rule N` name. */
export function blankRule(names: readonly string[]): RuleDraft {
  let n = 1;
  while (names.includes(`rule ${n}`)) n += 1;
  return toDraft({ name: `rule ${n}`, match: {}, set: {} });
}

/** What the daemon would refuse in the list, said before sending; undefined when it is fine. */
export function draftsProblem(drafts: readonly RuleDraft[]): string | undefined {
  const seen = new Set<string>();
  for (const [i, d] of drafts.entries()) {
    const name = d.name.trim();
    const label = name || `rule ${i + 1}`;
    if (!name) return `${label}: name it`;
    if (seen.has(name)) return `${label}: named twice`;
    seen.add(name);
    const { machine, executor, priority, workTree } = d.set;
    if (!machine.trim() && !executor.trim() && !priority.trim() && !workTree.trim()) return `${label}: set a machine, an executor, a priority or a work tree`;
    const tree = workTree.trim();
    if (tree !== '' && !(tree.startsWith('/') || tree === '~' || tree.startsWith('~/'))) return `${label}: the work tree is an absolute path or starts with ~`;
    if (priority.trim() !== '') {
      const p = Number(priority);
      if (!Number.isInteger(p) || p < 0 || p > 100) return `${label}: priority is a whole number 0..100`;
    }
  }
  return undefined;
}

/** The list with item `i` moved one place up (-1) or down (1); unchanged past either end. */
export function move<T>(list: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Machine ids for the machine select: what /api/machines reports, then what a rule may name. */
export function machineOptions(machines: readonly { id: string }[], targets: readonly string[]): string[] {
  return [...new Set([...machines.map((m) => m.id), ...targets])];
}

/** How a job shows the rule that routed it, or null. */
export function routedByLabel(job: Job): string | null {
  const r = job.spec.routedBy;
  if (!r) return null;
  const parts = [
    ...(r.set.machine !== undefined ? [`machine ${r.set.machine}`] : []),
    ...(r.set.executor !== undefined ? [`executor ${r.set.executor}`] : []),
    ...(r.set.priority !== undefined ? [`priority ${r.set.priority}`] : []),
    ...(r.set.workTree !== undefined ? [`work tree ${r.set.workTree}`] : []),
  ];
  return `routed by ${r.rule}: ${parts.join(', ')}`;
}
