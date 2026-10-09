// The priority lanes in the store (issue #535): GET /api/priority-lanes — read at load, by the Machines view, and again
// when the lanes or their settings change — and the admin's settings (POST /ui/api/priority-lanes/settings).
import { toast } from 'sonner';
import { get, post, SessionRejected } from '@/lib/api';
import type { PriorityLaneSettings, PriorityLanesView } from '@/model/wire';
import { refreshLiveSoon, useHopper } from './index';

export async function refreshPriorityLanes(): Promise<void> {
  useHopper.setState({ priorityLanes: await get<PriorityLanesView>('/api/priority-lanes') });
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Debounced: a burst of events costs one read. */
export function refreshPriorityLanesSoon(): void {
  clearTimeout(soon);
  soon = setTimeout(() => { refreshPriorityLanes().catch(() => {}); }, 150);
}

/** Any setting; `manual: null` goes back to reliability. Failures toast; a rejected session drops to the landing page. Resolves true on success. */
export async function savePriorityLaneSettings(body: Partial<Omit<PriorityLaneSettings, 'manual'>> & { manual?: string[] | null }, done = 'Priority lanes saved'): Promise<boolean> {
  try {
    useHopper.setState({ priorityLanes: await post<PriorityLanesView>('/ui/api/priority-lanes/settings', body) });
    toast.success(done);
    refreshLiveSoon();
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error((e as Error).message);
    return false;
  }
}
