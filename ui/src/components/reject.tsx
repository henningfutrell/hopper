// Reject a waiting job (issues #159, #387): it ends rejected, is kept, and never runs. The user may say
// why; the reason stays on the job and in its timeline and is never written to the issue. A GitHub issue is
// not taken again until it is assigned to the user again, or run again.
import { X } from 'lucide-react';
import { useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { goalOf } from '@/model/job';
import type { Job } from '@/model/wire';
import { act } from '@/store';

/** The request body: the reason trimmed, none when empty. */
export const rejectBody = (reason: string): { reason?: string } => (reason.trim() ? { reason: reason.trim() } : {});

export function RejectButton({ job }: { job: Job }) {
  const [reason, setReason] = useState('');
  const fromIssue = job.source?.repo !== undefined;
  return (
    <AlertDialog onOpenChange={(open) => { if (!open) setReason(''); }}>
      <AlertDialogTrigger asChild>
        <Button size="xs" variant="outline" aria-label={`Reject ${goalOf(job)}`} title="Reject: the job is kept, never run"><X />Reject</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reject this job?</AlertDialogTitle>
          <AlertDialogDescription>
            “{goalOf(job)}” is kept and never runs.{fromIssue && ' Its issue is left as it is, and is not taken again until it is assigned to you again, or you run it again.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="space-y-1 text-sm">
          <span>Reason <span className="text-muted-foreground">(optional, shown in the job's timeline only)</span></span>
          <Input data-reject-reason value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="why not" />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => act(`/ui/api/jobs/${job.id}/reject`, rejectBody(reason), 'Job rejected')}>Reject job</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
