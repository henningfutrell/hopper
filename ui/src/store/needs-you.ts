// Needs you's rows as the UI has them now (issue #897): the request cards across the sources, what jobs on boxes wait for
// in the vault, the infra plans that wait for an admin, the pull requests with merge conflicts, the pre-sort, and each section's badge by its one rule. The nav's badges and the Needs you page read these.
import { useMemo } from 'react';
import { plansWaiting } from '@/model/infra-plans';
import { requestsWaiting } from '@/model/intake';
import { needsYouRows, type NeedsYouRow } from '@/model/needs-you';
import { conflictedPullRequests } from '@/model/pull-requests';
import { accessRequestsWaiting } from '@/model/vault';
import { useHopper } from './index';
import { useInfraPlans, usePullRequestsView } from './polled';
import { useAwaitingSort, useSectionBadges, useServerNow } from './selectors';
import { useVault } from './vault';

export function useNeedsYou(): NeedsYouRow[] {
  const intake = useHopper((s) => requestsWaiting(s.sources));
  const access = accessRequestsWaiting(useVault());
  const plans = plansWaiting(useInfraPlans(), useServerNow());
  const conflicts = conflictedPullRequests(usePullRequestsView());
  const sorting = useAwaitingSort();
  const sections = useSectionBadges();
  return useMemo(() => needsYouRows({ intake, access, plans, conflicts, sorting, sections }), [intake, access, plans, conflicts, sorting, sections]);
}
