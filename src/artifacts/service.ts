// One user's artifacts (issue #624, design.md "Artifacts"): a job puts a file, the hopper keeps it with its job, issue,
// type, size and hash, under the user's limits; it masks GitHub tokens in a text artifact first (issue #597). Its
// owner shares it with another user or by an expiring public link, revokes a share, removes it; the retention sweep
// removes what is older than the user keeps. An HTML artifact that shows nothing, or one with no summary, is kept with a
// warning (issue #675). Every change is a revision (issue #675): a put to an artifact, or a restore of an old revision,
// makes a new latest one and keeps the rest; the sweep removes older revisions past the retention unless pinned. Every
// change is an event of the user's, in the same transaction; the HTTP edge puts the job's on its job stream. Never throws for a person's or a job's mistake: it answers a no with why.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ARTIFACT_NOTE_MAX, ARTIFACT_TITLE_MAX, artifactName, artifactSummary, artifactType, kindOf, NO_SUMMARY_WARNING, shareLive, TEXT_KINDS, visualWarning,
  type Artifact, type ArtifactRevision, type ArtifactSettings, type ArtifactShare,
} from '../domain/artifacts.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';

/** How often the retention sweep runs. */
export const ARTIFACT_SWEEP_MS = 60 * 60 * 1000;

export type Refusal = { no: string; status: 400 | 403 | 404 | 413 };
export const isRefusal = (r: unknown): r is Refusal => typeof r === 'object' && r !== null && 'no' in r;

/**
 * A put: a new artifact, or, with `to`, a new revision of that one (issue #675). `summary`: one line that says what it
 * shows; `note`: what a revision changed.
 */
export interface PutRequest { name: string; title?: string; summary?: string; type?: string; to?: string; note?: string; content: Buffer }

/** A revision's note as kept: one line, at most ARTIFACT_NOTE_MAX characters, secrets masked; undefined: none. */
const artifactNote = (text: string | undefined): string | undefined => {
  const line = maskGitHubTokens((text ?? '').replace(/\s+/g, ' ').trim()).slice(0, ARTIFACT_NOTE_MAX);
  return line === '' ? undefined : line;
};
/** What a put keeps; `warning`: kept, but not what an artifact is for (issue #675). */
export type PutDone = Artifact & { warning?: string };
/** A new share: with a user of the hopper, or a public link for `hours`. */
export type ShareRequest = { user: { id: string; name: string } } | { link: true; hours?: number };
/**
 * A share made: a public link's token is said once, when it is made, and only its hash is kept. `owner`: the share was
 * with the artifact's owner, who sees it already — nothing is made (issue #673).
 */
export type ShareMade = { share: ArtifactShare; token?: string } | { owner: true };

export interface UserArtifacts {
  put(job: Job, r: PutRequest): PutDone | Refusal;
  get(id: string): Artifact | undefined;
  content(id: string): Buffer | undefined;
  /** Every revision, newest first (issue #675). */
  revisions(id: string): ArtifactRevision[];
  revision(id: string, n: number): ArtifactRevision | undefined;
  revisionContent(id: string, n: number): Buffer | undefined;
  /** Makes revision `n` the latest, as a new revision: nothing is overwritten. */
  restore(id: string, n: number, by: string): Artifact | Refusal;
  /** Pins revision `n` (the sweep keeps it), or unpins it. */
  pin(id: string, n: number, pinned: boolean, by: string): ArtifactRevision | Refusal;
  list(o?: { jobId?: string; limit?: number }): Artifact[];
  share(id: string, r: ShareRequest, by: string): ShareMade | Refusal;
  revoke(id: string, shareId: string, by: string): ArtifactShare | Refusal;
  /** Its link was posted for its owner on the job's issue (`comment`), or could not be (`error`) (issue #673). */
  posted(id: string, by: string, r: { comment: string } | { error: string } | { noIssue: true }): void;
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
  /** Whether `bytes` more fit: one artifact's limit, and all of the user's revisions together (issue #675). */
  const overLimits = (name: string, bytes: number): Refusal | undefined => {
    const s = repo.settings();
    if (bytes > s.maxBytes) return { no: `${name} is ${inWords(bytes)}; one artifact may be at most ${inWords(s.maxBytes)} (Settings → Artifacts)`, status: 413 };
    const used = repo.usedBytes();
    if (used + bytes > s.userBytes) {
      return { no: `${name} is ${inWords(bytes)}, and this user's artifacts hold ${inWords(used)} of ${inWords(s.userBytes)} (Settings → Artifacts): remove some first`, status: 413 };
    }
    return undefined;
  };

  const a: UserArtifacts = {
    put(job, r) {
      const name = artifactName(r.name);
      const type = artifactType(name, r.type);
      if (type === undefined) return { no: `the hopper does not know the type ${r.type}: give html, svg, png, jpeg, gif, webp, pdf, csv, markdown, json, text or file, or leave it out`, status: 400 };
      if (r.content.length === 0) return { no: `${name} is empty: there is nothing to keep`, status: 400 };
      const before = r.to === undefined ? undefined : repo.get(r.to);
      if (r.to !== undefined && !before) return missing(r.to);
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
      const full = overLimits(name, content.length);
      if (full) return full;
      const title = maskGitHubTokens((r.title ?? '').trim()).slice(0, ARTIFACT_TITLE_MAX) || before?.title || name;
      const summary = artifactSummary(r.summary === undefined ? undefined : maskGitHubTokens(r.summary)) ?? before?.summary;
      const note = artifactNote(r.note);
      const warning = [visualWarning(kind, content), summary === undefined ? NO_SUMMARY_WARNING : undefined].filter((w) => w !== undefined).join('; ') || undefined;
      const by = `job ${job.id}`;
      const sha256 = createHash('sha256').update(content).digest('hex');
      const at = now();
      // A new revision of an artifact (issue #675): the id, its URL and its shares stay; the latest so far is kept.
      if (before) {
        const next: Artifact = {
          ...before, title, name, type, kind, size: content.length, sha256, revision: before.revision + 1, updatedAt: at, revisedBy: by, pinned: false,
          ...(summary !== undefined ? { summary } : {}),
        };
        if (note !== undefined) next.note = note; else delete next.note;
        o.store.tx(() => {
          repo.revise(next, content);
          o.store.events.append({
            type: 'artifact.revised', jobId: job.id,
            data: { artifact: next.id, revision: next.revision, title, name, type, size: next.size, sha256, by, ...(note !== undefined ? { note } : {}), ...(masked > 0 ? { masked } : {}), ...(warning ? { warning } : {}) },
          });
        });
        return warning ? { ...next, warning } : next;
      }
      const src = job.source;
      const issue = src?.url ? { url: src.url, ref: src.repo && src.number !== undefined ? `${src.repo}#${src.number}` : src.url } : undefined;
      const artifact: Artifact = {
        id: newId(), userId: o.userId, jobId: job.id, ...(issue ? { issue } : {}), title, name, type, kind,
        size: content.length, sha256, createdAt: at, ...(summary !== undefined ? { summary } : {}),
        revision: 1, updatedAt: at, revisedBy: by, ...(note !== undefined ? { note } : {}), pinned: false,
      };
      o.store.tx(() => {
        repo.add(artifact, content);
        o.store.events.append({
          type: 'artifact.created', jobId: job.id,
          data: {
            artifact: artifact.id, title, name, type, size: artifact.size, sha256, ...(summary !== undefined ? { summary } : {}), ...(issue ? { issue: issue.url } : {}),
            ...(masked > 0 ? { masked } : {}), ...(warning ? { warning } : {}),
          },
        });
      });
      return warning ? { ...artifact, warning } : artifact;
    },
    revisions: (id) => repo.revisions(id),
    revision: (id, n) => repo.revision(id, n),
    revisionContent: (id, n) => repo.revisionContent(id, n),
    restore(id, n, by) {
      const art = repo.get(id);
      if (!art) return missing(id);
      const old = repo.revision(id, n);
      const content = old ? repo.revisionContent(id, n) : undefined;
      if (!old || !content) return { no: `artifact ${id} has no revision ${n}`, status: 404 };
      const full = overLimits(old.name, content.length);
      if (full) return full;
      const note = `restored revision ${n}`;
      const next: Artifact = {
        ...art, title: old.title, name: old.name, type: old.type, kind: old.kind, size: old.size, sha256: old.sha256,
        revision: art.revision + 1, updatedAt: now(), revisedBy: by, note, pinned: false,
      };
      if (old.summary !== undefined) next.summary = old.summary; else delete next.summary;
      o.store.tx(() => {
        repo.revise(next, content);
        o.store.events.append({
          type: 'artifact.revised', jobId: art.jobId,
          data: { artifact: id, revision: next.revision, title: next.title, name: next.name, type: next.type, size: next.size, sha256: next.sha256, by, note, restoredFrom: n },
        });
      });
      return next;
    },
    pin(id, n, pinned, by) {
      const art = repo.get(id);
      if (!art) return missing(id);
      const rev = repo.revision(id, n);
      if (!rev) return { no: `artifact ${id} has no revision ${n}`, status: 404 };
      if (rev.pinned === pinned) return { ...rev, pinned };
      o.store.tx(() => {
        repo.pinRevision(id, n, pinned);
        o.store.events.append({ type: 'artifact.revision_pinned', jobId: art.jobId, data: { artifact: id, revision: n, pinned, by } });
      });
      return { ...rev, pinned };
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
        // The owner sees it already (issue #673): a share with them changes nothing, and succeeds.
        if (r.user.id === o.userId) return { owner: true };
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
    posted(id, by, r) {
      const art = repo.get(id);
      if (!art) return;
      o.store.events.append({
        type: 'artifact.posted', jobId: art.jobId,
        data: { artifact: id, title: art.title, by, ...('comment' in r ? { comment: r.comment } : 'error' in r ? { error: r.error } : { issue: false }) },
      });
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
      // Older revisions first (issue #675): the latest stays, and so does a pinned one.
      for (const r of repo.oldRevisions(before)) {
        const art = repo.get(r.artifactId);
        if (!art) continue;
        o.store.tx(() => {
          repo.removeRevision(r.artifactId, r.n);
          o.store.events.append({ type: 'artifact.revision_removed', jobId: art.jobId, data: { artifact: r.artifactId, revision: r.n, reason: 'retention' } });
        });
      }
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
