// Artifacts in the UI (issue #624), pure: a job's artifacts — its user's own and those shared with the person —, the
// artifacts a text links to by their stable URL (a proposal or a research report embeds them), sizes and shares in
// words, how each kind is previewed, and an artifact's line on the timeline.
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
    // An SVG is served in the HTML sandbox (issue #675): framed, its inline script runs as an HTML page's does.
    case 'html': case 'svg': return 'frame';
    case 'image': return 'image';
    case 'pdf': return 'pdf';
    case 'csv': return 'csv';
    case 'markdown': return 'markdown';
    case 'json': case 'text': return 'text';
    default: return 'none';
  }
}

/** `artifact.created` on the timeline: its title, and its warning when it is not a visual (issue #675). */
export function artifactCreatedDetail(d: Record<string, unknown>): string {
  const title = typeof d.title === 'string' ? d.title : String(d.name);
  return typeof d.warning === 'string' ? `${title}: warning: ${d.warning}` : title;
}

/** The UI's link to an artifact (issue #675): it follows the latest revision, or pins revision `n`. */
export const revisionHash = (id: string, n?: number): string => (n === undefined ? `#artifacts/${id}` : `#artifacts/${id}/${n}`);

/** The revision a hash pins (`#artifacts/<id>/<n>`); undefined: none, the latest. */
export function revisionOfHash(hash: string): number | undefined {
  const n = hash.replace(/^#/, '').split('/')[2];
  return n !== undefined && /^[1-9]\d{0,8}$/.test(n) ? Number(n) : undefined;
}

/** Who made a revision, short: a job by its id's first part, a person by their name. */
export function byInWords(by: string): string {
  if (by.startsWith('job ')) return `job ${by.slice(4, 12)}`;
  return by.replace(/^[a-z]+:/, '');
}

/** `artifact.revised` on the timeline (issue #675): its title, its number, and what changed. */
export function revisedDetail(d: Record<string, unknown>): string {
  const what = typeof d.restoredFrom === 'number' ? `restored revision ${d.restoredFrom}` : typeof d.note === 'string' ? d.note : '';
  return `${String(d.title)}: revision ${String(d.revision)}${what ? `, ${what}` : ''}`;
}
