// GitHub watches (issue #427, tenant migration 44): one row per pointed job, its last snapshot and poll in the body as JSON.
import type { GitHubWatch, GitHubWatchRepository } from '../domain/github-watch.ts';
import { parse, type StoreContext } from './context.ts';

export const GITHUB_WATCH_TABLE = 'CREATE TABLE github_watches (pointed_job TEXT PRIMARY KEY, body TEXT NOT NULL)';

export function createGitHubWatchRepository(c: StoreContext): GitHubWatchRepository {
  return {
    get(id) {
      const r = c.db.get('SELECT body FROM github_watches WHERE pointed_job = ?', id);
      return r ? parse<GitHubWatch>(r.body) : undefined;
    },
    put(w) {
      c.db.run('INSERT INTO github_watches (pointed_job, body) VALUES (?, ?) ON CONFLICT (pointed_job) DO UPDATE SET body = excluded.body', w.pointedJob, JSON.stringify(w));
    },
  };
}
