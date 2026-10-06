// Routing rules (design.md "Routing rules (issue #18)"): the plugins config `routing:` schema and the
// pure matching applied at intake. The first rule that matches a source item, and whose machine
// and executor are configured, routes it; a rule naming one that is not is skipped, never failing
// intake. No I/O.
import { z } from 'zod';
import type { RoutedBy, RoutingItem, RoutingRule, SkippedRule } from '../domain/types.ts';

const text = z.string().trim().min(1);

const match = z.strictObject({
  source: text.optional(), repo: text.optional(), label: text.optional(), author: text.optional(), title: text.optional(),
});

const set = z.strictObject({
  machine: text.optional(),
  executor: text.optional(),
  priority: z.number().int().min(0).max(100).optional(),
}).refine((s) => s.machine !== undefined || s.executor !== undefined || s.priority !== undefined, 'set at least one of machine, executor, priority');

const rule = z.strictObject({ name: text, match: match.default({}), set });

/** the plugins config `routing:`: an ordered list, names unique. Strict: a `lane` anywhere is refused. */
export const ROUTING_RULES = z.array(rule).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.name)) ctx.addIssue({ code: 'custom', message: `rule ${r.name} named twice; a job records the rule by name` });
    seen.add(r.name);
  }
});

const issues = (e: z.ZodError): string => e.issues.map((i) => `${i.path.join('.') || 'routing'}: ${i.message}`).join('; ');

/** Why a routing list is refused, or undefined. */
export function routingRulesProblem(raw: unknown): string | undefined {
  const r = ROUTING_RULES.safeParse(raw);
  return r.success ? undefined : issues(r.error);
}

/** The rules parsed, or the problem. */
export function parseRoutingRules(raw: unknown): { ok: true; rules: RoutingRule[] } | { ok: false; error: string } {
  const r = ROUTING_RULES.safeParse(raw);
  return r.success ? { ok: true, rules: r.data } : { ok: false, error: issues(r.error) };
}

const lower = (s: string) => s.toLowerCase();
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** `*` matches any run of characters (the slash too); everything else literally, any case. */
function glob(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 'i').test(value);
}

/** Whether every field the rule matches on matches the item. */
export function ruleMatches(r: RoutingRule, item: RoutingItem): boolean {
  const m = r.match;
  if (m.source !== undefined && lower(m.source) !== lower(item.source)) return false;
  if (m.repo !== undefined && (item.repo === undefined || !glob(m.repo, item.repo))) return false;
  if (m.label !== undefined && !item.labels.some((l) => lower(l) === lower(m.label!))) return false;
  if (m.author !== undefined && lower(m.author) !== lower(item.author)) return false;
  if (m.title !== undefined && !lower(item.title).includes(lower(m.title))) return false;
  return true;
}

/** What a rule may name: the configured machine ids and executor instances. */
export interface RoutingTargets { machines: readonly string[]; executors: readonly string[] }

/** Why a rule cannot route now (its machine or executor is not configured), or undefined. */
export function ruleProblem(r: RoutingRule, known: RoutingTargets): string | undefined {
  if (r.set.machine !== undefined && !known.machines.includes(r.set.machine)) return `machine ${r.set.machine} is not configured`;
  if (r.set.executor !== undefined && !known.executors.includes(r.set.executor)) return `executor ${r.set.executor} is not configured`;
  return undefined;
}

/** Every rule that cannot route now, with why. */
export function skippedRules(rules: readonly RoutingRule[], known: RoutingTargets): SkippedRule[] {
  return rules.flatMap((r) => {
    const reason = ruleProblem(r, known);
    return reason ? [{ rule: r.name, reason }] : [];
  });
}

/**
 * The first rule that matches the item and can route now. Matching rules that cannot (a machine
 * or executor no longer configured) are skipped, with why, and the next one is tried.
 */
export function routeItem(rules: readonly RoutingRule[], item: RoutingItem, known: RoutingTargets): { routedBy?: RoutedBy; skipped: SkippedRule[] } {
  const skipped: SkippedRule[] = [];
  for (const r of rules) {
    if (!ruleMatches(r, item)) continue;
    const reason = ruleProblem(r, known);
    if (reason) {
      skipped.push({ rule: r.name, reason });
      continue;
    }
    return { routedBy: { rule: r.name, set: { ...r.set } }, skipped };
  }
  return { skipped };
}
