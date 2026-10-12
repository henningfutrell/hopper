// An artifact's revisions that are not a job's put (issue #687, design.md "Artifacts"): its owner revises it with a file
// or with another artifact's latest content, and merges other artifacts into it — each source's revisions added oldest
// first, then the source removed, all in one transaction. The new latest revision of any change, and its event. Never
// throws for a person's mistake: it answers a no with why.
import { createHash } from 'node:crypto';
import { ARTIFACT_NOTE_MAX, artifactName, artifactType, kindOf, TEXT_KINDS, type Artifact, type ArtifactKind } from '../domain/artifacts.ts';
import type { UserStore } from '../domain/ports.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';
import type { Refusal } from './service.ts';

/** An owner's revise (issue #687): a file, or the latest content of another artifact of the user's (`from`). */
export type ReviseRequest = ({ file: { name: string; type?: string; content: Buffer } } | { from: string }) & { note?: string };
/** A merge done: the target as it is now, and the sources merged into it, each removed. */
export type MergeDone = { artifact: Artifact; merged: string[] };

/** A revision's note as kept: one line, at most ARTIFACT_NOTE_MAX characters, secrets masked; undefined: none. */
export const artifactNote = (text: string | undefined): string | undefined => {
  const line = maskGitHubTokens((text ?? '').replace(/\s+/g, ' ').trim()).slice(0, ARTIFACT_NOTE_MAX);
  return line === '' ? undefined : line;
};

const MB = 1024 * 1024;
const inWords = (bytes: number): string => (bytes >= MB ? `${Math.round((bytes / MB) * 10) / 10} MB` : `${bytes} bytes`);

export function createReviser(o: {
  store: UserStore; now: () => string; missing: (id: string) => Refusal; overLimits: (name: string, bytes: number) => Refusal | undefined;
}) {
  const repo = o.store.artifacts;
  const { now, missing, overLimits } = o;
  /** Whether `bytes` more fit the user's quota, beside what is kept already: one artifact's limit is not asked. */
  const overQuota = (what: string, bytes: number): Refusal | undefined => {
    const s = repo.settings();
    const used = repo.usedBytes();
    return used + bytes > s.userBytes
      ? { no: `${what} is ${inWords(bytes)}, and this user's artifacts hold ${inWords(used)} of ${inWords(s.userBytes)} (Settings → Artifacts): remove some first`, status: 413 }
      : undefined;
  };
  /** A text artifact's content with its secrets masked (issue #597): a person shares what they see. `masked`: how many. */
  const masking = (kind: ArtifactKind, content: Buffer): { content: Buffer; masked: number } => {
    if (!TEXT_KINDS.includes(kind)) return { content, masked: 0 };
    const text = content.toString('utf8');
    const clean = maskGitHubTokens(text);
    if (clean === text) return { content, masked: 0 };
    return { content: Buffer.from(clean, 'utf8'), masked: (clean.match(/\(masked\)/g) ?? []).length - (text.match(/\(masked\)/g) ?? []).length };
  };
  /** A new latest revision of `before` and its event, in the caller's transaction. */
  const revised = (before: Artifact, x: {
    title: string; summary?: string | undefined; name: string; type: string; content: Buffer; by: string; note?: string | undefined; event?: Record<string, unknown>; jobId?: string;
  }): Artifact => {
    const kind = kindOf(x.type);
    const sha256 = createHash('sha256').update(x.content).digest('hex');
    const next: Artifact = {
      ...before, title: x.title, name: x.name, type: x.type, kind, size: x.content.length, sha256, revision: before.revision + 1, updatedAt: now(), revisedBy: x.by, pinned: false,
    };
    if (x.summary !== undefined) next.summary = x.summary;
    if (x.note !== undefined) next.note = x.note; else delete next.note;
    repo.revise(next, x.content);
    o.store.events.append({
      type: 'artifact.revised', jobId: x.jobId ?? before.jobId,
      data: { artifact: next.id, revision: next.revision, title: next.title, name: next.name, type: next.type, size: next.size, sha256, by: x.by, ...(x.note !== undefined ? { note: x.note } : {}), ...x.event },
    });
    return next;
  };

  return {
    masking,
    revised,
    revise(id: string, r: ReviseRequest, by: string): Artifact | Refusal {
      const before = repo.get(id);
      if (!before) return missing(id);
      const note = artifactNote(r.note);
      if ('from' in r) {
        if (r.from === id) return { no: `artifact ${id} is the one revised: name another artifact to copy from`, status: 400 };
        const src = repo.get(r.from);
        const content = src ? repo.content(src.id) : undefined;
        if (!src || !content) return missing(r.from);
        const full = overLimits(src.name, content.length);
        if (full) return full;
        return o.store.tx(() => revised(before, {
          title: src.title, summary: src.summary ?? before.summary, name: src.name, type: src.type, content, by, note: note ?? `copied from ${src.id}`, event: { copiedFrom: src.id },
        }));
      }
      const name = artifactName(r.file.name);
      const type = artifactType(name, r.file.type);
      if (type === undefined) return { no: `the hopper does not know the type ${r.file.type}`, status: 400 };
      if (r.file.content.length === 0) return { no: `${name} is empty: there is nothing to keep`, status: 400 };
      const { content, masked } = masking(kindOf(type), r.file.content);
      const full = overLimits(name, content.length);
      if (full) return full;
      return o.store.tx(() => revised(before, { title: before.title, summary: before.summary, name, type, content, by, note, event: masked > 0 ? { masked } : {} }));
    },
    merge(into: string, from: string[], by: string): MergeDone | Refusal {
      const target = repo.get(into);
      if (!target) return missing(into);
      if (from.length === 0) return { no: 'name an artifact to merge', status: 400 };
      const sources: Artifact[] = [];
      for (const id of from) {
        if (id === into) return { no: `artifact ${id} is the one merged into: it cannot merge into itself`, status: 400 };
        if (from.indexOf(id) !== from.lastIndexOf(id)) return { no: `artifact ${id} is named twice`, status: 400 };
        const src = repo.get(id);
        if (!src) return missing(id);
        sources.push(src);
      }
      // Each revision is copied before its source goes: the copies count toward the quota until then.
      const plan = sources.map((src) => ({ src, revisions: repo.revisions(src.id).reverse() }));
      const full = overQuota(`the merge of ${from.length} artifact${from.length > 1 ? 's' : ''}`, plan.reduce((n, p) => n + p.revisions.reduce((m, r) => m + r.size, 0), 0));
      if (full) return full;
      const artifact = o.store.tx(() => {
        let latest = target;
        for (const { src, revisions } of plan) {
          const first = latest.revision + 1;
          for (const r of revisions) {
            const content = repo.revisionContent(src.id, r.n);
            if (!content) throw new Error(`artifact ${src.id} revision ${r.n} has no content: the merge changes nothing`);
            latest = revised(latest, {
              title: r.title, summary: r.summary ?? latest.summary, name: r.name, type: r.type, content, by: r.by, note: `merged from ${src.id}`, event: { mergedFrom: src.id },
            });
          }
          // The source goes only once each of its revisions is confirmed in the target, by number and hash.
          const kept = new Map(repo.revisions(into).map((r) => [r.n, r.sha256]));
          if (revisions.some((r, i) => kept.get(first + i) !== r.sha256)) throw new Error(`the revisions of artifact ${src.id} are not all in ${into}: the merge changes nothing`);
          repo.remove(src.id);
          o.store.events.append({ type: 'artifact.removed', jobId: src.jobId, data: { artifact: src.id, reason: 'merged', into, by } });
        }
        return latest;
      });
      return { artifact, merged: sources.map((s) => s.id) };
    },
  };
}
