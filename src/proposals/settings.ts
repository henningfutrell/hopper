// The proposal settings (issue #537): the user's, in the database, read at each review so a change applies without a
// restart. The reviewers are escalation levels by instance name: an edit naming anything else is refused, so the UI
// offers only what the server takes.
import type { UserStore } from '../domain/ports.ts';
import { DEFAULT_PROPOSAL_SETTINGS, type ProposalSettings, type ProposalSettingsView } from '../domain/types.ts';

/** The settings in force: the saved ones, else the defaults. */
export const proposalSettings = (store: Pick<UserStore, 'settings'>): ProposalSettings => store.settings.getProposalSettings() ?? DEFAULT_PROPOSAL_SETTINGS;

/** The settings, with the escalation levels there are now to choose from. */
export const proposalSettingsView = (store: Pick<UserStore, 'settings'>, levels: readonly string[]): ProposalSettingsView =>
  ({ ...proposalSettings(store), levels: [...levels] });

export type ProposalSettingsEdit = { ok: true; view: ProposalSettingsView } | { ok: false; error: string };

/** Save the parts `patch` names over the settings in force; a reviewer that is not an escalation level now, or named twice, is refused. */
export function editProposalSettings(store: Pick<UserStore, 'settings'>, levels: readonly string[], patch: Partial<ProposalSettings>): ProposalSettingsEdit {
  const next = { ...proposalSettings(store), ...patch };
  const unknown = next.reviewers.filter((r) => !levels.includes(r));
  if (unknown.length > 0) return { ok: false, error: `not an escalation level: ${unknown.join(', ')} (the escalation levels are ${levels.join(', ') || 'none'})` };
  if (new Set(next.reviewers).size !== next.reviewers.length) return { ok: false, error: 'a reviewer level is named twice' };
  store.settings.setProposalSettings(next);
  return { ok: true, view: proposalSettingsView(store, levels) };
}
