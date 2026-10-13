// The listing cache (issue #985, tenant migration 52): each repository's latest repository listing — when it was read, and
// a row for each open labelled issue or pull request in it, the item as JSON with its `updatedAt` and, for a pull request,
// its check rollup beside it. Derived data: the build before never reads it, and a lost row is read again from GitHub.
import type { GitHubListingRepository, ListedItem } from '../domain/github-listing.ts';
import { parse, type StoreContext } from './context.ts';

export const GITHUB_LISTING_TABLES = `
  CREATE TABLE github_listings (
    repo TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE github_listed_items (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    kind TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    checks TEXT,
    body TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  )`;

export function createGitHubListingRepository(c: StoreContext): GitHubListingRepository {
  const forget = (repo: string) => {
    c.db.run('DELETE FROM github_listed_items WHERE repo = ?', repo);
    c.db.run('DELETE FROM github_listings WHERE repo = ?', repo);
  };
  return {
    record(repo, items, fetchedAt) {
      c.tx(() => {
        forget(repo);
        c.db.run('INSERT INTO github_listings (repo, fetched_at) VALUES (?, ?)', repo, fetchedAt);
        for (const i of items) {
          c.db.run('INSERT INTO github_listed_items (repo, number, kind, updated_at, checks, body) VALUES (?, ?, ?, ?, ?, ?)',
            repo, i.number, i.kind, i.updatedAt, i.pull?.checks ?? null, JSON.stringify(i));
        }
      });
    },
    listing(repo) {
      const r = c.db.get('SELECT fetched_at FROM github_listings WHERE repo = ?', repo);
      if (!r) return undefined;
      const items = c.db.all('SELECT body FROM github_listed_items WHERE repo = ? ORDER BY number', repo).map((row) => parse<ListedItem>(row.body));
      return { fetchedAt: r.fetched_at as string, items };
    },
    item(repo, number) {
      const r = c.db.get('SELECT body FROM github_listed_items WHERE repo = ? AND number = ?', repo, number);
      return r ? parse<ListedItem>(r.body) : undefined;
    },
    forget: (repo) => c.tx(() => forget(repo)),
  };
}
