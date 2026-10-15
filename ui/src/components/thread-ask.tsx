// A question's place on its issue thread (issue #435), on its card and its Parked row: held for review, with Approve for
// a person who operates; approved; or asked, with the link to the comment. A Marker, as who answered is (issue #1169).
import { MessagesSquare, Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { cn } from '@/lib/utils';
import { awaitsThreadReview, threadLine } from '@/model/thread-ask';
import type { QuestionView } from '@/model/wire';
import { act, refreshQuestions } from '@/store';
import { useCanOperate } from '@/store/selectors';

export function ThreadState({ q, className }: { q: QuestionView; className?: string }) {
  const canOperate = useCanOperate();
  const [busy, setBusy] = useState(false);
  const line = threadLine(q);
  if (!line) return null;
  const approve = async () => {
    setBusy(true);
    await act(`/ui/api/questions/${encodeURIComponent(q.id)}/thread-approve`, {}, 'Approved: the question goes on the issue thread');
    setBusy(false);
    refreshQuestions().catch(() => {});
  };
  return (
    <Marker data-thread-state className={cn('flex-wrap text-xs', className)}>
      <MarkerIcon><MessagesSquare className="size-3.5" /></MarkerIcon>
      <MarkerContent>{line}</MarkerContent>
      {q.thread?.url && <a href={q.thread.url} target="_blank" rel="noreferrer">See the comment</a>}
      {canOperate && awaitsThreadReview(q) && <Button size="xs" variant="outline" disabled={busy} onClick={() => void approve()}><Send />Post on the issue</Button>}
    </Marker>
  );
}
