// One user's artifacts (issue #624, design.md "Artifacts"): a job puts a file, the hopper keeps it with its job, issue,
// type, size and hash, under the user's limits; it masks GitHub tokens in a text artifact first (issue #597). Its
// owner shares it with another user or by an expiring public link, revokes a share, removes it; the retention sweep
// removes what is older than the user keeps. Every change is an event of the user's, in the same transaction; the
// HTTP edge puts the job's on its job stream. Never throws for a person's or a job's mistake: it answers a no with why.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ARTIFACT_TITLE_MAX, artifactName, artifactType, kindOf, shareLive, TEXT_KINDS,
  type Artifact, type ArtifactSettings, type ArtifactShare,
} from '../domain/artifacts.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';

/** How often the retention sweep runs. */
export const ARTIFACT_SWEEP_MS = 60 * 60 * 1000;

export type Refusal = { no: string; status: 400 | 403 | 404 | 413 };
export const isRefusal = (r: unknown): r is Refusal => typeof r === 'object' && r !== null && 'no' in r;

export interface PutRequest { name: string; title?: string; type?: string; content: Buffer }
/** A new share: with a user of the hopper, or a public link for `hours`. */
export type ShareRequest = { user: { id: string; name: string } } | { link: true; hours?: number };
/** A public link's token is said once, when it is made: only its hash is kept. */
export interface ShareMade { share: ArtifactShare; token?: string }

export interface UserArtifacts {
  put(job: Job, r: PutRequest): Artifact | Refusal;
  get(id: string): Artifact | undefined;
  content(id: string): Buffer | undefined;
  list(o?: { jobId?: string; limit?: number }): Artifact[];
  share(id: string, r: ShareRequest, by: string): ShareMade | Refusal;
  revoke(id: string, shareId: string, by: string): ArtifactShare | Refusal;
  remove(id: string, by: string): Artifact | Refusal;
  /** The share a public link's token names, live or not; undefined: none. */
  shareOfToken(token: string): ArtifactShare | undefined;
  settings(): ArtifactSettings;
  setSettings(s: ArtifactSettings, by: string): ArtifactSettings;
  usedBytes(): number;
  /** The key this user's content URLs are signed under (issue #673): it outlives a restart when the vault can keep it. */
  contentKey(): Buffer;
  /** Removes each artifact older than the retention; the ids removed. */
  sweep(): string[];
  start(): void;
  stop(): void;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const MB = 1024 * 1024;
const inWords = (bytes: number): string => (bytes >= MB ? `${Math.round((bytes / MB) * 10) / 10} MB` : `${bytes} bytes`);

export function createUserArtifacts(o: {
  userId: string; store: UserStore; clock: Clock; logger: { warn(line: string): void }; newId?: () => string; sweepMs?: number;
  contentKey: () => Buffer;
}): UserArtifacts {
  const repo = o.store.artifacts;
  const newId = o.newId ?? (() => randomUUID());
  const now = () => o.clock.now().toISOString();
  let timer: NodeJS.Timeout | undefined;
  const missing = (id: string): Refusal => ({ no: `there is no artifact ${id}`, status: 404 });

  const a: UserArtifacts = {
    put(job, r) {
      const name = artifactName(r.name);
      const type = artifactType(name, r.type);
      if (type === undefined) return { no: `the hopper does not know the type ${r.type}: give html, svg, png, jpeg, gif, webp, pdf, csv, markdown, json, text or file, or leave it out`, status: 400 };
      if (r.content.length === 0) return { no: `${name} is empty: there is nothing to keep`, status: 400 };
      const kind = kindOf(type);
      let content = r.content;
      let masked = 0;
      // A secret in a text artifact is masked before it is kept (issue #597): a person shares what they see.
      if (TEXT_KINDS.includes(kind)) {
        const text = content.toString('utf8');
        const clean = maskGitHubTokens(text);
        if (clean !== text) {
          masked = (clean.match(/\(masked\)/g) ?? []).length - (text.match(/\(masked\)/g) ?? []).length;
          content = Buffer.from(clean, 'utf8');
        }
      }
      const s = repo.settings();
      if (content.length > s.maxBytes) return { no: `${name} is ${inWords(content.length)}; one artifact may be at most ${inWords(s.maxBytes)} (Settings → Artifacts)`, status: 413 };
      const used = repo.usedBytes();
      if (used + content.length > s.userBytes) {
        return { no: `${name} is ${inWords(content.length)}, and this user's artifacts hold ${inWords(used)} of ${inWords(s.userBytes)} (Settings → Artifacts): remove some first`, status: 413 };
      }
      const title = maskGitHubTokens((r.title ?? '').trim()).slice(0, ARTIFACT_TITLE_MAX) || name;
      const src = job.source;
      const issue = src?.url ? { url: src.url, ref: src.repo && src.number !== undefined ? `${src.repo}#${src.number}` : src.url } : undefined;
      const artifact: Artifact = {
        id: newId(), userId: o.userId, jobId: job.id, ...(issue ? { issue } : {}), title, name, type, kind,
        size: content.length, sha256: createHash('sha256').update(content).digest('hex'), createdAt: now(),
      };
      o.store.tx(() => {
        repo.add(artifact, content);
        o.store.events.append({
          type: 'artifact.created', jobId: job.id,
          data: { artifact: artifact.id, title, name, type, size: artifact.size, sha256: artifact.sha256, ...(issue ? { issue: issue.url } : {}), ...(masked > 0 ? { masked } : {}) },
        });
      });
      return artifact;
    },
    get: (id) => repo.get(id),
    content: (id) => repo.content(id),
    list: (q) => repo.list(q),
    share(id, r, by) {
      const art = repo.get(id);
      if (!art) return missing(id);
      const s = repo.settings();
      const at = now();
      if ('user' in r) {
        if (r.user.id === o.userId) return { no: 'the artifact is yours already: share it with another user', status: 400 };
        const already = repo.shares(id, at).find((x) => x.kind === 'user' && x.userId === r.user.id);
        if (already) return { share: already };
        const share: ArtifactShare = { id: newId(), artifactId: id, kind: 'user', userId: r.user.id, userName: r.user.name, createdAt: at, createdBy: by };
        o.store.tx(() => {
          repo.addShare(share);
          o.store.events.append({ type: 'artifact.shared', jobId: art.jobId, data: { artifact: id, share: share.id, with: 'user', user: r.user.name, by } });
        });
        return { share };
      }
      if (!s.publicLinks) return { no: 'public links are turned off for this user: an admin turns them on in Settings → Artifacts', status: 403 };
      const hours = r.hours ?? s.linkHours;
      if (!Number.isFinite(hours) || hours <= 0 || hours > s.linkHoursMax) return { no: `a public link works for 1 to ${s.linkHoursMax} hours, not ${r.hours}`, status: 400 };
      const token = `${o.userId}.${randomBytes(32).toString('base64url')}`;
      const share: ArtifactShare = { id: newId(), artifactId: id, kind: 'link', expiresAt: new Date(o.clock.now().getTime() + hours * 3600_000).toISOString(), createdAt: at, createdBy: by };
      o.store.tx(() => {
        repo.addShare({ ...share, tokenHash: hashToken(token) });
        o.store.events.append({ type: 'artifact.shared', jobId: art.jobId, data: { artifact: id, share: share.id, with: 'link', expiresAt: share.expiresAt!, by } });
      });
      return { share, token };
    },
    revoke(id, shareId, by) {
      const art = repo.get(id);
      if (!art) return missing(id);
      const share = repo.share(shareId);
      if (!share || share.artifactId !== id) return { no: `artifact ${id} has no share ${shareId}`, status: 404 };
      if (share.revokedAt !== undefined) return share;
      const at = now();
      o.store.tx(() => {
        repo.revokeShare(shareId, by, at);
        o.store.events.append({ type: 'artifact.share_revoked', jobId: art.jobId, data: { artifact: id, share: shareId, with: share.kind, by } });
      });
      return { ...share, revokedAt: at, revokedBy: by };
    },
    remove(id, by) {
      const art = repo.get(id);
      if (!art) return missing(id);
      o.store.tx(() => {
        repo.remove(id);
        o.store.events.append({ type: 'artifact.removed', jobId: art.jobId, data: { artifact: id, reason: 'removed', by } });
      });
      return art;
    },
    shareOfToken: (token) => repo.shareByHash(hashToken(token)),
    settings: () => repo.settings(),
    setSettings(s, by) {
      const from = repo.settings();
      if (JSON.stringify(from) === JSON.stringify(s)) return from;
      o.store.tx(() => {
        repo.setSettings(s);
        o.store.events.append({ type: 'artifact.settings_changed', data: { from, to: s, by } });
      });
      return s;
    },
    usedBytes: () => repo.usedBytes(),
    contentKey: () => o.contentKey(),
    sweep() {
      const before = new Date(o.clock.now().getTime() - repo.settings().retentionDays * 86_400_000).toISOString();
      const gone: string[] = [];
      for (const id of repo.olderThan(before)) {
        const art = repo.get(id);
        if (!art) continue;
        o.store.tx(() => {
          repo.remove(id);
          o.store.events.append({ type: 'artifact.removed', jobId: art.jobId, data: { artifact: id, reason: 'retention' } });
        });
        gone.push(id);
      }
      return gone;
    },
    start() {
      const run = () => {
        try { a.sweep(); } catch (e) { o.logger.warn(`hopper: artifacts: the retention sweep failed: ${(e as Error).message}`); }
      };
      run();
      timer ??= setInterval(run, o.sweepMs ?? ARTIFACT_SWEEP_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return a;
}

/** Whether a share lets anybody in now: re-exported for the HTTP edge. */
export { shareLive };
