// Proposals in the store (issue #537): GET /api/proposals — the open ones and the history, with the proposal settings
// — read at load, on every (re)connect and after each `proposal.*` event; and an admin's settings (POST
// /ui/api/proposals/settings).
import { toast } from 'sonner';
import { get, post, SessionRejected } from '@/lib/api';
import type { ProposalSettings, ProposalSettingsView, ProposalView } from '@/model/wire';
import { HANDLED_LIMIT, useHopper } from './index';

type Read = { proposals: ProposalView[]; settings: ProposalSettingsView };

/** An answer without its proposals or settings is refused, never read as none. */
export async function refreshProposals(): Promise<void> {
  const [open, all] = await Promise.all([get<Read>('/api/proposals?status=open'), get<Read>(`/api/proposals?status=all&limit=${HANDLED_LIMIT}`)]);
  if (!Array.isArray(open.proposals) || !Array.isArray(all.proposals) || !open.settings) throw new Error('GET /api/proposals: the answer holds no proposals');
  useHopper.setState({ proposals: open.proposals, decidedProposals: all.proposals.filter((p) => p.status !== 'open' && p.status !== 'revising'), proposalSettings: open.settings });
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Debounced: a burst of events costs one read. */
export function refreshProposalsSoon(): void {
  clearTimeout(soon);
  soon = setTimeout(() => { refreshProposals().catch(() => {}); }, 150);
}

/** Failures toast; a rejected session drops to the landing page. */
export async function saveProposalSettings(body: ProposalSettings): Promise<void> {
  try {
    useHopper.setState({ proposalSettings: await post<ProposalSettingsView>('/ui/api/proposals/settings', body) });
    toast.success('Proposal settings saved');
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error((e as Error).message);
  }
}
