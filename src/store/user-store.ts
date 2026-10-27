// One user's store (issue #158): the tables of their user schema, over a connection of its own whose
// search_path is that schema (the `?schema=` of the database URL, db.ts).
import { USER_CONFIG, type Clock, type IdGen, type UserStore } from '../domain/ports.ts';
import { createArtifactRepository } from './artifacts.ts';
import { createBugReportRepository } from './bug-reports.ts';
import { createInfraPlanReads, createInfraPlanRepository } from './infra-plans.ts';
import { createOutOfBandRepository } from './out-of-band.ts';
import { createTopologyRepository } from './topology.ts';
import { createSkillLibraryRepository } from './skill-library.ts';
import { createContext } from './context.ts';
import { openDb } from './db.ts';
import { readDb } from './read-pool.ts';
import { createDecisionRepository } from './decisions.ts';
import { createConfigRecords } from './config.ts';
import { createConnectedAccountRepository } from './connected-accounts.ts';
import { createEventLog, eventsBetweenRead, memoryPeaksRead } from './events.ts';
import { createEventCursorRepository } from './event-cursors.ts';
import { createJobRepository } from './jobs.ts';
import { createJobStreamRepository } from './job-stream.ts';
import { createLaneRepository } from './lanes.ts';
import { createFailureRepository, createProblemRepository } from './failures.ts';
import { createHandoffRepository } from './handoffs.ts';
import { createItemSnapshotRepository } from './item-snapshots.ts';
import { createIssueGraphRepository } from './issue-graph.ts';
import { createWorkItemLedger } from './work-items.ts';
import { createVaultGrantRepository } from './vault-grants.ts';
import { createLoginRepository } from './logins.ts';
import { createLastAccountRepository } from './last-accounts.ts';
import { createPointedJobRepository } from './pointed-jobs.ts';
import { createDirectJobRepository } from './direct-jobs.ts';
import { createPromotionRepository } from './promotions.ts';
import { createGitHubListingRepository } from './github-listings.ts';
import { createSourceCallLog } from './source-calls.ts';
import { createGitHubOutboxRepository } from './github-outbox.ts';
import { createNotifierDeliveryRepository } from './notifier-deliveries.ts';
import { createCheckpointRepository } from './checkpoints.ts';
import { createJobLeaseRepository } from './job-leases.ts';
import { createOutboundSendRepository } from './outbound-sends.ts';
import { createSearchPendingRepository } from './search-pending.ts';
import { createGitHubWatchRepository } from './github-watches.ts';
import { createRepoChecksReadRepository } from './repo-checks.ts';
import { createIntakeArrivalRepository } from './intake-arrivals.ts'; import { createTokenLedgerRepository } from './token-ledger.ts'; import { createResourceLedgerRepository } from './resource-ledger.ts';
import { createDiskMeasureRepository } from './disk-measures.ts'; import { createDeliveryLedgerRepository } from './delivery-ledger.ts'; import { createStepScheduleRepository } from './step-schedules.ts'; import { createKeptTrackRepository } from './kept-tracks.ts'; import { createGradeRepository } from './grades.ts'; import { createCompletionReviewRepository } from './completion-reviews.ts';
import { createAppInstallationsReadRepository } from './app-installations.ts';
import { createReviewItemRepository } from './review-items.ts';
import { createQuestionRepository } from './questions.ts';
import { createUserSettingsRepository } from './settings.ts';
import { migrateTenant } from './tenant-migrations.ts';
import { createUsageHistoryRepository } from './usage-history.ts';
import { createMachineHistoryRepository } from './machine-history.ts';
import { createVaultRepository } from './vault.ts';
import { createWebhookRepository } from './webhooks.ts';
import { createCredentialAcceptanceRepository } from './machine-credentials.ts';
import { createWaitCheckLeases } from './wait-check-leases.ts';

/** The database URL with `?schema=<schema>`: the user schema, created when absent. */
export function schemaUrl(url: string, schema: string): string {
  const u = new URL(url);
  u.searchParams.set('schema', schema);
  return u.toString();
}

/** Open the store of the user schema `url` names (`?schema=`), migrated on the tenant track. */
export function openUserStore(o: { url: string; clock: Clock; idGen: IdGen }): UserStore {
  const db = openDb(o.url);
  try {
    migrateTenant(db);
  } catch (e) {
    db.close();
    throw e;
  }
  // eslint-disable-next-line prefer-const -- events and the job stream need ctx, ctx's commit needs them
  let events: ReturnType<typeof createEventLog>, jobStream: ReturnType<typeof createJobStreamRepository>;
  const ctx = createContext({
    db, clock: o.clock, idGen: o.idGen,
    onCommit: () => { events.flush(); jobStream.flush(); },
    onRollback: () => { events.discard(); jobStream.discard(); },
  });
  // The ledger moves in the transaction of the event or the issue graph read that moves it (issue #1067).
  const workItems = createWorkItemLedger(db, ctx.tx);
  events = createEventLog(ctx, ctx.inTx, workItems);
  jobStream = createJobStreamRepository(ctx);
  // Rebuilt when it missed an event: one the build before appended, or one a fold of users moved in (issue #1067).
  workItems.catchUp();
  const jobs = createJobRepository(ctx, (jobId, data) => events.append({ type: 'intake.stamped', jobId, data }));
  // The HTTP read routes' reads, off the event loop (issue #2392): the process's read pool, at this user's schema.
  const read = readDb(o.url);
  return {
    jobs,
    reads: { jobs: (filter) => jobs.listRead(read, filter), ...createInfraPlanReads(read), eventsBetween: eventsBetweenRead(read), memoryPeaks: memoryPeaksRead(read) },
    lanes: createLaneRepository(ctx),
    decisions: createDecisionRepository(ctx),
    events,
    eventCursors: createEventCursorRepository(ctx, events),
    webhooks: createWebhookRepository(ctx),
    vault: createVaultRepository(ctx),
    jobStream,
    artifacts: createArtifactRepository(ctx),
    infraPlans: createInfraPlanRepository(ctx),
    outOfBand: createOutOfBandRepository(ctx),
    topology: createTopologyRepository(ctx),
    skillLibrary: createSkillLibraryRepository(ctx),
    questions: createQuestionRepository(ctx),
    reviews: { proposal: createReviewItemRepository(ctx, 'proposal'), research: createReviewItemRepository(ctx, 'research') },
    logins: createLoginRepository(ctx),
    lastAccounts: createLastAccountRepository(ctx),
    failures: createFailureRepository(ctx),
    problems: createProblemRepository(ctx),
    handoffs: createHandoffRepository(ctx),
    itemSnapshots: createItemSnapshotRepository(ctx),
    vaultGrants: createVaultGrantRepository(ctx),
    bugReports: createBugReportRepository(ctx),
    issueGraph: createIssueGraphRepository(ctx, workItems),
    workItems,
    pointedJobs: createPointedJobRepository(ctx),
    directJobs: createDirectJobRepository(ctx),
    promotions: createPromotionRepository(ctx),
    githubListings: createGitHubListingRepository(ctx),
    githubOutbox: createGitHubOutboxRepository(ctx),
    githubWatches: createGitHubWatchRepository(ctx),
    sourceCalls: createSourceCallLog(ctx),
    repoChecks: createRepoChecksReadRepository(ctx),
    intakeArrivals: createIntakeArrivalRepository(ctx),
    appInstallations: createAppInstallationsReadRepository(ctx),
    checkpoints: createCheckpointRepository(ctx), tokenLedger: createTokenLedgerRepository(ctx), resourceLedger: createResourceLedgerRepository(ctx),
    jobLeases: createJobLeaseRepository(ctx),
    outboundSends: createOutboundSendRepository(ctx),
    notifierDeliveries: createNotifierDeliveryRepository(ctx),
    searchPending: createSearchPendingRepository(ctx),
    settings: createUserSettingsRepository(ctx),
    connectedAccounts: createConnectedAccountRepository(ctx),
    usageHistory: createUsageHistoryRepository(ctx),
    machineHistory: createMachineHistoryRepository(ctx), diskMeasures: createDiskMeasureRepository(ctx), deliveryLedger: createDeliveryLedgerRepository(ctx), stepSchedules: createStepScheduleRepository(ctx), keptTracks: createKeptTrackRepository(ctx), grades: createGradeRepository(ctx), completionReviews: createCompletionReviewRepository(ctx),
    config: createConfigRecords(ctx, USER_CONFIG),
    credentialAcceptances: createCredentialAcceptanceRepository(ctx),
    waitCheckLeases: createWaitCheckLeases(ctx),
    tx: ctx.tx,
    close: () => db.close(),
  };
}
