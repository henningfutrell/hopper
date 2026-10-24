// Preemption in the UI (issue #1525), pure: the summary of the setting, the change a save sends, and the line a job
// shows while it waits after a job of higher priority took its lane, or after its machine's memory paused it (issue #2737).
import type { Job, PreemptionSettings } from './wire.ts';

/** The longest minimum run time, a day in minutes, as the daemon allows it. */
const MAX_MINUTES = 24 * 60;

export interface PreemptionDraft { enabled: boolean; minRunMinutes: string }
export type PreemptionPatch = Partial<PreemptionSettings>;

/** What is on now, in one sentence. */
export function preemptionSummary(s: PreemptionSettings): string {
  if (!s.enabled) return 'Off: no job takes the lane of a running job.';
  const after = s.minRunMinutes === 0 ? 'at once' : `that has run for ${Math.round(s.minRunMinutes * 10) / 10} min`;
  return `On: a job of higher priority takes the lane of a job of lower priority ${after}.`;
}

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function preemptionPatch(s: PreemptionSettings, d: PreemptionDraft): { ok: true; patch: PreemptionPatch | undefined } | { ok: false; error: string } {
  const text = d.minRunMinutes.trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n) || n < 0 || n > MAX_MINUTES) return { ok: false, error: `Minimum run time: a number from 0 to ${MAX_MINUTES}` };
  const patch: PreemptionPatch = { ...(d.enabled === s.enabled ? {} : { enabled: d.enabled }), ...(n === s.minRunMinutes ? {} : { minRunMinutes: n }) };
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}

/** The job that took the lane, as people read it: its issue number and title, else its goal, else its id. */
function labelOf(by: Job | undefined, id: string): string {
  const title = by?.source?.title || by?.spec.goal;
  if (by?.source?.number !== undefined) return title ? `#${by.source.number} ${title}` : `#${by.source.number}`;
  return title || `job ${id}`;
}

/** What a queued or parked job preempted shows: which job took its lane, and that it resumes. Undefined for any other. */
export function preemptedLine(job: Pick<Job, 'status' | 'preempted'>, by: Job | undefined): string | undefined {
  const p = job.preempted;
  if (!p || !['queued', 'held', 'parked'].includes(job.status)) return undefined;
  return `Preempted by ${labelOf(by, p.by)} (priority ${p.byPriority}; this job ${p.priority}). It resumes from where it stopped when a lane is free.`;
}

const gib = (bytes: number): string => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GiB`;

/** What a queued or parked job paused for memory shows (issue #2737): why, its priority, and that it resumes. Undefined for any other. */
export function memoryPausedLine(job: Pick<Job, 'status' | 'memoryPaused'>): string | undefined {
  const p = job.memoryPaused;
  if (!p || !['queued', 'held', 'parked'].includes(job.status)) return undefined;
  const why = p.why ?? `${p.machineId} had ${gib(p.availableBytes)} available, its floor ${gib(p.floorBytes)}`;
  const priority = p.priority !== undefined ? ` This job had the lowest priority there (${p.priority}).` : '';
  return `Paused for memory: ${why}.${priority} It resumes from where it stopped when the memory holds it.`;
}
