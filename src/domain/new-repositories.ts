// New repositories (issue #2795, design.md "New repositories"): a repository a connected account reaches now that no read
// before saw. The **new-repository policy** — the user's setting, per connected account — says, per owner, what happens to
// one: `ask` (the default) holds it as a **new-repository ask** in Sources, for a person to add to the job repositories or
// dismiss; `accept` adds it to the job repositories at once. The default is a value of the setting, never a path around it.
// The first read only learns what the account reaches: nothing it reached then is new. Pure: the caller passes the time.

export const NEW_REPOSITORY_MODES = ['ask', 'accept'] as const;
export type NewRepositoryMode = typeof NEW_REPOSITORY_MODES[number];

/** `mode`: for every owner; `owners`: an owner's own mode (a GitHub account or organization, any case), which wins. */
export interface NewRepositoryPolicy { mode: NewRepositoryMode; owners: Record<string, NewRepositoryMode> }
export const DEFAULT_NEW_REPOSITORY_POLICY: NewRepositoryPolicy = { mode: 'ask', owners: {} };

/** A new repository that waits for a person: `at`, when the hopper first saw it. */
export interface NewRepositoryAsk { repository: string; at: string }

/** What is kept per connected account: the policy, every repository it has reached (absent: never read), the open asks. */
export interface NewRepositoryRecord { policy: NewRepositoryPolicy; seen?: string[]; asks: NewRepositoryAsk[] }
/** What a person changes (`POST /ui/api/connected-accounts` `new-repositories`): the whole policy, and asks to drop. */
export interface NewRepositoryChange { policy?: NewRepositoryPolicy; dismiss?: readonly string[] }

export const NO_NEW_REPOSITORIES: NewRepositoryRecord = { policy: DEFAULT_NEW_REPOSITORY_POLICY, asks: [] };

const lower = (s: string): string => s.toLowerCase();

/** The mode for `repository` (`owner/name`): its owner's own, else the policy's. */
export function modeFor(policy: NewRepositoryPolicy, repository: string): NewRepositoryMode {
  const owner = lower(repository.slice(0, repository.indexOf('/')));
  const own = Object.entries(policy.owners).find(([o]) => lower(o) === owner);
  return own ? own[1] : policy.mode;
}

export interface NewRepositoriesFound {
  record: NewRepositoryRecord;
  /** To add to the job repositories now: new ones, and waiting asks, whose mode is `accept`. */
  accepted: string[];
  /** Asked about for the first time by this read. */
  asked: string[];
}

/**
 * One read of what the account reaches. `chosen`: its job repositories; `taken`: a repository another account has for its
 * jobs. Neither is ever new. An ask whose repository is no longer reached, or is chosen now, is dropped; a dismissed one
 * stays seen, so it is not asked about again.
 */
export function findNewRepositories(record: NewRepositoryRecord, reached: readonly string[], chosen: readonly string[], taken: (repository: string) => boolean, at: string): NewRepositoriesFound {
  if (record.seen === undefined) return { record: { ...record, seen: [...reached] }, accepted: [], asked: [] };
  const seen = new Set(record.seen.map(lower)), picked = new Set(chosen.map(lower)), now = new Set(reached.map(lower));
  const open = (r: string) => now.has(lower(r)) && !picked.has(lower(r)) && !taken(r);
  const waiting = record.asks.filter((a) => open(a.repository));
  const fresh = reached.filter((r) => !seen.has(lower(r)) && open(r) && !waiting.some((a) => lower(a.repository) === lower(r)));
  const candidates = [...waiting, ...fresh.map((repository) => ({ repository, at }))];
  const accepted = candidates.filter((a) => modeFor(record.policy, a.repository) === 'accept').map((a) => a.repository);
  const asks = candidates.filter((a) => modeFor(record.policy, a.repository) === 'ask');
  const asked = fresh.filter((r) => modeFor(record.policy, r) === 'ask');
  return { record: { ...record, seen: [...record.seen, ...reached.filter((r) => !seen.has(lower(r)))], asks }, accepted, asked };
}
