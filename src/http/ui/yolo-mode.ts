// Yolo mode (issue #579, design.md "Done is a pull request"): whether jobs may merge their own pull requests once the
// repo's checks pass. Off unless an admin turns it on, for every job repository or per repository; read each time a
// job's prompt is built, so it applies to the next job without a restart. Done never depends on it. Since issue #637 the
// hopper also merges a ready pull request it follows itself, in a repository with yolo mode on; the Pull requests list
// shows each waiting one with its repository's yolo mode.
// Change kinds (issue #1076, design.md "Change kinds"): the change-kind rules are saved with yolo mode, whole
// (`changeKinds`, `null` for the built-in rule): globs, content expressions — each must compile — and each kind's merge gate.
import { everyJobRepository } from '../../domain/job-repositories.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CHANGE_KINDS, DEFAULT_YOLO_MODE, MERGE_GATES, patchYoloMode, pullRequestList, yoloChoices, type PullRequestsView, type YoloModeSettings, type YoloModeView } from '../../domain/types.ts';
import type { UserStore } from '../../domain/store.ts';
import { landingCards } from '../../domain/work-item-landing.ts';
import type { UntrackedPullRequest } from '../../domain/untracked-pull-requests.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const repoName = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200);
const compiles = (s: string): boolean => { try { new RegExp(s, 'i'); return true; } catch { return false; } };
const globs = z.array(z.string().min(1).max(200)).max(200).optional();
/** A change rule's change (issue #1076): each list it names replaces the list, each gate it names that gate. */
export const changeRulePatch = z.strictObject({
  docs: globs, tests: globs, lowRisk: globs, sensitive: globs,
  sensitiveContent: z.array(z.string().min(1).max(200).refine(compiles, 'a regular expression')).max(50).optional(),
  merge: z.partialRecord(z.enum(CHANGE_KINDS), z.enum(MERGE_GATES)).optional(),
});
export const changeKindsBody = z.strictObject({ default: changeRulePatch.optional(), repos: z.record(repoName, changeRulePatch).optional() });

/** Any part; `repos` sets each named repository on or off, or `null` to follow `on` again; `changeKinds` the rules, whole. */
export const yoloModeBody = z.strictObject({
  on: z.boolean().optional(),
  repos: z.record(repoName, z.boolean().nullable()).optional(),
  changeKinds: changeKindsBody.nullable().optional(),
}).refine((b) => b.on !== undefined || b.repos !== undefined || b.changeKinds !== undefined, { message: 'name on, repos or changeKinds' });

const settingsOf = (store: UserStore): YoloModeSettings => store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE;

export function yoloModeView(t: Pick<TenantParts, 'store'>): YoloModeView {
  return { ...settingsOf(t.store), choices: yoloChoices(everyJobRepository(t.store)) };
}

/**
 * The Pull requests list (issue #637): every waiting pull request of the user's jobs, per job repository, with its yolo mode;
 * the Landing list (issue #1073): the merged ones on their way from the landing branch to the tested branch, from the ledger;
 * and the untracked pull requests (issue #1176): what each source's last census found, each with why.
 */
export function pullRequestsView(t: Pick<TenantParts, 'store' | 'registry'>): PullRequestsView {
  const { store } = t;
  const now = Date.now();
  const view = pullRequestList(store.jobs.list({ status: ['finished', 'failed'], followed: true }), (key) => store.jobs.getBySourceKey(key), settingsOf(store), everyJobRepository(store), now, (id) => store.jobs.get(id));
  const landing = landingCards(store.workItems.list({ landing: true }), now);
  const untracked = t.registry.statuses().flatMap((s) => ((s.detail?.untrackedPullRequests ?? []) as UntrackedPullRequest[]).map((u) => ({ ...u, source: s.name })));
  return { ...view, ...(landing.length > 0 ? { landing } : {}), ...(untracked.length > 0 ? { untracked } : {}) };
}

export function registerYoloModeRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/yolo-mode', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change yolo mode');
    const t = o.tenant(req);
    const patch = parseWith(yoloModeBody, req.body);
    t.store.tx(() => {
      const from = settingsOf(t.store);
      const to = patchYoloMode(from, patch);
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setYoloMode(to);
      t.store.events.append({ type: 'yolo_mode.changed', data: { from, to, by: personOf(s) } });
    });
    return yoloModeView(t);
  });
}
