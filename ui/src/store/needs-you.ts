// Needs you's rows as the UI has them now (issue #897): the request cards Intake shows (issue #1193), what jobs on boxes wait for
// in the vault, the infra plans that wait for a person, the machines signed out of their agent tool (issue #1128), the machines not ready (issue #1248), the job sources not configured (issue #1243), the pull requests the hopper gave up on (issue #927), the checks read problems (issue #1244), the stuck landing passes (issue #1333), the tagged items (issue #1141), the pre-sort, and each section's badge by its one rule. The nav's badges and the Needs you page read these.
import { useMemo } from 'react';
import { plansWaiting } from '@/model/infra-plans';
import { requestsWaiting } from '@/model/intake';
import { needsYouRows, type NeedsYouRow } from '@/model/needs-you';
import { stuckLandingLines } from '@/model/landing-batches';
import { checksProblemLines, gaveUpLines } from '@/model/pull-requests';
import { notConfiguredLines } from '@/model/sources';
import { taggedWaiting } from '@/model/tagged';
import { signedOutLines } from '@/model/tool-accounts';
import { notReadyLines } from '@/model/machines';
import { accessRequestsWaiting } from '@/model/vault';
import { useHopper } from './index';
import { useInfraPlans, useLandingBatches, usePullRequestsView, useToolAccounts } from './polled';
import { useAwaitingSort, useSectionBadges, useServerNow } from './selectors';
import { useVault } from './vault';

export function useNeedsYou(): NeedsYouRow[] {
  const intake = useHopper((s) => requestsWaiting(s.sources));
  const access = accessRequestsWaiting(useVault());
  const plans = plansWaiting(useInfraPlans(), useServerNow());
  const accounts = useToolAccounts();
  const signedOut = useMemo(() => signedOutLines(accounts?.accounts ?? []), [accounts]);
  const machines = useHopper((s) => s.machines);
  const notReady = useMemo(() => notReadyLines(machines), [machines]);
  const sources = useHopper((s) => s.sources);
  const notConfigured = useMemo(() => notConfiguredLines(sources), [sources]);
  const view = usePullRequestsView();
  const gaveUp = useMemo(() => gaveUpLines(view), [view]);
  const checksUnread = useMemo(() => checksProblemLines(view), [view]);
  const landing = useLandingBatches();
  const stuckLanding = useMemo(() => stuckLandingLines(landing), [landing]);
  const tagged = useHopper((s) => taggedWaiting(s.sources));
  const sorting = useAwaitingSort();
  const sections = useSectionBadges();
  return useMemo(() => needsYouRows({ intake, access, plans, signedOut, notReady, notConfigured, gaveUp, checksUnread, stuckLanding, tagged, sorting, sections }), [intake, access, plans, signedOut, notReady, notConfigured, gaveUp, checksUnread, stuckLanding, tagged, sorting, sections]);
}
