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
import { accountSourceOnly } from './migration-account-source.ts';
import { noSandboxMachines } from './migration-no-sandbox-machines.ts';
import { noTemplateTimeLimit } from './migration-template-limits.ts';
import { NOTIFIER_DELIVERY_TABLE } from './notifier-deliveries.ts';
import { JOB_LEASE_RELAYED_COLUMN, JOB_LEASE_TABLE } from './job-leases.ts';
import { EVENT_CURSOR_TABLE } from './event-cursors.ts';
import { WAIT_CHECK_LEASE_TABLE } from './wait-check-leases.ts';
import { PROMOTION_SEND_TABLE } from './promotions.ts';
import { noQuestionOnOwnWait } from './migration-own-wait-question.ts';
import { TOPOLOGY_TABLE } from './topology.ts';
import { containerTargets } from './migration-container-target.ts';
import { SKILL_LIBRARY_TABLE } from './skill-library.ts';
import { originPendingOffered, originPendingStarted } from './migration-origin-pending.ts';
import { INTAKE_ARRIVAL_TABLE } from './intake-arrivals.ts'; import { INFRA_PLAN_REJECTION_TABLE } from './infra-plans.ts'; import { TOKEN_LEDGER_FAILED_TESTS_COLUMN, TOKEN_LEDGER_TABLE } from './token-ledger.ts';
import { RESOURCE_LEDGER_TABLE } from './resource-ledger.ts';
import { observeTemplatesChecked } from './migration-observe-checked.ts';
import { DISK_MEASURE_TABLE } from './disk-measures.ts';

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
  // 68: The work-item ledger, rebuilt (issue #1356): an item keeps a merge recorded as the whole item while its job still
  // acts on it (`wholeMerged`), so a batch run closes the issue of an item whose job still waits. Rows only, a new field in each body:
  // the build before ignores it.
  (db) => { rebuildWorkItems(db); },
  // 69: GitHub through the sign-in alone (issue #1377): a config with no connected account's source gets one; every
  // `github-app` instance leaves it, the account's source takes its jobs and source events (switched on where needed), the
  // ledger is rebuilt, and the App's key leaves the vault. The build before runs on it: a config it knows, and jobs of a
  // source it runs.
  accountSourceOnly,
  // 70: A sandbox is no machine (issue #1349): each client machine of a sandbox box the hopper started leaves `machines`.
  // Config rows only: the build before runs on them, and its reconcile pass removes the boxes no machine names.
  (db) => { noSandboxMachines(db); },
  // 71: No time limit and no kept home on a template (issue #1349): each stored template's limits lose `ttlMinutes` and
  // `keepHome`, which no box reads. Rows only: the build before reads both as absent, its defaults.
  (db) => { noTemplateTimeLimit(db); },
  // 72: machine credential acceptances (issue #1459): an admin's acceptance that a machine whose job user holds infra
  // credentials takes jobs anyway. A row per machine, revoked when `revoked_at` is set. A table only: the build before
  // never reads it, and holds such machines.
  'CREATE TABLE IF NOT EXISTS machine_credential_acceptances (machine_key TEXT PRIMARY KEY, credentials TEXT NOT NULL, accepted_by TEXT NOT NULL, accepted_at TEXT NOT NULL, revoked_at TEXT)',
  // 73: Notifier deliveries (issue #1587): one row per notification a notifier sends, until it is delivered or fails. A
  // table only: the build before runs on it, and sends in memory, as before.
  NOTIFIER_DELIVERY_TABLE,
  // 74: Job leases (issue #1662): the hopper that drives each claimed or running job, until when. A table only: the build
  // before runs on it, and drives its jobs with no lease, as before.
  JOB_LEASE_TABLE,
  // 75: Event cursors (issue #1572): the last event each consumer of the event log handled. A table only: the build before
  // runs on it, and a later start of this build catches up from each cursor.
  EVENT_CURSOR_TABLE,
  // 76: The wait checks' leases (issue #1694): which hopper tests a job's wait check, until when. A table only: the build
  // before runs on it, and ignores the wait check kept in a job's wait.
  WAIT_CHECK_LEASE_TABLE,
  // 77: A promotion's new issue or comment on its way (issue #1591): kept before GitHub is asked, so a stop or a lost answer
  // links what GitHub made. A table only: the build before runs on it, and never reads it.
  PROMOTION_SEND_TABLE,
  // 78: A person's cancel or park of a job that another hopper drives (issue #1662), on the job's lease. A nullable column
  // only: the build before runs on it, and names its columns when it inserts.
  JOB_LEASE_RELAYED_COLUMN,
  // 79: No question on a job's own wait (issue #1780): each job on its own wait loses the `questionId` of a question it asked
  // before. Rows only: the build before reads it only for a job waiting on its answer or parked.
  noQuestionOnOwnWait,
  // 80: The topology sources (issue #1781): each source's last good snapshot of the infrastructure topology and its last
  // read. A table only: the build before runs on it, and never reads it.
  TOPOLOGY_TABLE,
  // 81: A container target on the sandbox module (issue #865 part C): each `docker` machine becomes a `container` machine of
  // the same name, and `dockerBin` leaves the command executors and claude-plan sources. Config rows only: the build before
  // lists no such machine, and its jobs wait.
  (db) => { containerTargets(db); },
  // 82: The item lifecycle (issue #1891): each work item's owner, next check and deadline, as columns, and the ledger rebuilt,
  // so an item in PR open with no pull request is blocked on it. Nullable columns: the build before runs on them, names its
  // columns when it writes, and reads an item blocked as no state it counts.
  (db) => { rebuildWorkItems(db); },
  // 83: A pull request closed without a merge on GitHub blocks its item (issue #1891, `pr_closed`), in place of dropping it:
  // the ledger rebuilt, so an item whose issue is still open waits on a person. Rows only: the build before reads `blocked`.
  (db) => { rebuildWorkItems(db); },
  // 84: The skill library (issue #1911): each version of a library skill the user made, kept whole. A table only: the build
  // before runs on it, never reads it, and gives jobs no work skill.
  SKILL_LIBRARY_TABLE,
  // 85: A job of a GitHub source with no origin that had started when 39 ran waits for its origin too (issue #1974), so the
  // next sync judges it in place of an `untrusted` stamp nothing lets go on. Rows only: the build before reads the flag.
  originPendingStarted,
  // 86: A job made from an item offered with no origin (issue #2113) waits for it as 85's do: the next sync judges its issue
  // or opens its request card. Rows only: the build before reads the flag.
  originPendingOffered,
  // 87: Intake arrivals (issue #2228): when each source first listed each item. A table only: the build before runs on it,
  // and never reads it.
  INTAKE_ARRIVAL_TABLE,
  // 88: A template of read and observe needs only takes the read-only check (issue #2146, part 5): each stored one is marked
  // `readOnly`. Rows only: the build before checks only its reads, so a template of observes only fails that check and
  // waits, and its bastion with it.
  (db) => { observeTemplatesChecked(db); },
  // 89: The token ledger (issue #2302): each model's token use in each agent session of each job. A table only: the build
  // before runs on it, and never reads it.
  TOKEN_LEDGER_TABLE,
  // 90: The failed test runs of each row of the token ledger (issue #2302, part 4: a waste signal). A column with a default:
  // the build before runs on it, and names its columns when it writes.
  TOKEN_LEDGER_FAILED_TESTS_COLUMN,
  // 91: A person's rejection of an infra plan (issue #2368): a row of its own, as an approval is. A table only: the build
  // before runs on it, and never reads it.
  INFRA_PLAN_REJECTION_TABLE,
  // 92: The resource ledger (issue #2504): each thing the hopper made for a job on a machine, and where it stands. A table
  // only: the build before runs on it, and never reads it.
  RESOURCE_LEDGER_TABLE,
  // 93: The memory a machine's job scopes hold for jobs with no lane in use there (issue #2499), in each machine sample. A
  // column with no default: the build before runs on it, and names its columns when it writes.
  'ALTER TABLE machine_samples ADD COLUMN waiting_mem DOUBLE PRECISION',
  // 94: Each machine's last disk measure (issue #2494), so a restart still shows it. A table only: the build before runs on
  // it, and never reads it.
  DISK_MEASURE_TABLE,
  // 95: Until when the reap at a job's end kept a resource ledger entry for a retention (issue #2504 part 5). A column with
  // no default: the build before runs on it, and names its columns when it writes.
  'ALTER TABLE job_resource_ledger ADD COLUMN retained_until TEXT',
  // 96: Each machine sample's memory pressure and CPU throttle (issue #2499). Columns with no default: the build before runs
  // on it, and names its columns when it writes.
  `ALTER TABLE machine_samples ADD COLUMN mem_pressure DOUBLE PRECISION;
   ALTER TABLE machine_samples ADD COLUMN cpu_throttled DOUBLE PRECISION`,
  // 97: Each machine sample's disk use of the hopper and of the caches (issue #2494). Columns with no default: the build
  // before runs on it, and names its columns when it writes.
  `ALTER TABLE machine_samples ADD COLUMN hopper_disk DOUBLE PRECISION;
   ALTER TABLE machine_samples ADD COLUMN cache_disk DOUBLE PRECISION`,
  // 98: The maids' attempts on each resource ledger entry, and when they try it again (issue #2504 part 14). A column with a
  // default and one with none: the build before runs on it, and names its columns when it writes.
  `ALTER TABLE job_resource_ledger ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE job_resource_ledger ADD COLUMN next_attempt_at TEXT`,
];
