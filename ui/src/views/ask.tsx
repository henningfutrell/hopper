// Ask hopper (issue #2375), one view (#ask) in place of Direct jobs and Direct queries, and a merged page (issue #2374,
// page-tabs.tsx) with two tabs: Run a job (#ask/direct-jobs, a direct job, direct-jobs.tsx) and Ask a question
// (#ask/direct-queries, a direct query, direct-queries.tsx). The old links #direct-jobs and #direct-queries, and
// #ask/question, open the matching tab (routes.ts canonicalHash). The tab labels are PAGE_TABS's (routes.ts).
import { PageTabs } from '@/app/page-tabs';
import { DirectJobs } from '@/views/direct-jobs';
import { DirectQueries } from '@/views/direct-queries';

/** The view of each tab, by the tab's id: the view it was before Ask hopper. */
const TAB_VIEWS = {
  'direct-jobs': DirectJobs,
  'direct-queries': DirectQueries,
};

/** Ask hopper: the tab strip, then the tab the hash names, else Run a job. */
export function AskHopper() {
  return (
    <PageTabs
      page="ask"
      views={TAB_VIEWS}
    />
  );
}
