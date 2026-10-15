// The repositories' checks as last read (issue #1250, tenant migration 64): one row per job repository, the read as JSON,
// with its answers' ETags. Derived data: a lost row is read again from GitHub at the next Refresh or schedule.
import type { RepoChecksRead, RepoChecksReadRepository } from '../domain/repo-checks.ts';
import { parse, type StoreContext } from './context.ts';

export const REPO_CHECKS_TABLE = 'CREATE TABLE repo_checks (repo TEXT PRIMARY KEY, body TEXT NOT NULL)';

export function createRepoChecksReadRepository(c: StoreContext): RepoChecksReadRepository {
  return {
    get(repo) {
      const r = c.db.get('SELECT body FROM repo_checks WHERE repo = ?', repo);
      return r ? parse<RepoChecksRead>(r.body) : undefined;
    },
    put(read) {
      c.db.run('INSERT INTO repo_checks (repo, body) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET body = excluded.body', read.repo, JSON.stringify(read));
    },
  };
}
