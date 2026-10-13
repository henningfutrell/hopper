// The tenant migrations from 48 on: tenant-migrations.ts puts them at the end of its list (TENANT_MIGRATIONS), so that list
// stays under the file-size limit. A new tenant migration is appended here: its import on a line of its own after the
// others, and its entry on a line of its own, its comment above it.
// Numbers are given out at merge time (issue #967): the base branch marks this file `hopper-merge=additions`
// (.gitattributes), so when two pull requests each append a migration, the hopper's base merge keeps both, the base
// branch's first, with no job. The place in the list is the version; the number in a comment is the one its author saw.
import type { Migration } from './tenant-migrations.ts';
import { CHECKPOINT_TABLE } from './checkpoints.ts';
import { DIRECT_JOB_TABLE } from './direct-jobs.ts';
import { SEARCH_PENDING_TABLE } from './search-pending.ts';
import { PROMOTION_TABLE } from './promotions.ts';
import { GITHUB_LISTING_TABLES } from './github-listings.ts';

export const RECENT_TENANT_MIGRATIONS: readonly Migration[] = [
  // 48: Job checkpoints (issue #921): each job's latest patch and agent session. A table only: the build before runs on it.
  CHECKPOINT_TABLE,
  // 49: Direct jobs (issue #901): each job a person submitted straight to the hopper. A table only: the build before runs on it.
  DIRECT_JOB_TABLE,
  // 50: Pending index updates (issue #945): the search documents to write to Solr again. A table only: the build before runs on it.
  SEARCH_PENDING_TABLE,
  // 51: Promotions to GitHub (issue #946): where each direct job was posted. A table only: the build before runs on it.
  PROMOTION_TABLE,
  // 52: The listing cache (issue #985): each repository's latest repository listing. Tables only: the build before runs on them.
  GITHUB_LISTING_TABLES,
];
