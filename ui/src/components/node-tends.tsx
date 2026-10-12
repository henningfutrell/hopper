// A pull request's tend attempts in the job graph's node details (issue #927): each tend, oldest first, linked to its job,
// with how long it ran or runs.
import { elapsed } from '@/model/format';
import { jobHref } from '@/model/job';
import { tendText } from '@/model/jobs-view';
import type { JobGraphTend } from '@/model/wire';

export function NodeTends({ tends, now }: { tends: readonly JobGraphTend[]; now: number }) {
  return (
    <ol data-slot="graph-node-tends" aria-label="tend attempts" className="space-y-0.5 border-l pl-2 text-muted-foreground">
      {tends.map((t) => (
        <li key={t.jobId} title={[t.startedAt && `started ${t.startedAt}`, t.endedAt && `ended ${t.endedAt}`].filter(Boolean).join(', ') || undefined}>
          <a href={jobHref(t.jobId)} className="underline-offset-4 hover:underline">{tendText(t)}</a>
          {t.startedAt && <span> · {elapsed(t.startedAt, t.endedAt ? Date.parse(t.endedAt) : now)}</span>}
        </li>
      ))}
    </ol>
  );
}
