// The routing rules as the plugin host holds them (design.md "Routing rules (issue #18)"): plugins.yaml
// `routing:` (re-read with the file, the last good list kept on an invalid file), what a rule may
// name, the report for GET /api/routing, and the UI's edit.
import type { ConfigDocuments } from '../domain/ports.ts';
import { PLUGINS } from './plugins-file.ts';
import type { RoutingEdit, RoutingEditOutcome, RoutingReport, RoutingRule } from '../domain/types.ts';
import { ruleProblem, skippedRules, type RoutingTargets } from '../routing/index.ts';
import { applyRoutingEdit } from './edit.ts';

const unique = (xs: string[]): string[] => [...new Set(xs)];

export interface RoutingConfigDeps {
  documents: ConfigDocuments;
  /** The rules plugins.yaml names now (none when absent). */
  rules(): RoutingRule[];
  /** What runs now: the machine ids and executor instances intake checks a rule against. */
  running(): RoutingTargets;
  /** What plugins.yaml configures now (it may differ from what runs until a restart). */
  configured(): RoutingTargets;
  version(): string;
  error(): string | undefined;
  /** Re-read plugins.yaml; resolves once the new rules are in place. */
  reload(): Promise<void>;
}

export function createRoutingConfig(d: RoutingConfigDeps) {
  /** A save may name what runs or what plugins.yaml configures. */
  const targets = (): RoutingTargets => {
    const r = d.running();
    const c = d.configured();
    return { machines: unique([...r.machines, ...c.machines]), executors: unique([...r.executors, ...c.executors]) };
  };
  const report = (): RoutingReport => {
    const t = targets();
    const error = d.error();
    return {
      document: PLUGINS, version: d.version(), rules: d.rules(), ...(error ? { error } : {}),
      targets: { machines: [...t.machines], executors: [...t.executors] },
      skipped: skippedRules(d.rules(), d.running()),
    };
  };
  return {
    report,
    async edit(e: RoutingEdit): Promise<RoutingEditOutcome> {
      const known = targets();
      const r = applyRoutingEdit(e, d.documents, (rules) => {
        for (const rule of rules) {
          const why = ruleProblem(rule, known);
          if (why) return `rule ${rule.name}: ${why}`;
        }
        return undefined;
      });
      if (!r.ok) return { ok: false, code: r.code === 'not_found' ? 'invalid' : r.code, error: r.error };
      await d.reload();
      return { ok: true, report: report() };
    },
  };
}
