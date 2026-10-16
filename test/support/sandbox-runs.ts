// The sandbox runs ledger in memory (issue #1349), as the instance's `sandbox_runs` table keeps it.
import type { SandboxRun, SandboxRunRepository } from '../../src/domain/sandbox-runs.ts';

export function memorySandboxRuns(): SandboxRunRepository & { all(): SandboxRun[] } {
  const rows = new Map<string, SandboxRun>();
  const byStart = (a: SandboxRun, b: SandboxRun): number => a.startedAt.localeCompare(b.startedAt);
  return {
    start(run) { if (!rows.has(run.id)) rows.set(run.id, { ...run }); },
    end(id, e) {
      const r = rows.get(id);
      if (!r || r.endedAt !== undefined) return;
      rows.set(id, { ...r, endedAt: e.at, outcome: e.outcome, ...(e.exit !== undefined ? { exit: e.exit } : {}), ...(e.problem ? { problem: e.problem } : {}) });
    },
    destroyed(id, at, o) {
      const r = rows.get(id);
      if (r && r.destroyedAt === undefined) rows.set(id, { ...r, destroyedAt: at, ...(o?.machineRemoved ? { machineRemoved: true as const } : {}) });
    },
    get: (id) => rows.get(id),
    open: () => [...rows.values()].filter((r) => r.destroyedAt === undefined).sort(byStart),
    latest: (userId, limit) => [...rows.values()].filter((r) => r.userId === userId).sort(byStart).reverse().slice(0, limit),
    all: () => [...rows.values()],
  };
}
