// The artifacts' tables (issue #624): each artifact with its content, and its shares, in the user's schema. The content
// crosses the store's text-only parameters as base64 and is kept as bytes. A list never reads content. The settings of
// Settings → Artifacts are a `settings` row. Revisions (issue #675): the `artifacts` row is the latest revision; each
// older one is a row of `artifact_revisions`, its content with it.
import {
  DEFAULT_ARTIFACT_SETTINGS, kindOf, type Artifact, type ArtifactRepository, type ArtifactRevision, type ArtifactSettings, type ArtifactShare, type ShareKind,
} from '../domain/artifacts.ts';
import type { StoreContext } from './context.ts';

const COLUMNS = 'id, user_id, job_id, issue_url, issue_ref, title, name, type, size, sha256, created_at, summary, revision, updated_at, revised_by, note, pinned';
const REVISION_COLUMNS = 'artifact_id, n, title, summary, name, type, size, sha256, created_at, created_by, note, pinned';
const SETTINGS_KEY = 'artifactSettings';

const toArtifact = (r: Record<string, unknown>): Artifact => ({
  id: r.id as string, userId: r.user_id as string, jobId: r.job_id as string,
  ...(r.issue_url !== null ? { issue: { url: r.issue_url as string, ref: (r.issue_ref as string | null) ?? '' } } : {}),
  title: r.title as string, name: r.name as string, type: r.type as string, kind: kindOf(r.type as string),
  size: Number(r.size), sha256: r.sha256 as string, createdAt: r.created_at as string,
  ...(r.summary !== null ? { summary: r.summary as string } : {}),
  // A row the build before put has no revision columns filled: its revision 1, made by its job when it was put.
  revision: Number(r.revision), updatedAt: (r.updated_at as string | null) ?? (r.created_at as string),
  revisedBy: (r.revised_by as string | null) ?? `job ${r.job_id as string}`,
  ...(r.note !== null ? { note: r.note as string } : {}), pinned: r.pinned === true,
});

const latestRevision = (a: Artifact): ArtifactRevision => ({
  artifactId: a.id, n: a.revision, title: a.title, ...(a.summary !== undefined ? { summary: a.summary } : {}), name: a.name, type: a.type,
  kind: a.kind, size: a.size, sha256: a.sha256, createdAt: a.updatedAt, by: a.revisedBy, ...(a.note !== undefined ? { note: a.note } : {}),
  pinned: a.pinned, latest: true,
});

const toRevision = (r: Record<string, unknown>): ArtifactRevision => ({
  artifactId: r.artifact_id as string, n: Number(r.n), title: r.title as string, ...(r.summary !== null ? { summary: r.summary as string } : {}),
  name: r.name as string, type: r.type as string, kind: kindOf(r.type as string), size: Number(r.size), sha256: r.sha256 as string,
  createdAt: r.created_at as string, by: r.created_by as string, ...(r.note !== null ? { note: r.note as string } : {}), pinned: r.pinned === true, latest: false,
});

const bool = (b: boolean): string => (b ? 'true' : 'false');

const toShare = (r: Record<string, unknown>): ArtifactShare => ({
  id: r.id as string, artifactId: r.artifact_id as string, kind: r.kind as ShareKind,
  ...(r.user_id !== null ? { userId: r.user_id as string } : {}),
  ...(r.user_name !== null ? { userName: r.user_name as string } : {}),
  ...(r.expires_at !== null ? { expiresAt: r.expires_at as string } : {}),
  createdAt: r.created_at as string, createdBy: r.created_by as string,
  ...(r.revoked_at !== null ? { revokedAt: r.revoked_at as string } : {}),
  ...(r.revoked_by !== null ? { revokedBy: r.revoked_by as string } : {}),
});

const LIVE = '(revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?))';

export function createArtifactRepository(c: StoreContext): ArtifactRepository {
  return {
    add(a, content) {
      c.db.run(`INSERT INTO artifacts (${COLUMNS}, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::boolean, decode(?, 'base64'))`,
        a.id, a.userId, a.jobId, a.issue?.url ?? null, a.issue?.ref ?? null, a.title, a.name, a.type, a.size, a.sha256, a.createdAt,
        a.summary ?? null, a.revision, a.updatedAt, a.revisedBy, a.note ?? null, bool(a.pinned), content.toString('base64'));
    },
    revise(a, content) {
      // The latest so far becomes an older revision, its content copied in the database; then the row is the new one.
      c.db.run(`INSERT INTO artifact_revisions (${REVISION_COLUMNS}, content)
        SELECT id, revision, title, summary, name, type, size, sha256, COALESCE(updated_at, created_at), COALESCE(revised_by, 'job ' || job_id), note, pinned, content
        FROM artifacts WHERE id = ?`, a.id);
      c.db.run(`UPDATE artifacts SET title = ?, name = ?, type = ?, size = ?, sha256 = ?, summary = ?, revision = ?, updated_at = ?, revised_by = ?, note = ?,
        pinned = false, content = decode(?, 'base64') WHERE id = ?`,
      a.title, a.name, a.type, a.size, a.sha256, a.summary ?? null, a.revision, a.updatedAt, a.revisedBy, a.note ?? null, content.toString('base64'), a.id);
    },
    revisions(id) {
      const r = c.db.get(`SELECT ${COLUMNS} FROM artifacts WHERE id = ?`, id);
      if (!r) return [];
      return [latestRevision(toArtifact(r)), ...c.db.all(`SELECT ${REVISION_COLUMNS} FROM artifact_revisions WHERE artifact_id = ? ORDER BY n DESC`, id).map(toRevision)];
    },
    revision(id, n) {
      const a = c.db.get(`SELECT ${COLUMNS} FROM artifacts WHERE id = ?`, id);
      if (!a) return undefined;
      const latest = toArtifact(a);
      if (latest.revision === n) return latestRevision(latest);
      const r = c.db.get(`SELECT ${REVISION_COLUMNS} FROM artifact_revisions WHERE artifact_id = ? AND n = ?`, id, n);
      return r ? toRevision(r) : undefined;
    },
    revisionContent(id, n) {
      const r = c.db.get("SELECT encode(content, 'base64') AS b FROM artifacts WHERE id = ? AND revision = ?", id, n)
        ?? c.db.get("SELECT encode(content, 'base64') AS b FROM artifact_revisions WHERE artifact_id = ? AND n = ?", id, n);
      return r ? Buffer.from(r.b as string, 'base64') : undefined;
    },
    pinRevision: (id, n, pinned) => c.db.run('UPDATE artifacts SET pinned = ?::boolean WHERE id = ? AND revision = ?', bool(pinned), id, n).changes > 0
      || c.db.run('UPDATE artifact_revisions SET pinned = ?::boolean WHERE artifact_id = ? AND n = ?', bool(pinned), id, n).changes > 0,
    oldRevisions: (iso) => c.db.all('SELECT artifact_id, n FROM artifact_revisions WHERE NOT pinned AND created_at < ? ORDER BY created_at, artifact_id, n', iso)
      .map((r) => ({ artifactId: r.artifact_id as string, n: Number(r.n) })),
    removeRevision: (id, n) => c.db.run('DELETE FROM artifact_revisions WHERE artifact_id = ? AND n = ?', id, n).changes > 0,
    get(id) {
      const r = c.db.get(`SELECT ${COLUMNS} FROM artifacts WHERE id = ?`, id);
      return r ? toArtifact(r) : undefined;
    },
    content(id) {
      // encode(…, 'base64') breaks its lines every 76 characters: Buffer.from skips the breaks.
      const r = c.db.get("SELECT encode(content, 'base64') AS b FROM artifacts WHERE id = ?", id);
      return r ? Buffer.from(r.b as string, 'base64') : undefined;
    },
    list(o = {}) {
      const limit = o.limit ?? 1000;
      return (o.jobId === undefined
        ? c.db.all(`SELECT ${COLUMNS} FROM artifacts ORDER BY created_at DESC, id LIMIT ?`, limit)
        : c.db.all(`SELECT ${COLUMNS} FROM artifacts WHERE job_id = ? ORDER BY created_at DESC, id LIMIT ?`, o.jobId, limit)).map(toArtifact);
    },
    remove: (id) => c.db.run('DELETE FROM artifacts WHERE id = ?', id).changes > 0,
    // Every revision counts toward the quota (issue #675).
    usedBytes: () => Number(c.db.get('SELECT (SELECT COALESCE(SUM(size), 0) FROM artifacts) + (SELECT COALESCE(SUM(size), 0) FROM artifact_revisions) AS n')!.n),
    olderThan: (iso) => c.db.all(`SELECT id FROM artifacts a WHERE COALESCE(updated_at, created_at) < ? AND NOT pinned
      AND NOT EXISTS (SELECT 1 FROM artifact_revisions r WHERE r.artifact_id = a.id AND r.pinned) ORDER BY created_at`, iso).map((r) => r.id as string),
    addShare(s) {
      c.db.run('INSERT INTO artifact_shares (id, artifact_id, kind, user_id, user_name, token_hash, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        s.id, s.artifactId, s.kind, s.userId ?? null, s.userName ?? null, s.tokenHash ?? null, s.expiresAt ?? null, s.createdAt, s.createdBy);
    },
    share(id) {
      const r = c.db.get('SELECT * FROM artifact_shares WHERE id = ?', id);
      return r ? toShare(r) : undefined;
    },
    shareByHash(hash) {
      const r = c.db.get('SELECT * FROM artifact_shares WHERE token_hash = ?', hash);
      return r ? toShare(r) : undefined;
    },
    shares: (artifactId, now) => (now === undefined
      ? c.db.all('SELECT * FROM artifact_shares WHERE artifact_id = ? ORDER BY created_at DESC, id', artifactId)
      : c.db.all(`SELECT * FROM artifact_shares WHERE artifact_id = ? AND ${LIVE} ORDER BY created_at DESC, id`, artifactId, now)).map(toShare),
    liveShares: (now) => c.db.all(`SELECT * FROM artifact_shares WHERE ${LIVE} ORDER BY created_at, id`, now).map(toShare),
    revokeShare: (id, by, at) => c.db.run('UPDATE artifact_shares SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', at, by, id).changes > 0,
    settings() {
      const r = c.db.get('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY);
      return r ? { ...DEFAULT_ARTIFACT_SETTINGS, ...JSON.parse(r.value as string) as Partial<ArtifactSettings> } : DEFAULT_ARTIFACT_SETTINGS;
    },
    setSettings(s) {
      c.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', SETTINGS_KEY, JSON.stringify({
        maxBytes: s.maxBytes, userBytes: s.userBytes, retentionDays: s.retentionDays, publicLinks: s.publicLinks, linkHours: s.linkHours, linkHoursMax: s.linkHoursMax, linkBase: s.linkBase,
      }));
    },
  };
}
