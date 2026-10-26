// A person's bug reports (issue #694, tenant migration 39): one row each, the body as JSON, with the columns read by —
// its state and when it was made. Your reports lists them newest first; the send loop reads the waiting ones.
import type { BugReportRepository } from '../domain/ports.ts';
import type { BugReport } from '../domain/bug-reports.ts';
import { applyPatch, parse, type StoreContext } from './context.ts';

export const BUG_REPORT_TABLE = `
  CREATE TABLE bug_reports (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX bug_reports_state ON bug_reports (state, created_at)`;

export function createBugReportRepository(c: StoreContext): BugReportRepository {
  const get = (id: string): BugReport | undefined => {
    const r = c.db.get('SELECT body FROM bug_reports WHERE id = ?', id);
    return r ? parse<BugReport>(r.body) : undefined;
  };
  const many = (sql: string, ...args: (string | number)[]): BugReport[] => c.db.all(sql, ...args).map((r) => parse<BugReport>(r.body));
  return {
    add(input) {
      const r: BugReport = { id: c.idGen(), ...input };
      c.db.run('INSERT INTO bug_reports (id, state, created_at, body) VALUES (?, ?, ?, ?)', r.id, r.state, r.createdAt, JSON.stringify(r));
      return r;
    },
    addOnce(id, input) {
      const r: BugReport = { id, ...input };
      const added = c.db.run('INSERT INTO bug_reports (id, state, created_at, body) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', r.id, r.state, r.createdAt, JSON.stringify(r)).changes > 0;
      return added ? r : undefined;
    },
    get,
    list: (limit = 200) => many('SELECT body FROM bug_reports ORDER BY created_at DESC, seq DESC LIMIT ?', limit),
    inState: (state) => many('SELECT body FROM bug_reports WHERE state = ? ORDER BY created_at, seq', state),
    update(id, patch) {
      const r = get(id);
      if (!r) throw new Error(`bug report not found: ${id}`);
      const next = applyPatch<BugReport>(r, patch);
      c.db.run('UPDATE bug_reports SET state = ?, body = ? WHERE id = ?', next.state, JSON.stringify(next), id);
      return next;
    },
    remove(id) {
      c.db.run('DELETE FROM bug_reports WHERE id = ?', id);
    },
  };
}
