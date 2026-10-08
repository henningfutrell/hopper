// Dismissed notices (issue #83): the Attention items and the update notice this browser dismissed,
// kept per browser like the overview layout (hooks/use-dismissed.ts). A notice key names one
// occurrence, so a new question, failure, error text or update target shows again. A condition seen
// cleared — the router answering, a source syncing, no update notice — is forgotten, so its next
// occurrence shows again too. Pure: reading what a browser stored never throws.
import type { Health, SourceStatus, UpdateStatus } from './wire.ts';
import { showNotice } from './update.ts';

/** Question and failed-job keys never clear on their own: the oldest go past this many. */
export const DISMISSED_CAP = 200;

export const noticeKey = {
  question: (id: string) => `question:${id}`,
  failed: (jobId: string) => `failed:${jobId}`,
  /** A job whose cleanup could not reach its machine (issue #371): its pane may still be open. */
  paneOpen: (jobId: string) => `pane-open:${jobId}`,
  /** A machine's disk running low (issue #401): once per machine, so a dismissal survives the bytes moving. */
  disk: (machineId: string) => `disk:${machineId}`,
  router: (h: Health) => `router:${h.router}`,
  source: (s: SourceStatus) => `source:${s.name}:${s.lastError ?? ''}`,
  update: (s: UpdateStatus) => `update:${s.state}:${s.state === 'error' ? s.reason ?? '' : s.target?.commit ?? s.apply?.target ?? ''}`,
};

/** The keys a browser stored (`null`: nothing stored). */
export function parseDismissed(text: string | null): string[] {
  if (text === null) return [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(-DISMISSED_CAP) : [];
}

export const dismiss = (list: string[], key: string): string[] => [...list.filter((k) => k !== key), key].slice(-DISMISSED_CAP);

export const undismiss = (list: string[], keys: string[]): string[] => list.filter((k) => !keys.includes(k));

/** Forgets the dismissed router, source and update notices whose condition is seen cleared. */
export function forgetCleared(list: string[], seen: { health: Health | null; sources: SourceStatus[]; update: UpdateStatus | null }): string[] {
  const cleared = (k: string) =>
    (k.startsWith('router:') && seen.health !== null && !seen.health.fallback) ||
    (k.startsWith('update:') && seen.update !== null && !showNotice(seen.update)) ||
    seen.sources.some((s) => s.state !== 'error' && k.startsWith(`source:${s.name}:`));
  const next = list.filter((k) => !cleared(k));
  return next.length === list.length ? list : next;
}
