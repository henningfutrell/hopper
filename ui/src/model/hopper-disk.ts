// The hopper's own disk use on a Machines card, and the disk budget an admin sets there (issue #1120, design.md "Hopper's
// own disk use" → "Part 2"). The budget is in GB in the form and in bytes on the wire. Pure.
import type { DiskBudget, HopperDisk } from '../../../src/domain/types.ts';

const size = (bytes: number): string => (bytes >= 1e9 ? `${bytes >= 1e10 ? Math.round(bytes / 1e9) : (bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

/** The hopper's disk use on a machine, and its budget when there is one. */
export function hopperDiskText(d: HopperDisk): string {
  if (d.budgetBytes === undefined) return `${size(d.bytes)}, no budget`;
  return d.over ? `${size(d.bytes)}: over its ${size(d.budgetBytes)} budget` : `${size(d.bytes)} of its ${size(d.budgetBytes)} budget`;
}

const REFUSED = 'The budget must be a number of GB above 0, or empty for none';

/** What POST /ui/api/machines/disk-budget is sent for the form's GB, or why not. Empty: no budget. */
export function budgetBody(text: string): { budget: DiskBudget | null } | string {
  const t = text.trim();
  if (t === '') return { budget: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return REFUSED;
  return { budget: { bytes: Math.round(n * 1e9) } };
}

/** The form's GB for the budget set; empty when there is none. */
export const budgetDraft = (b: DiskBudget | null): string => (b ? String(b.bytes / 1e9) : '');
