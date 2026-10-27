// Needs you's rows as the UI has them now (issue #897): the request cards Intake shows (issue #1193) and the labelled issues not assigned to the user (issue #1614) and the jobs a trust stamp holds (issue #655), what jobs on boxes wait for
// in the vault, the infra plans that wait for a person, the machines signed out of their agent tool (issue #1128), the machines not ready (issue #1248), the pull requests the hopper gave up on (issue #927), the checks read problems (issue #1244), the stuck landing passes (issue #1333), the tagged items (issue #1141), the step schedules whose last run failed (issue #2716), the hosts the jobs asked for (issue #2849), the bug-report recommendations that wait (issue #2846 part 2), the pre-sort, and each section's badge by its one rule. The nav's badges and the Needs you page read these.
import { useMemo } from 'react';
import { planWaitingLines, plansHigh, plansWaiting } from '@/model/infra-plans';
import { notAssignedWaiting, requestsWaiting } from '@/model/intake';
import { needsYouRows, type NeedsYouRow } from '@/model/needs-you';
import { stuckLandingLines } from '@/model/landing-batches';
import { checksProblemLines, gaveUpLines } from '@/model/pull-requests';
import { taggedWaiting } from '@/model/tagged';
import { trustHeldWaiting } from '@/model/trust';
import { signedOutLines } from '@/model/tool-accounts';
import { notReadyLines } from '@/model/machines';
import { budgetPausedLines } from '@/model/token-ledger';
import { accessRequestsHigh, accessRequestsWaiting, unknownAssetLines } from '@/model/vault';
import { useHopper } from './index';
import { failedScheduleLines } from '@/model/step-schedules';
import { openRecommendationLines } from '@/model/completion-review';
import { egressAskLines, isJobEgressView } from '@/model/job-egress';
import { useInfraPlans, useJobEgress, useLandingBatches, usePullRequestsView, useRecommendations, useStepSchedules, useToolAccounts } from './polled';
import { useAwaitingSort, useSectionBadges, useServerNow } from './selectors';
import { useVault } from './vault';

export function useNeedsYou(): NeedsYouRow[] {
  const intake = useHopper((s) => requestsWaiting(s.sources) + notAssignedWaiting(s.sources) + trustHeldWaiting(s.jobs));
  const vault = useVault();
  // Issues #2196, #2197: a job's run card counts while its job waits, and marks the badge when the job is high priority.
  const jobs = useHopper((s) => s.jobs);
  const threshold = useHopper((s) => s.highPriority);
  const access = accessRequestsWaiting(vault);
  const accessHigh = accessRequestsHigh(vault, jobs, threshold);
  const unknownAssets = useMemo(() => unknownAssetLines(vault), [vault]);
  const infraPlans = useInfraPlans();
  const now = useServerNow();
  // A sign-in about to end shows a day before (issue #1211), and a plan goes stale: read against the minute, not each tick.
  const minute = Math.floor(now / 60_000) * 60_000;
  const plans = plansWaiting(infraPlans, now);
  // Issue #2205: each plan that waits named; a high-priority job's marks the badge.
  const planLines = useMemo(() => planWaitingLines(infraPlans, minute), [infraPlans, minute]);
  const planHigh = plansHigh(infraPlans, now, jobs, threshold);
  const accounts = useToolAccounts();
  const signedOut = useMemo(() => signedOutLines(accounts?.accounts ?? [], minute), [accounts, minute]);
  const machines = useHopper((s) => s.machines);
  const notReady = useMemo(() => notReadyLines(machines), [machines]);
  const view = usePullRequestsView();
  const gaveUp = useMemo(() => gaveUpLines(view), [view]);
  const checksUnread = useMemo(() => checksProblemLines(view), [view]);
  const landing = useLandingBatches();
  const stuckLanding = useMemo(() => stuckLandingLines(landing), [landing]);
  const budgetPaused = useMemo(() => budgetPausedLines(Object.values(jobs)), [jobs]);
  const schedules = useStepSchedules();
  const failedSchedules = useMemo(() => failedScheduleLines(schedules), [schedules]);
  const recommendations = useRecommendations();
  const recommended = useMemo(() => openRecommendationLines(recommendations), [recommendations]);
  const egress = useJobEgress();
  const egressAsks = useMemo(() => egressAskLines(isJobEgressView(egress) ? egress : undefined), [egress]);
  const tagged = useHopper((s) => taggedWaiting(s.sources));
  const sorting = useAwaitingSort();
  const sections = useSectionBadges();
  return useMemo(() => needsYouRows({ intake, access, accessHigh, unknownAssets, egressAsks, plans, plansHigh: planHigh, planLines, signedOut, notReady, budgetPaused, gaveUp, checksUnread, stuckLanding, tagged, failedSchedules, recommended, sorting, sections }), [intake, access, accessHigh, unknownAssets, egressAsks, plans, planHigh, planLines, signedOut, notReady, budgetPaused, gaveUp, checksUnread, stuckLanding, tagged, failedSchedules, recommended, sorting, sections]);
}
