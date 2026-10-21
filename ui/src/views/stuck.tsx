// Stuck work (issue #1010, design.md "Stuck work"): first in Failures, every item that waits on a person — a hand-off, a
// failure, work not pushed, a pull request the hopper gave up on, a parked job, a job stuck on its own wait — counted by
// its stuck cause. A cause the hopper acts on in bulk has one button, asked first; else it says what a person does.
// Shown only when some work is stuck.
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import type { StuckCause } from '@/model/wire';
import { stuckAct } from '@/store/stuck';
import { useCanOperate } from '@/store/selectors';

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/** One cause: its count, what it is, and its bulk action — asked first — or what a person does. */
function StuckRow({ c }: { c: StuckCause }) {
  const canAct = useCanOperate();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await stuckAct(c.cause);
    setBusy(false);
  };
  return (
    <li data-stuck={c.cause} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
      <span className="num w-8 shrink-0 text-right text-sm font-semibold">{c.ids.length}</span>
      <span className="min-w-0 flex-1 text-sm">{c.what}</span>
      {c.act && canAct && (
        <AlertDialog>
          <AlertDialogTrigger asChild><Button size="sm" disabled={busy}>{c.act}</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{c.act}?</AlertDialogTitle>
              <AlertDialogDescription>
                The hopper does this for {items(c.ids.length)}: {c.what.toLowerCase()}. Each goes the same way as its own button. An item that cannot go now is skipped, and the hopper says why.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep them</AlertDialogCancel>
              <AlertDialogAction onClick={() => void run()}>{c.act}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {c.todo && <span data-slot="stuck-todo" className="basis-full pl-11 text-xs text-muted-foreground">{c.todo}</span>}
    </li>
  );
}

/** Stuck work (issue #1010): only when some is stuck. */
export function Stuck({ stuck }: { stuck: StuckCause[] | undefined }) {
  if (!stuck?.length) return null;
  const total = stuck.reduce((n, c) => n + c.ids.length, 0);
  return (
    <div data-section="stuck">
      <Panel title="Stuck" icon={CircleAlert} count={total} bodyClassName="p-0" className="border-warn/40">
        <ul className="divide-y">{stuck.map((c) => <StuckRow key={c.cause} c={c} />)}</ul>
      </Panel>
    </div>
  );
}
