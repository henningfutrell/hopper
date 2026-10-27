// Reads of the daemon that the nav, Needs you and the header share (issue #897): the pull requests, the infra plans, the
// out-of-band changes (issue #871), yolo mode, the header badges (issue #1181), and the pending approvals (issue #2088), the job egress asks (issue #2849). Each path is read once when first used, again every POLL_MS while anything shows it, and again after an event
// whose type starts with one of the given prefixes. A failed read keeps the last answer; until one comes, there is none.
import { useEffect } from 'react';
import { create } from 'zustand';
import { get } from '@/lib/api';
import type { PendingApprovalsView } from '../../../src/domain/types.ts';
import type { StepSchedulesView } from '../../../src/domain/step-schedules.ts';
import type { BugReportRecommendation } from '../../../src/domain/review-defects.ts';
import type { JobEgressView } from '@/model/job-egress';
import type { HeaderBadgeSettings, LandingBatchesView, OutOfBandView, PlanView, PullRequestsView, ToolAccountsReport, YoloModeView } from '@/model/wire';
import { useHopper } from './index';

const POLL_MS = 30_000;

const usePolledStore = create<Record<string, unknown>>(() => ({}));

/** Keeps an answer a page got by itself (a save, its own read), so the shared one is not older than what it shows. */
export const setPolled = (path: string, v: unknown): void => usePolledStore.setState({ [path]: v });

const read = (path: string): void => { get<unknown>(path).then((v) => setPolled(path, v), () => {}); };

const users = new Map<string, { n: number; timer: ReturnType<typeof setInterval> }>();

const NO_EVENTS: readonly string[] = [];

function usePolled<T>(path: string, events: readonly string[] = NO_EVENTS): T | undefined {
  const authed = useHopper((s) => s.authed);
  const lastChange = useHopper((s) => s.events.find((e) => events.some((p) => e.type.startsWith(p)))?.id);
  useEffect(() => {
    if (!authed) return undefined;
    let u = users.get(path);
    if (!u) { read(path); u = { n: 0, timer: setInterval(() => read(path), POLL_MS) }; users.set(path, u); }
    const mine = u;
    mine.n += 1;
    return () => { mine.n -= 1; if (mine.n === 0) { clearInterval(mine.timer); users.delete(path); } };
  }, [path, authed]);
  // An event that changes the answer reads it again; the first render reads it above.
  useEffect(() => { if (authed && lastChange !== undefined) read(path); }, [path, authed, lastChange]);
  return usePolledStore((s) => s[path]) as T | undefined;
}

/** The shared reads, each with the events after which it is read again: a plan recorded or approved at once (issue #2205). */
export const usePullRequestsView = (): PullRequestsView | undefined => usePolled('/api/pull-requests', ['job.pull_request_', 'yolo_mode.']);
export const useInfraPlans = (): { plans: PlanView[] } | undefined => usePolled('/api/infra-plans', ['infra.plan_']);
export const useOutOfBand = (): { changes: OutOfBandView[] } | undefined => usePolled('/api/out-of-band', ['infra.out_of_band_']);
export const useYoloMode = (): YoloModeView | undefined => usePolled('/api/yolo-mode', ['yolo_mode.']);
/** The landing batches (issue #1333): Needs you's stuck landing passes. What is stuck is found by the pass, with no event: polled. */
export const useLandingBatches = (): LandingBatchesView | undefined => usePolled('/api/landing-batches', ['landing_batch.']);
/** The job egress allowlist (issue #2849 part 3): Needs you's egress hosts, read again after a denial or a change. */
export const useJobEgress = (): JobEgressView | undefined => usePolled('/api/job-egress', ['job.egress_denied', 'job_egress.']);
/** The step schedules (issue #2716): Needs you's failed scheduled runs, read again after each schedule's event. */
export const useStepSchedules = (): StepSchedulesView | undefined => usePolled('/api/step-schedules', ['step_schedule.']);
/** The bug-report recommendations that wait (issue #2846 part 2): Needs you's Bug reports row, read again after each one's event. */
export const RECOMMENDATIONS_PATH = '/api/completion-review/recommendations?state=open';
export const useRecommendations = (): { recommendations: BugReportRecommendation[] } | undefined => usePolled(RECOMMENDATIONS_PATH, ['completion_review.recommend']);
/** Pending approvals (issue #2088): the page and its nav count. The daemon reads GitHub on its own schedule, with no event: polled only. */
export const usePendingApprovals = (): PendingApprovalsView | undefined => usePolled('/api/pending-approvals');
/** The tool accounts (issue #1128): the Accounts view and its badge. A usage source reads with no event: polled only. */
export const useToolAccounts = (): ToolAccountsReport | undefined => usePolled('/api/tool-accounts');
/** The header badges the user chose (issue #1181): saved with no event, so a save keeps its answer (`setPolled`). */
export const HEADER_BADGES_PATH = '/api/header-badges';
export const useHeaderBadges = (): HeaderBadgeSettings | undefined => usePolled(HEADER_BADGES_PATH);
