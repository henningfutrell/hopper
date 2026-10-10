// Artifacts in the UI (issue #624), pure: a job's artifacts — its user's own and those shared with the person —, the
// artifacts a text links to by their stable URL (a proposal or a research report embeds them), sizes and shares in
// words, and how each kind is previewed.
import type { ArtifactKind, ArtifactShare, ArtifactsView, ArtifactView } from './wire.ts';

/** An artifact's stable URL ends `#artifacts/<id>`: a text that names one links to it. */
const LINKED = /#artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** What a sandboxed frame lets an HTML artifact do: run its scripts and open links, never take the hopper's origin; a popup stays in the sandbox (issue #673). */
export const FRAME_SANDBOX = 'allow-scripts allow-popups allow-downloads';

export function artifactsOfJob(view: ArtifactsView | null, jobId: string): ArtifactView[] {
  if (!view) return [];
  return [...view.artifacts, ...view.shared].filter((a) => a.jobId === jobId);
}

export function findArtifact(view: ArtifactsView | null, id: string): ArtifactView | undefined {
  return view ? [...view.artifacts, ...view.shared].find((a) => a.id === id) : undefined;
}

/** The ids of the artifacts a text links to, each once, in the order they first appear. */
export function referencedArtifacts(text: string): string[] {
  return [...new Set([...text.matchAll(LINKED)].map((m) => m[1]!))];
}

export function bytesInWords(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round((n / 1024) * 10) / 10} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

/** Who a share lets see it, and whether it still does. */
export function shareInWords(s: ArtifactShare, now: number): string {
  const who = s.kind === 'user' ? (s.userName ?? s.userId ?? 'a user') : 'public link';
  if (s.revokedAt) return `${who}, revoked`;
  if (s.expiresAt) {
    const left = Date.parse(s.expiresAt) - now;
    return left <= 0 ? `${who}, expired` : `${who}, ${Math.max(1, Math.round(left / 3_600_000))} h left`;
  }
  return who;
}

export const liveShare = (s: ArtifactShare, now: number): boolean => !s.revokedAt && (!s.expiresAt || Date.parse(s.expiresAt) > now);

export type Preview = 'frame' | 'image' | 'pdf' | 'csv' | 'markdown' | 'text' | 'none';

export function previewOf(kind: ArtifactKind): Preview {
  switch (kind) {
    case 'html': return 'frame';
    case 'svg': case 'image': return 'image';
    case 'pdf': return 'pdf';
    case 'csv': return 'csv';
    case 'markdown': return 'markdown';
    case 'json': case 'text': return 'text';
    default: return 'none';
  }
}
