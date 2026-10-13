// Repository listings (issue #985, design.md "Repository listings"): what one batched GraphQL sync of a GitHub source says
// of each repository — its open issues and pull requests that carry one of the source's labels — and the listing cache
// that keeps the latest listing of each repository with when it was read. Pure.
import type { ChecksState } from './pull-requests.ts';

/** What a listing says of an open pull request beyond what it says of an issue. */
export interface ListedPull {
  isDraft: boolean;
  headRef: string;
  headOid: string;
  base: string;
  /** GitHub's `mergeable`: `MERGEABLE`, `CONFLICTING` or `UNKNOWN` (not yet computed). */
  mergeable: string;
  /** Its head commit's check rollup; `none`: no checks; `unknown`: the credential may not read checks. */
  checks: ChecksState | 'none';
}

/** One open issue or pull request of a repository listing. */
export interface ListedItem {
  /** owner/repo */
  repo: string;
  number: number;
  kind: 'issue' | 'pull';
  url: string;
  title: string;
  author: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  /** A pull request's head, base, mergeable and checks; absent for an issue. */
  pull?: ListedPull;
}

/**
 * One sync's listing of each repository asked: `repos` the ones read whole, every page, with their items; `repoErrors` the
 * ones GitHub did not answer for (not found, no access), each with GitHub's message. A repository is in one of the two.
 */
export interface RepoListing {
  repos: Map<string, ListedItem[]>;
  repoErrors: Map<string, string>;
}

/** A repository's listing as the cache keeps it: when it was read, and its items then. */
export interface CachedListing { fetchedAt: string; items: ListedItem[] }

/** The listing cache (tenant migration 52): derived data, read again from GitHub when lost. */
export interface GitHubListingRepository {
  /** Keep `items` as `repo`'s listing read at `fetchedAt`: it replaces the one before, so an item gone from it is gone. */
  record(repo: string, items: ListedItem[], fetchedAt: string): void;
  /** `repo`'s latest listing, or undefined when none was read. */
  listing(repo: string): CachedListing | undefined;
  /** One item of `repo`'s latest listing, or undefined when it is in none. */
  item(repo: string, number: number): ListedItem | undefined;
  /** Drop `repo`'s listing (it is no longer listed). */
  forget(repo: string): void;
}
