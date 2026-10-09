// What a user's job sources learn of the user's store (design.md "Plugin contract"): which source keys have a
// local job, may be re-run or were rejected (issue #387), and, per source, the claim holder, the intake
// migration and intake events (issue #440), and the user's yolo mode (issue #579). The connected accounts are added by the runtime.
import type { JobSourceContext } from '../plugins/sdk.ts';
import type { UserStore } from '../domain/store.ts';
import { DEFAULT_YOLO_MODE, isRerunnable, yoloModeFor } from '../domain/types.ts';
import { rejectionOf } from '../domain/rejection.ts';

export function storeSourceContext(store: UserStore, otherUsersKnow?: (keys: string[]) => Set<string>): Omit<JobSourceContext, 'connectedAccounts'> {
  return {
    knownKeys: (keys) => new Set(keys.filter((k) => store.jobs.getBySourceKey(k))),
    rerunnable: (keys) => new Set(keys.filter((k) => { const j = store.jobs.getBySourceKey(k); return j !== undefined && isRerunnable(j); })),
    rejections: (keys) => new Map(keys.flatMap((k) => { const r = rejectionOf(store.jobs.getBySourceKey(k)); return r ? [[k, r] as const] : []; })),
    intake: (name) => ({
      holder: store.settings.claimHolder(),
      othersKnown: (keys) => otherUsersKnow?.(keys) ?? new Set(),
      migration: () => store.settings.getIntakeMigration(name),
      migrated: (m) => store.settings.setIntakeMigration(name, m),
      record: (type, data) => { store.events.append({ type, data }); },
    }),
    yoloMode: (repo) => yoloModeFor(store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, repo),
  };
}
