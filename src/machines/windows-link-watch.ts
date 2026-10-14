// The Windows link watch (issue #712, design.md "Machine resources over time" → "The Windows link"): at each record of
// the resource recorder it is shown every machine. A machine whose client found that Windows does not reach the hopper
// is told once (`machine.windows_link_broken`), and once more when Windows reaches it again
// (`machine.windows_link_restored`), as the memory alert tells low memory. A machine offline or with no result keeps
// what was told. Kept in memory: after a restart a link still broken is told again.
// A second source (the path "The Windows keep-alive loop reports the Windows link"): the keep-alive loop on Windows
// tests the link itself and reports it (`hopper windows-link report`). Told as the machine `windows`; the last report is
// kept in memory and dropped when older than 15 minutes, as a client's result is.
import type { MachineSnapshot, WindowsLink } from '../domain/types.ts';

type Link = { machineId: string; url: string; mode?: string };
export type WindowsLinkEvent =
  | { type: 'machine.windows_link_broken'; machineId: string; data: Link & { status?: number; error?: string } }
  | { type: 'machine.windows_link_restored'; machineId: string; data: Link };

/** The machine id a report of the keep-alive loop on Windows is told as. */
export const WINDOWS_REPORTER = 'windows';
/** A report older than this is dropped. */
const STALE_MS = 15 * 60_000;

export interface WindowsLinkWatch {
  /** Every machine now, at `at` (ISO). */
  observe(machines: readonly MachineSnapshot[], at: string): void;
  /** What the keep-alive loop on Windows found. */
  report(link: WindowsLink): void;
  /** The last report, at `at` (ISO); undefined when there is none or it is older than 15 minutes. */
  reported(at: string): WindowsLink | undefined;
}

export function createWindowsLinkWatch(o: { tell: (e: WindowsLinkEvent) => void }): WindowsLinkWatch {
  /** The machines told broken. */
  const broken = new Set<string>();
  let last: WindowsLink | undefined;
  const see = (machineId: string, l: WindowsLink) => {
    const link: Link = { machineId, url: l.url, ...(l.mode ? { mode: l.mode } : {}) };
    if (!l.ok && !broken.has(machineId)) {
      broken.add(machineId);
      o.tell({ type: 'machine.windows_link_broken', machineId, data: { ...link, ...(l.status !== undefined ? { status: l.status } : {}), ...(l.error ? { error: l.error } : {}) } });
    } else if (l.ok && broken.delete(machineId)) {
      o.tell({ type: 'machine.windows_link_restored', machineId, data: link });
    }
  };
  return {
    observe(machines) {
      for (const m of machines) {
        const l = m.online ? m.resources?.windowsLink : undefined;
        if (l) see(m.id, l);
      }
    },
    report(link) {
      last = link;
      see(WINDOWS_REPORTER, link);
    },
    reported(at) {
      return last && Date.parse(at) - Date.parse(last.at) <= STALE_MS ? last : undefined;
    },
  };
}
