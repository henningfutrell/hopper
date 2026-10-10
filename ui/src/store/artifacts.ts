// Artifacts in the store (issue #624): GET /api/artifacts — read when the stream opens, again on every artifact event
// (debounced), and every half hour, since each content URL works for an hour —, and the person's actions on them.
import { toast } from 'sonner';
import { create } from 'zustand';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import type { ArtifactSettings, ArtifactShare, ArtifactsView, ArtifactView } from '@/model/wire';
import { useHopper } from './index';

export const useArtifacts = create<{ view: ArtifactsView | null; error: string | null }>(() => ({ view: null, error: null }));

export async function refreshArtifacts(): Promise<void> {
  try {
    useArtifacts.setState({ view: await get<ArtifactsView>('/api/artifacts'), error: null });
  } catch (e) {
    useArtifacts.setState({ error: (e as Error).message });
  }
}

let soon: ReturnType<typeof setTimeout> | undefined;
/** Debounced: a burst of events costs one read. */
export function refreshArtifactsSoon(): void {
  clearTimeout(soon);
  soon = setTimeout(() => { void refreshArtifacts(); }, 150);
}

/** The content URLs a read signs work for an hour: read again well before. */
export const ARTIFACTS_REREAD_MS = 30 * 60 * 1000;

async function act<T>(path: string, body: unknown, done: string): Promise<T | undefined> {
  try {
    const r = await post<T>(path, body);
    toast.success(done);
    void refreshArtifacts();
    return r;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error(e instanceof RoleRefused ? 'Your role may not do this' : (e as Error).message);
    return undefined;
  }
}

export const shareWithUser = (id: string, user: string) =>
  act<{ artifact: ArtifactView; share: ArtifactShare }>(`/ui/api/artifacts/${id}/share`, { user }, `Shared with ${user}`);
/** The link is said once, in this answer: only its hash is kept. */
export const shareLink = (id: string, hours?: number) =>
  act<{ artifact: ArtifactView; share: ArtifactShare; link: string }>(`/ui/api/artifacts/${id}/share`, { link: true, ...(hours ? { hours } : {}) }, 'Public link made');
export const revokeShare = (id: string, share: string) => act(`/ui/api/artifacts/${id}/shares/${share}/revoke`, {}, 'Share revoked');
export const removeArtifact = (id: string) => act(`/ui/api/artifacts/${id}/remove`, {}, 'Artifact removed');
export const saveArtifactSettings = (patch: Partial<ArtifactSettings>) =>
  act<{ settings: ArtifactSettings }>('/ui/api/artifacts/settings', patch, 'Artifact settings saved');
