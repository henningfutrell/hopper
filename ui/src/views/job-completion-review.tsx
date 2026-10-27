// A job's completion review on its job view (issue #2846): GET /api/jobs/:id/completion-review, read again as the job's
// state changes. Where its time went, what went well, where it stalled, its restarts and waste signals, and the changes that
// would have helped. Nothing shows until the hopper kept a review: a job that runs, or that the settings skip, has none.
import { ClipboardCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Panel } from '@/components/panel';
import { get } from '@/lib/api';
import { AREA_NAMES, durationText, OUTCOME_NAMES, restartLine, STAGE_NAMES } from '@/model/completion-review';
import { WASTE_NAMES } from '@/model/token-ledger';
import type { CompletionReview, Job } from '@/model/wire';

function List({ title, slot, lines }: { title: string; slot: string; lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="list-disc pl-5">{lines.map((l) => <li key={l} data-slot={slot}>{l}</li>)}</ul>
    </div>
  );
}

export function JobCompletionReview({ job }: { job: Job }) {
  const [review, setReview] = useState<CompletionReview | null>(null);
  useEffect(() => {
    let gone = false;
    get<{ review?: CompletionReview }>(`/api/jobs/${encodeURIComponent(job.id)}/completion-review`)
      .then((v) => { if (!gone) setReview(v?.review ?? null); }, () => { if (!gone) setReview(null); });
    return () => { gone = true; };
  }, [job.id, job.status]);
  if (!review) return null;
  return (
    <Panel title="Completion review" icon={ClipboardCheck} bodyClassName="space-y-2 p-3 text-sm">
      <div data-slot="completion-review-head">
        <span className="font-medium">{OUTCOME_NAMES[review.outcome]}</span> after {durationText(review.durationMs)}
        {review.jobs > 1 && <> · job of a work item that took {review.jobs} jobs</>}
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {review.stages.map((s) => <span key={s.stage} data-slot="completion-review-stage">{STAGE_NAMES[s.stage]}: {durationText(s.ms)}</span>)}
      </div>
      <List title="What went well" slot="completion-review-went" lines={review.went} />
      <List title="Where it stalled" slot="completion-review-stall" lines={review.stalls} />
      <List title="Restarts" slot="completion-review-restart" lines={review.restarts.map(restartLine)} />
      <List title="Waste signals" slot="completion-review-waste" lines={review.waste.map((w) => `${WASTE_NAMES[w.kind]}: ${w.why}`)} />
      <List title="What would have helped" slot="completion-review-suggestion" lines={review.suggestions.map((s) => `${AREA_NAMES[s.area]}: ${s.text}`)} />
    </Panel>
  );
}
