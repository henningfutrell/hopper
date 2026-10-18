// The skill library's records (issue #1911, design.md "The skill library"): one row per version of a library skill the
// user made — never changed once kept, so a job's work skill stays what it was —, and a removed skill's mark. The choice of
// work skills is the user's setting `workSkills`. Built-in skills are no rows: they ship with the hopper (src/skill-library/).
import type { LibrarySkillSource, LibrarySkillVersion, SkillLibraryRepository, WorkSkillSettings } from '../domain/skill-library.ts';
import { parse, type StoreContext } from './context.ts';

export const SKILL_LIBRARY_TABLE = 'CREATE TABLE IF NOT EXISTS library_skill_versions (name TEXT NOT NULL, seq INTEGER NOT NULL, version TEXT NOT NULL, files TEXT NOT NULL, source TEXT NOT NULL, by_whom TEXT NOT NULL, at TEXT NOT NULL, removed_at TEXT, PRIMARY KEY (name, seq))';

const row = (r: Record<string, unknown>): LibrarySkillVersion => ({
  name: r.name as string, seq: Number(r.seq), version: r.version as string, files: parse<Record<string, string>>(r.files),
  source: parse<LibrarySkillSource>(r.source), by: r.by_whom as string, at: r.at as string,
});

export function createSkillLibraryRepository(c: StoreContext): SkillLibraryRepository {
  return {
    latest: () => c.db.all('SELECT v.* FROM library_skill_versions v WHERE v.removed_at IS NULL AND v.seq = (SELECT MAX(w.seq) FROM library_skill_versions w WHERE w.name = v.name) ORDER BY v.name').map(row),
    versions: (name) => c.db.all('SELECT * FROM library_skill_versions WHERE name = ? AND removed_at IS NULL ORDER BY seq DESC', name).map(row),
    version(name, version) {
      const r = c.db.get('SELECT * FROM library_skill_versions WHERE name = ? AND version = ? ORDER BY seq DESC LIMIT 1', name, version);
      return r ? row(r) : undefined;
    },
    add(v) {
      return c.tx(() => {
        const last = c.db.get('SELECT MAX(seq) AS seq FROM library_skill_versions WHERE name = ?', v.name);
        const kept: LibrarySkillVersion = { ...v, seq: Number(last?.seq ?? 0) + 1 };
        c.db.run('INSERT INTO library_skill_versions (name, seq, version, files, source, by_whom, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          kept.name, kept.seq, kept.version, JSON.stringify(kept.files), JSON.stringify(kept.source), kept.by, v.at);
        return kept;
      });
    },
    remove(name, at) {
      return c.db.run('UPDATE library_skill_versions SET removed_at = ? WHERE name = ? AND removed_at IS NULL', at, name).changes > 0;
    },
    getWorkSkills() {
      const r = c.db.get("SELECT value FROM settings WHERE key = 'workSkills'");
      return r ? parse<WorkSkillSettings>(r.value) : undefined;
    },
    setWorkSkills(s) {
      c.db.run("INSERT INTO settings (key, value) VALUES ('workSkills', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify({ kinds: s.kinds, repos: s.repos }));
    },
  };
}
