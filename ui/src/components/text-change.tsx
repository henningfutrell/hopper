// The card of a job held because its item's text changed since the snapshot (issue #662): what changed — the title, the
// body line by line, the new assignee comments —, who edited it, and the three ways on: Rerun the original, Accept the new
// text (the owner only: the hopper asks Access, and says no for anyone else), or Cancel.
import { diffLines } from 'diff';
import { Check, RotateCcw } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { newCommentsOf } from '@/model/text-change';
import { act } from '@/store';
import { useCanOperate } from '@/store/selectors';
import type { Job } from '@/model/wire';
import { Since } from './job';

/** The body's change, line by line: removed lines, then added ones, in place. */
function BodyDiff({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => diffLines(from, to), [from, to]);
  return (
    <pre data-slot="body-diff" className="max-h-64 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
      {parts.map((p, i) => (
        <span key={i} data-change={p.added ? 'added' : p.removed ? 'removed' : 'same'}
          className={p.added ? 'bg-ok/15 text-ok' : p.removed ? 'bg-bad/15 text-bad line-through' : 'text-muted-foreground'}>
          {p.value}
        </span>
      ))}
    </pre>
  );
}

export function TextChangeCard({ job }: { job: Job }) {
  const operate = useCanOperate();
  const change = job.textChange;
  if (!change) return null;
  const added = newCommentsOf(change);
  const editors = [...new Set(change.edits.map((e) => e.editor))];
  return (
    <div data-slot="text-change" className="space-y-2 rounded-md border border-warn/40 bg-warn/5 p-3 text-xs">
      <div className="font-medium text-foreground/90">
        Its item changed since the text it was approved with. It does not run the new text unless the owner accepts it.
      </div>
      <div className="text-muted-foreground">
        {editors.length > 0
          ? <>edited by <span data-slot="editors" className="font-medium text-foreground/90">{editors.join(', ')}</span>, last <Since iso={change.edits.at(-1)!.at} /> ago</>
          : 'who edited it is not known'}
      </div>
      {change.from.title !== change.to.title && (
        <div data-slot="title-change">
          title: <span className="text-bad line-through">{change.from.title}</span> → <span className="text-ok">{change.to.title}</span>
        </div>
      )}
      {change.from.body !== change.to.body && <BodyDiff from={change.from.body} to={change.to.body} />}
      {added.length > 0 && (
        <div data-slot="new-comments" className="space-y-1">
          <div className="text-muted-foreground">new comments, not in the prompt unless the owner accepts the new text:</div>
          {added.map((c) => (
            <div key={`${c.author}-${c.at}`} className="rounded border bg-background/60 p-1.5"><span className="font-medium">{c.author}</span>: {c.body}</div>
          ))}
        </div>
      )}
      {operate && (
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" title="It runs the text it was approved with. This edit no longer holds it."
            onClick={() => act(`/ui/api/jobs/${job.id}/keep-original`, {}, 'It runs the original text')}><RotateCcw />Rerun the original</Button>
          <Button size="xs" variant="outline" title="The owner only: the new text is the approved text from now on, and the job runs it."
            onClick={() => act(`/ui/api/jobs/${job.id}/accept-new-text`, {}, 'New text accepted')}><Check />Accept the new text</Button>
        </div>
      )}
    </div>
  );
}
