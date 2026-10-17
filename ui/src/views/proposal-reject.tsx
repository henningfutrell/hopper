// Reject a whole proposal (issue #1659): the button is always enabled, on a proposal with paths or with none, in review
// or sent back. Its dialog asks for an optional note; a refusal shows the server's error in the dialog, which stays open.
// The same dialog rejects several selected proposals at once (`POST /ui/api/proposals/reject`): each has its own result,
// and a toast names the ones refused with their errors.
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { actFor } from '@/store';
import { refreshReviews } from '@/store/reviews';

interface BulkResult { id: string; ok: boolean; error?: string }

/** Why a bulk reject is not done, or undefined: every proposal was rejected. */
const refusedOf = (answer: unknown): string | undefined => {
  const results = (answer as { results?: BulkResult[] } | undefined)?.results ?? [];
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return undefined;
  return `${results.length - failed.length} of ${results.length} rejected. ${failed.map((r) => `${r.id}: ${r.error ?? 'refused'}`).join('; ')}`;
};

/** Reject the proposals `ids` names: one, from its card, or several selected. */
export function RejectProposals({ ids, label = 'Reject', onDone }: { ids: readonly string[]; label?: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Set at once, before the re-render that disables the button: a second click in between sends nothing.
  const inFlight = useRef(false);
  const one = ids.length === 1;
  const reject = async () => {
    if (inFlight.current || ids.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const text = notes.trim();
    const body = text ? { notes: text } : {};
    const r = one
      ? await actFor(`/ui/api/proposals/${encodeURIComponent(ids[0]!)}/reject`, body, 'Proposal rejected')
      : await actFor('/ui/api/proposals/reject', { ids, ...body }, `${ids.length} proposals rejected`, refusedOf);
    inFlight.current = false;
    setBusy(false);
    refreshReviews('proposal').catch(() => {});
    // One refused stays open with the error; several end with the toast that names each one refused.
    if (!r.ok && one) return void setError(r.error);
    setOpen(false);
    setNotes('');
    onDone?.();
  };
  const change = (next: boolean) => { setOpen(next); if (!next) setError(undefined); };
  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogTrigger asChild>
        <Button data-decision="reject" variant="ghost" disabled={busy || ids.length === 0}><X />{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent data-slot="reject-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{one ? 'Reject this proposal?' : `Reject ${ids.length} proposals?`}</AlertDialogTitle>
          <AlertDialogDescription>{one ? 'Its job ends' : 'Their jobs end'}, with the decision and your note recorded. Reviews in progress stop.</AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea data-slot="reject-note" rows={3} value={notes} disabled={busy} placeholder="Why it is rejected (optional)" onChange={(e) => setNotes(e.target.value)} />
        {error && <div data-slot="reject-error" role="alert" className="text-sm break-words text-destructive">{error}</div>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <Button data-slot="reject-confirm" variant="destructive" disabled={busy} onClick={() => void reject()}>{one ? 'Reject' : `Reject ${ids.length}`}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
