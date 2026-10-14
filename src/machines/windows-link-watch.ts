// The Windows link watch (issue #712, design.md "Machine resources over time" → "The Windows link"): at each record of
// the resource recorder it is shown every machine. A machine whose client found that Windows does not reach the hopper
// is told once (`machine.windows_link_broken`), and once more when Windows reaches it again
// (`machine.windows_link_restored`), as the memory alert tells low memory. A machine offline or with no result keeps
// what was told. Kept in memory: after a restart a link still broken is told again.
import type { MachineSnapshot } from '../domain/types.ts';

type Link = { machineId: string; url: string; mode?: string };
export type WindowsLinkEvent =
  | { type: 'machine.windows_link_broken'; machineId: string; data: Link & { status?: number; error?: string } }
  | { type: 'machine.windows_link_restored'; machineId: string; data: Link };

export interface WindowsLinkWatch {
  /** Every machine now, at `at` (ISO). */
  observe(machines: readonly MachineSnapshot[], at: string): void;
}

export function createWindowsLinkWatch(o: { tell: (e: WindowsLinkEvent) => void }): WindowsLinkWatch {
  /** The machines told broken. */
  const broken = new Set<string>();
  return {
    observe(machines) {
      for (const m of machines) {
        const l = m.online ? m.resources?.windowsLink : undefined;
        if (!l) continue;
        const link: Link = { machineId: m.id, url: l.url, ...(l.mode ? { mode: l.mode } : {}) };
        if (!l.ok && !broken.has(m.id)) {
          broken.add(m.id);
          o.tell({ type: 'machine.windows_link_broken', machineId: m.id, data: { ...link, ...(l.status !== undefined ? { status: l.status } : {}), ...(l.error ? { error: l.error } : {}) } });
        } else if (l.ok && broken.delete(m.id)) {
          o.tell({ type: 'machine.windows_link_restored', machineId: m.id, data: link });
        }
      }
    },
  };
}
