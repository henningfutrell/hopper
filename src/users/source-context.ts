// What a user's job sources learn of the user's store (design.md "Plugin contract"): which source keys have a
// local job, may be re-run or were rejected (issue #387), and, per source, the claim holder, the intake
// migration and intake events (issue #440), the user's intake trust (issue #652), the user's yolo mode (issue #579), a job's artifacts (issue #673), and the issue graph (issue #437).
// With the user's work dir, the user's mirrors of the job repositories too (issue #858, `<work dir>/git-mirrors`). The connected accounts are added by the runtime.
import type { JobSourceContext } from '../plugins/sdk.ts';
import type { UserStore } from '../domain/store.ts';
import { DEFAULT_YOLO_MODE, isRerunnable, yoloModeFor } from '../domain/types.ts';
import { rejectionOf } from '../domain/rejection.ts';
import { storeIntakeTrust, type DecideIntakeActor } from './intake-trust.ts';
import { join } from 'node:path';
import { createGitMirrors } from '../git-mirror/mirrors.ts';

const EPOCH = '1970-01-01T00:00:00.000Z';

export function storeSourceContext(store: UserStore, otherUsersKnow: ((keys: string[]) => Set<string>) | undefined, decideActor: DecideIntakeActor | undefined,
  mirrors?: { dataDir: string; logger: { warn(line: string): void } }): Omit<JobSourceContext, 'connectedAccounts'> {
  return {
    ...(mirrors ? { gitMirrors: createGitMirrors({ dir: join(mirrors.dataDir, 'git-mirrors'), log: (line) => mirrors.logger.warn(line) }) } : {}),
    knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
    rerunnable: (keys) => new Set(keys.filter((k) => { const j = store.jobs.getBySourceKey(k); return j !== undefined && isRerunnable(j); })),
    rejections: (keys) => new Map(keys.flatMap((k) => { const r = rejectionOf(store.jobs.getBySourceKey(k)); return r ? [[k, r] as const] : []; })),
    intake: (name) => ({
      holder: store.settings.claimHolder(),
      othersKnown: (keys) => otherUsersKnow?.(keys) ?? new Set(),
      migration: () => store.settings.getIntakeMigration(name),
      migrated: (m) => store.settings.setIntakeMigration(name, m),
      record: (type, data) => { store.events.append({ type, data }); },
      requestOpened: (key, hash) => store.events.between(['source.request_opened'], EPOCH).some((e) => e.data.source === name && e.data.key === key && e.data.hash === hash),
    }),
    intakeTrust: storeIntakeTrust(store, decideActor),
    yoloMode: (repo) => yoloModeFor(store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, repo),
    issueGraph: store.issueGraph,
    jobArtifacts: (jobId) => store.artifacts.list({ jobId }).map((a) => ({ id: a.id, ...(a.issue ? { issue: a.issue.url } : {}) })),
  };
}
