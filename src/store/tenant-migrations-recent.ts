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
import { SOURCE_CALLS_TABLE } from './source-calls.ts';
import { OUTBOUND_SEND_TABLE } from './outbound-sends.ts';
import { GITHUB_OUTBOX_TABLE } from './github-outbox.ts';
import { workItemLedger } from './work-items.ts';
import { rebuildWorkItems } from './work-items.ts';
import { REPO_CHECKS_TABLE } from './repo-checks.ts';
import { LAST_ACCOUNT_TABLE } from './last-accounts.ts';
import { APP_INSTALLATIONS_TABLE } from './app-installations.ts';
import { JOB_FILTER_COLUMNS } from './job-filter-columns.ts';

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
  // 53: A WSL machine's memory (issue #868): the memory its VM holds and Windows' own memory, free and total, on each
  // machine sample. Nullable columns only: the build before runs on them, and names its columns when it inserts.
  `ALTER TABLE machine_samples ADD COLUMN vm_held DOUBLE PRECISION;
   ALTER TABLE machine_samples ADD COLUMN host_mem_free DOUBLE PRECISION;
   ALTER TABLE machine_samples ADD COLUMN host_mem_total DOUBLE PRECISION`,
  // 54: The send log (issue #1014): each outbound send to a webhook, and each one the outbound guard held. A table only: the build before runs on it.
  OUTBOUND_SEND_TABLE,
  // 55: The work-item ledger (issue #1067): one row per work item, rebuilt from every event and the issue graph. A table
  // only: the build before runs on it, and a later start of this build rebuilds nothing it missed — `hopper ledger rebuild` does.
  workItemLedger,
  // 56: Each work item's landing stage (issue #1073 part 3): the ledger rebuilt, so the landing batch events kept already
  // put each job pull request merged into the landing branch at its stage. Rows only, a new field in each body: the build
  // before runs on them and reads no such field.
  (db) => { rebuildWorkItems(db); },
  // 57: The work-item ledger, rebuilt (issue #1067, part 4): a request card names its source (`requestSource`), so a sync
  // withdraws only its own. Rows only: the build before reads them as they were, with one more field it does not read.
  (db) => { rebuildWorkItems(db); },
  // 58: The work-item ledger, rebuilt (issue #1174): a proposal or a research report at a person needs you, so an item whose
  // job waits on one now reads `needs_you`, not `working`. Rows only, states the build before already knows.
  (db) => { rebuildWorkItems(db); },
  // 59: The work-item ledger, rebuilt (issue #1175): a culprit of a red batch, and its revert, is failed, not done. Rows
  // only: the build before reads them as they are, and keeps each in the state it is in.
  (db) => { rebuildWorkItems(db); },
  // 60: The work-item ledger, rebuilt (issue #1232): each landing stage names its pull request, so an earlier part's
  // `promoted` no longer stands for the item's next merge. Rows only, a new field in each landing: the build before ignores it.
  (db) => { rebuildWorkItems(db); },
  // 61: The call log (issue #1264): the calls each job source's sync passes made, a row per source and minute. A table only:
  // the build before runs on it.
  SOURCE_CALLS_TABLE,
  // 62: The GitHub outbox (issue #1238): the GitHub changes people's actions asked for, until sent. A table only: the build
  // before runs on it, and sends what it left there no more — its rows wait for the next start of this build.
  GITHUB_OUTBOX_TABLE,
  // 63: Where each listing's next change read starts (issue #1276), apart from its rows. A nullable column only: the build
  // before runs on it, and names its columns when it inserts.
  'ALTER TABLE github_listings ADD COLUMN since TEXT',
  // 64: The repositories' checks as last read (issue #1250): Sources answers from them, and a restart reads nothing again.
  // A table only: the build before runs on it.
  REPO_CHECKS_TABLE,
  // 65: The last accounts (issue #1269): who each machine's agent tool was last read signed in as. A table only: the build before runs on it.
  LAST_ACCOUNT_TABLE,
  // 66: Where the hopper's app is installed, as last read (issue #1250): Sources shows it, and a restart reads nothing
  // again. A table only: the build before runs on it.
  APP_INSTALLATIONS_TABLE,
  // 67: The fields job and failure lists filter on, as generated columns (issue #1154): a filtered list makes Postgres
  // parse no body. Generated columns only: the build before names none of them, and Postgres keeps them at its writes too.
  JOB_FILTER_COLUMNS,
];
