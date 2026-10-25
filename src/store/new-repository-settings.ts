// What a connected account keeps of its new repositories (issue #2795), apart from settings.ts for its size: the user's
// key-value setting `newRepositories:<account key>`, absent until its first read or the person's first change.
import { NO_NEW_REPOSITORIES, type NewRepositoryRecord } from '../domain/new-repositories.ts';
import type { ConnectedAccountKey } from '../domain/types.ts';

export function newRepositorySettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getNewRepositories(key: ConnectedAccountKey): NewRepositoryRecord;
  setNewRepositories(key: ConnectedAccountKey, record: NewRepositoryRecord): void;
} {
  return {
    getNewRepositories(key) {
      const text = read(`newRepositories:${key}`);
      return text === undefined ? NO_NEW_REPOSITORIES : JSON.parse(text) as NewRepositoryRecord;
    },
    setNewRepositories(key, r) {
      write(`newRepositories:${key}`, JSON.stringify({
        policy: { mode: r.policy.mode, owners: r.policy.owners }, ...(r.seen ? { seen: r.seen } : {}), asks: r.asks.map((a) => ({ repository: a.repository, at: a.at })),
      }));
    },
  };
}
