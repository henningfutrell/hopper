// The artifacts' tables (issue #624): each artifact with its content, and its shares, in the user's schema. The content
// crosses the store's text-only parameters as base64 and is kept as bytes. A list never reads content. The settings of
// Settings → Artifacts are a `settings` row.
import { DEFAULT_ARTIFACT_SETTINGS, kindOf, type Artifact, type ArtifactRepository, type ArtifactSettings, type ArtifactShare, type ShareKind } from '../domain/artifacts.ts';
import type { StoreContext } from './context.ts';

const COLUMNS = 'id, user_id, job_id, issue_url, issue_ref, title, name, type, size, sha256, created_at';
const SETTINGS_KEY = 'artifactSettings';

const toArtifact = (r: Record<string, unknown>): Artifact => ({
  id: r.id as string, userId: r.user_id as string, jobId: r.job_id as string,
  ...(r.issue_url !== null ? { issue: { url: r.issue_url as string, ref: (r.issue_ref as string | null) ?? '' } } : {}),
  title: r.title as string, name: r.name as string, type: r.type as string, kind: kindOf(r.type as string),
  size: Number(r.size), sha256: r.sha256 as string, createdAt: r.created_at as string,
});

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
      c.db.run(`INSERT INTO artifacts (${COLUMNS}, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, decode(?, 'base64'))`,
        a.id, a.userId, a.jobId, a.issue?.url ?? null, a.issue?.ref ?? null, a.title, a.name, a.type, a.size, a.sha256, a.createdAt, content.toString('base64'));
    },
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
    usedBytes: () => Number(c.db.get('SELECT COALESCE(SUM(size), 0) AS n FROM artifacts')!.n),
    olderThan: (iso) => c.db.all('SELECT id FROM artifacts WHERE created_at < ? ORDER BY created_at', iso).map((r) => r.id as string),
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
