// Needs you's rows as the UI has them now (issue #897): the request cards Intake shows (issue #1193) and the labelled issues not assigned to the user (issue #1614) and the jobs a trust stamp holds (issue #655), what jobs on boxes wait for
// in the vault, the infra plans that wait for a person, the machines signed out of their agent tool (issue #1128), the machines not ready (issue #1248), the pull requests the hopper gave up on (issue #927), the checks read problems (issue #1244), the stuck landing passes (issue #1333), the tagged items (issue #1141), the pre-sort, and each section's badge by its one rule. The nav's badges and the Needs you page read these.
import { useMemo } from 'react';
import { plansWaiting } from '@/model/infra-plans';
import { notAssignedWaiting, requestsWaiting } from '@/model/intake';
import { needsYouRows, type NeedsYouRow } from '@/model/needs-you';
import { stuckLandingLines } from '@/model/landing-batches';
import { checksProblemLines, gaveUpLines } from '@/model/pull-requests';
import { taggedWaiting } from '@/model/tagged';
import { trustHeldWaiting } from '@/model/trust';
import { signedOutLines } from '@/model/tool-accounts';
import { notReadyLines } from '@/model/machines';
import { accessRequestsWaiting } from '@/model/vault';
import { useHopper } from './index';
import { useInfraPlans, useLandingBatches, usePullRequestsView, useToolAccounts } from './polled';
import { useAwaitingSort, useSectionBadges, useServerNow } from './selectors';
import { useVault } from './vault';

export function useNeedsYou(): NeedsYouRow[] {
  const intake = useHopper((s) => requestsWaiting(s.sources) + notAssignedWaiting(s.sources) + trustHeldWaiting(s.jobs));
  const access = accessRequestsWaiting(useVault());
  const plans = plansWaiting(useInfraPlans(), useServerNow());
  const accounts = useToolAccounts();
  const now = useServerNow();
  // A sign-in about to end shows a day before (issue #1211): read against the minute, not each tick.
  const minute = Math.floor(now / 60_000) * 60_000;
  const signedOut = useMemo(() => signedOutLines(accounts?.accounts ?? [], minute), [accounts, minute]);
  const machines = useHopper((s) => s.machines);
  const notReady = useMemo(() => notReadyLines(machines), [machines]);
  const view = usePullRequestsView();
  const gaveUp = useMemo(() => gaveUpLines(view), [view]);
  const checksUnread = useMemo(() => checksProblemLines(view), [view]);
  const landing = useLandingBatches();
  const stuckLanding = useMemo(() => stuckLandingLines(landing), [landing]);
  const tagged = useHopper((s) => taggedWaiting(s.sources));
  const sorting = useAwaitingSort();
  const sections = useSectionBadges();
  return useMemo(() => needsYouRows({ intake, access, plans, signedOut, notReady, gaveUp, checksUnread, stuckLanding, tagged, sorting, sections }), [intake, access, plans, signedOut, notReady, gaveUp, checksUnread, stuckLanding, tagged, sorting, sections]);
}
