// A review section's settings (issues #537, #543): the user's, in the database, read at each review so a change
// applies without a restart. The reviewers are escalation levels by instance name: an edit naming anything else is
// refused, so the UI offers only what the server takes.
import type { UserStore } from '../domain/ports.ts';
import { DEFAULT_REVIEW_SETTINGS, type ReviewKind, type ReviewSettings, type ReviewSettingsView } from '../domain/types.ts';

/** The settings in force: the saved ones, else the defaults. */
export const reviewSettings = (store: Pick<UserStore, 'settings'>, kind: ReviewKind): ReviewSettings => store.settings.getReviewSettings(kind) ?? DEFAULT_REVIEW_SETTINGS;

/** The settings, with the escalation levels there are now to choose from. */
export const reviewSettingsView = (store: Pick<UserStore, 'settings'>, kind: ReviewKind, levels: readonly string[]): ReviewSettingsView =>
  ({ ...reviewSettings(store, kind), levels: [...levels] });

export type ReviewSettingsEdit = { ok: true; view: ReviewSettingsView } | { ok: false; error: string };

/** Save the parts `patch` names over the settings in force; a reviewer that is not an escalation level now, or named twice, is refused. */
export function editReviewSettings(store: Pick<UserStore, 'settings'>, kind: ReviewKind, levels: readonly string[], patch: Partial<ReviewSettings>): ReviewSettingsEdit {
  const next = { ...reviewSettings(store, kind), ...patch };
  const unknown = next.reviewers.filter((r) => !levels.includes(r));
  if (unknown.length > 0) return { ok: false, error: `not an escalation level: ${unknown.join(', ')} (the escalation levels are ${levels.join(', ') || 'none'})` };
  if (new Set(next.reviewers).size !== next.reviewers.length) return { ok: false, error: 'a reviewer level is named twice' };
  store.settings.setReviewSettings(kind, next);
  return { ok: true, view: reviewSettingsView(store, kind, levels) };
}
