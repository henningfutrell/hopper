// What a user's job sources learn of the user's store (design.md "Plugin contract"): which source keys have a
// local job, may be re-run or were rejected (issue #387), and, per source, the claim holder, the intake
// migration and intake events (issue #440), the user's intake trust (issue #652), the user's yolo mode (issue #579), a job's artifacts (issue #673), the issue graph (issue #437), each read named to search (issue #945), and the listing cache (issue #985).
// With the user's work dir, the user's mirrors of the job repositories too (issue #858, `<work dir>/git-mirrors`). The connected accounts are added by the runtime.
import { allowedDeletesOfJob, doneCriteriaOfJob } from '../skill-library/index.ts';
import type { JobSourceContext } from '../plugins/sdk.ts';
import type { UserStore } from '../domain/store.ts';
import type { SweepLease } from '../domain/leases.ts';
import { everyJobRepository } from '../domain/job-repositories.ts';
import { DEFAULT_YOLO_MODE, isRerunnable, mergeRuleFor, yoloModeFor, type Parts } from '../domain/types.ts';
import { landingBranch } from '../domain/landing-batches.ts';
import { rejectionOf } from '../domain/rejection.ts';
import { requestsWaitingOf } from '../domain/work-items.ts';
import { awaitsBatch, promotedOpen } from '../domain/work-item-landing.ts';
import { itemHistory, requestOpenedSince } from '../domain/intake.ts';
import { storeIntakeTrust, type DecideIntakeActor } from './intake-trust.ts';
import { join } from 'node:path';
import { createGitMirrors } from '../git-mirror/mirrors.ts';
import { graphKeys } from '../search/index.ts';
import { allPartsDone } from '../sources/github/parts.ts';

const EPOCH = '1970-01-01T00:00:00.000Z';

export function storeSourceContext(store: UserStore, otherUsersKnow: ((keys: string[]) => Set<string>) | undefined, decideActor: DecideIntakeActor | undefined,
  mirrors?: { dataDir: string; logger: { warn(line: string): void } }, graphRead?: (keys: string[]) => void, clock: () => Date = () => new Date(),
  lease?: (name: string) => SweepLease): Omit<JobSourceContext, 'connectedAccounts'> {
  return {
    ...(mirrors ? { gitMirrors: createGitMirrors({ dir: join(mirrors.dataDir, 'git-mirrors'), log: (line) => mirrors.logger.warn(line) }) } : {}),
    knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
    rerunnable: (keys) => new Set(keys.filter((k) => { const j = store.jobs.getBySourceKey(k); return j !== undefined && isRerunnable(j); })),
    rejections: (keys) => new Map(keys.flatMap((k) => { const r = rejectionOf(store.jobs.getBySourceKey(k)); return r ? [[k, r] as const] : []; })),
    intake: (name) => ({
      // The label mirror on one hopper of those on one database (issue #1892): the holder of the user's sweep lease `label-mirror/<source>`.
      ...(lease ? { mirrorHeld: ((l) => () => l.hold().held)(lease(`label-mirror/${name}`)) } : {}),
      holder: store.settings.claimHolder(),
      othersKnown: (keys) => otherUsersKnow?.(keys) ?? new Set(),
      migration: () => store.settings.getIntakeMigration(name),
      migrated: (m) => store.settings.setIntakeMigration(name, m),
      record: (type, data) => { store.events.append({ type, data }); },
      // Opened with this text since its last withdraw or approval (issues #1067 part 4, #1126): a card back in Intake opens again.
      requestOpened: (key, hash) => requestOpenedSince(
        store.events.between(['source.request_opened', 'source.request_withdrawn', 'source.request_approved', 'source.request_auto_approved'], EPOCH).filter((e) => e.data.source === name && e.data.key === key), hash),
      requestsWaiting: () => requestsWaitingOf(store.workItems.list({ state: ['waiting_for_approval'] }), name),
      tagged: { get: () => store.settings.getTaggedRecord(name), set: (r) => store.settings.setTaggedRecord(name, r) },
      history: (key) => itemHistory(store.jobs.getBySourceKey(key), (id) => store.jobs.get(id), store.workItems.get(key)?.pullRequest),
      // Merged into the landing branch, its batch run not yet on the tested branch (issue #1175): no reopened card.
      awaitsBatch: (key) => awaitsBatch(store.workItems.get(key), (repo) => store.settings.getLandingBatches()?.repos[repo] !== undefined, clock().getTime()),
      // Promoted with its batch, its issue still open (issue #1232): the sync closes it, once.
      // Its end labels mirror its state (issue #1891, the label mirror).
      workItem: (key) => store.workItems.get(key),
      // Its job follows a part (issue #1933): PR open's waiting label is `hopper:partly-done`.
      partOpen: (key) => {
        const id = store.workItems.get(key)?.jobId;
        const job = id === undefined ? undefined : store.jobs.get(id);
        return job?.partlyDone !== undefined || job?.sourceState?.source?.part === true;
      },
      // Its job's failure reported as failed (issue #1892): `hopper:failed` is its label, not while the hopper fixes it (issue #1230).
      failureReported: (key) => {
        const id = store.workItems.get(key)?.jobId;
        const job = id === undefined ? undefined : store.jobs.get(id);
        const sync = (job?.sourceState?.sync ?? {}) as { finalReported?: boolean; fixingReported?: boolean };
        return job?.status === 'failed' && sync.finalReported === true && sync.fixingReported !== true;
      },
      // Its part merged with parts left (issue #1892): no end label, Intake takes it again; not a last part that made all done.
      partsLeft: (key) => {
        const id = store.workItems.get(key)?.jobId;
        const s = (id === undefined ? undefined : store.jobs.get(id))?.sourceState?.source as { follow?: string; part?: boolean; parts?: Parts } | undefined;
        return s?.follow === 'merged' && s.part === true && !allPartsDone(s.parts);
      },
      promotedOpen: (key) => promotedOpen(store.workItems.get(key), (repo) => store.settings.getLandingBatches()?.repos[repo] !== undefined),
    }),
    intakeTrust: storeIntakeTrust(store, decideActor),
    ...pullRequestSettings(store),
    // Each read kept names its issues and pull requests to search (issue #945), once the store has it.
    issueGraph: {
      record: (issue, graph, readAt) => { store.issueGraph.record(issue, graph, readAt); graphRead?.(graphKeys(graph)); },
      lastRead: (issue) => store.issueGraph.lastRead(issue),
    },
    githubListings: store.githubListings,
    githubOutbox: store.githubOutbox,
    jobArtifacts: (jobId) => store.artifacts.list({ jobId }).map((a) => ({ id: a.id, ...(a.issue ? { issue: a.issue.url } : {}) })),
    jobDoneCriteria: (jobId) => doneCriteriaOfJob(store, jobId),
    jobAllowedDeletes: (jobId) => allowedDeletesOfJob(store, jobId),
  };
}

/**
 * The user's settings a followed pull request is merged and moved by: yolo mode, the landing branch, the change rule. On a
 * repository the hopper does not work on, only that repository named on in yolo mode merges (issue #1806).
 */
export const pullRequestSettings = (store: UserStore) => ({
  yoloMode: (repo: string): boolean => yoloModeFor(store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, repo, everyJobRepository(store)),
  // The landing batch setting's, never GitHub's default branch (issues #1142, #1143).
  landingBranch: (repo: string): string | undefined => { const cfg = store.settings.getLandingBatches()?.repos[repo.toLowerCase()]; return cfg && landingBranch(cfg); },
  changeRule: (repo: string) => mergeRuleFor(store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, repo, everyJobRepository(store)),
});
