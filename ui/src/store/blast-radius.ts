// Blast radius in the store (issue #542): GET /api/blast-radius — read by the Machines view, and again when a machine
// is discovered or the settings change —, the admin's settings, a discovery now, and letting a job through the gate.
import { toast } from 'sonner';
import { get, post, SessionRejected } from '@/lib/api';
import type { BlastRadiusSettings, BlastRadiusView } from '@/model/wire';
import { refreshLiveSoon, useHopper } from './index';

export async function refreshBlastRadius(): Promise<void> {
  useHopper.setState({ blastRadius: await get<BlastRadiusView>('/api/blast-radius') });
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Debounced: a burst of events costs one read. */
export function refreshBlastRadiusSoon(): void {
  clearTimeout(soon);
  soon = setTimeout(() => { refreshBlastRadius().catch(() => {}); }, 150);
}

async function posting(path: string, body: unknown, done: string): Promise<boolean> {
  try {
    useHopper.setState({ blastRadius: await post<BlastRadiusView>(path, body) });
    toast.success(done);
    refreshLiveSoon();
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error((e as Error).message);
    return false;
  }
}

/** Any setting, each replaced whole; `pass.minPriority: null` lets no job through by priority. */
export type BlastRadiusPatch = Partial<Omit<BlastRadiusSettings, 'pass'>> & { pass?: { labels?: string[]; repos?: string[]; minPriority?: number | null } };

/** Resolves true on success. */
export const saveBlastRadiusSettings = (body: BlastRadiusPatch, done = 'Blast radius saved'): Promise<boolean> =>
  posting('/ui/api/blast-radius/settings', body, done);

/** Discover one machine now, or every online one: answers when it is done. */
export const discoverNow = (machineId?: string): Promise<boolean> =>
  posting('/ui/api/blast-radius/discover', machineId ? { machineId } : {}, machineId ? `${machineId} discovered` : 'Machines discovered');
