// Needs you's rows as the UI has them now (issue #897): the request cards across the sources, what jobs on boxes wait for
// in the vault, the pre-sort, and each section's badge by its one rule. The nav's badges and the Needs you page read these.
import { useMemo } from 'react';
import { requestsWaiting } from '@/model/intake';
import { needsYouRows, type NeedsYouRow } from '@/model/needs-you';
import { accessRequestsWaiting } from '@/model/vault';
import { useHopper } from './index';
import { useAwaitingSort, useSectionBadges } from './selectors';
import { useVault } from './vault';

export function useNeedsYou(): NeedsYouRow[] {
  const intake = useHopper((s) => requestsWaiting(s.sources));
  const access = accessRequestsWaiting(useVault());
  const sorting = useAwaitingSort();
  const sections = useSectionBadges();
  return useMemo(() => needsYouRows({ intake, access, sorting, sections }), [intake, access, sorting, sections]);
}
