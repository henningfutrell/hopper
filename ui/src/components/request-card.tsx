// A request card (issue #652): an open labelled issue assigned to the user that is not of a trusted origin — a stranger
// wrote it, or an app, a bot or a login that is no trusted actor labelled or assigned it, or a job filed it. It shows the
// title and the body as read, who wrote, labelled and assigned it, and why it is a request; Approve takes that text, and
// the job runs it. When the issue changed since a person approved it, the change shows line by line. Approve waits at once
// and sends once while the daemon approves and syncs; a refusal shows on the card, which stays (issue #811). Decline
// (issue #1035) makes no job. It first opens a confirm step (issue #1710) that says what each choice does on GitHub — close
// the issue as not planned, or leave it open without the hopper label; each posts a short comment —, with the admin's
// default chosen; the card then says what was done. The issue comes back only when a person labels it again.
// A reopened card (issue #1126): the issue was reopened after its job was done; it links the item's earlier jobs and its
// pull request, and Approve runs the item again. A decision shows only while the source's list agrees with it (issue #1178):
// when the source asks again, the card offers Approve and Decline again; approved, it says it waits for the source's job.
import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IntakeRequest } from '../../../src/domain/intake-origin.ts';
import { Button } from '@/components/ui/button';
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block';
import { DECLINE_CHOICES, DECLINE_EFFECT, DECLINE_LABEL, DECLINED_DONE } from '@/model/intake';
import type { DeclineChoice } from '@/model/wire';
import { approveRequest, declineRequest, loadDeclineDefaults, useApprovals, useDeclineDefaults, waitsForDaemon } from '@/store/intake';
import { BodyDiff } from './text-change';

const ROLE: Record<IntakeRequest['actors'][number]['role'], string> = { author: 'written by', labelled: 'labelled by', assigned: 'assigned by', edited: 'edited by', nominated: 'nominated by' };

/** Decline's confirm step (issue #1710): each choice with what it does on GitHub, the default chosen first. */
function DeclineConfirm({ itemKey, first, busy, onDecline, onCancel }: { itemKey: string; first: DeclineChoice; busy: boolean; onDecline: (c: DeclineChoice) => void; onCancel: () => void }) {
  const [choice, setChoice] = useState<DeclineChoice>(first);
  return (
    <fieldset data-slot="decline-confirm" className="w-full space-y-2 rounded-md border p-2">
      <legend className="px-1 font-medium">Decline: what happens to the issue on GitHub?</legend>
      {DECLINE_CHOICES.map((c) => (
        <label key={c} className="flex items-start gap-2" data-decline-choice={c}>
          <input type="radio" name={`decline-${itemKey}`} value={c} checked={choice === c} disabled={busy} onChange={() => setChoice(c)} className="mt-1" />
          <span><span className="font-medium">{DECLINE_LABEL[c]}</span> <span className="text-muted-foreground" data-decline-effect={c}>{DECLINE_EFFECT[c]}</span></span>
        </label>
      ))}
      <p className="text-muted-foreground">To queue it again later, add the hopper label again on GitHub.</p>
      <div className="flex gap-2">
        <Button size="xs" variant="outline" data-slot="decline-confirm-button" disabled={busy} aria-busy={busy} onClick={() => onDecline(choice)}>
          {busy ? <><Loader2 className="animate-spin motion-reduce:animate-none" />Declining</> : <><X />Decline: {DECLINE_LABEL[choice].toLowerCase()}</>}
        </Button>
        <Button size="xs" variant="ghost" data-slot="decline-cancel" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </fieldset>
  );
}

export function RequestCard({ request, source, itemKey, canOperate }: { request: IntakeRequest; source: string; itemKey: string; canOperate: boolean }) {
  const approval = useApprovals((s) => s[itemKey]);
  const pending = approval?.state === 'pending';
  const waits = waitsForDaemon(approval);
  const [confirming, setConfirming] = useState(false);
  const first = useDeclineDefaults((d) => (request.reopened ? d.reopened : d.request));
  useEffect(loadDeclineDefaults, []);
  return (
    <div data-slot="request-card" data-request={itemKey} className="mt-1 w-full space-y-2 rounded-md border border-warn/40 bg-warn/5 p-3">
      <ul className="space-y-0.5" data-slot="request-why">
        {request.why.map((w) => <li key={w}>{w}</li>)}
      </ul>
      {request.reopened && (
        <div className="flex flex-wrap gap-x-3 text-muted-foreground" data-slot="request-history">
          <span>Before:</span>
          {request.reopened.jobs.map((j) => (
            <a key={j.id} href={`#job/${j.id}`} className="font-mono underline" data-job={j.id}>{j.id.slice(0, 8)} ({j.status})</a>
          ))}
          {request.reopened.pullRequest && <a href={request.reopened.pullRequest} target="_blank" rel="noreferrer" className="underline" data-slot="request-pull-request">its pull request</a>}
        </div>
      )}
      {request.actors.length > 0 && <div className="flex flex-wrap gap-x-3 text-muted-foreground" data-slot="request-actors">
        {request.actors.map((a) => (
          <span key={a.role} className={a.trusted ? 'text-ok' : 'text-warn'}>{ROLE[a.role]} {a.login ?? 'nobody known'}{a.app ? ` (${a.app})` : ''}</span>
        ))}
      </div>}
      {request.approved && request.approved.title !== request.title && (
        <div data-slot="request-title-change">Title was <span className="line-through">{request.approved.title}</span></div>
      )}
      <div className="font-medium" data-slot="request-title">{request.title}</div>
      {request.approved
        ? <BodyDiff from={request.approved.body} to={request.body} />
        : <div data-slot="request-body"><CodeBlock size="sm"><CodeBlockContent wrap aria-label="The request's text" className="max-h-64">{request.body}</CodeBlockContent></CodeBlock></div>}
      {approval?.state === 'refused' && <div data-slot="request-error" role="alert" className="text-bad">Not done: {approval.error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        {approval?.state === 'approved' && <span data-slot="request-approved" className="text-ok">Approved: no job yet. The source makes one at its sync</span>}
        {approval?.state === 'declined' && <span data-slot="request-declined" className="text-muted-foreground">{DECLINED_DONE[approval.choice ?? first]}</span>}
        {(confirming || approval?.state === 'declining') && approval?.state !== 'declined' && approval?.state !== 'approved' && canOperate && (
          <DeclineConfirm itemKey={itemKey} first={first} busy={approval?.state === 'declining'}
            onDecline={(c) => void declineRequest(source, itemKey, request.hash, c)} onCancel={() => setConfirming(false)} />
        )}
        {approval?.state !== 'approved' && approval?.state !== 'declined' && approval?.state !== 'declining' && !confirming && canOperate && (
          <>
            <Button size="xs" data-slot="request-approve" disabled={waits} aria-busy={pending}
              title="Approves this title and body: the source then syncs and makes a job, and the job runs this text. A later edit shows the card again."
              onClick={() => void approveRequest(source, itemKey, request.hash)}>
              {pending
                ? <><Loader2 className="animate-spin motion-reduce:animate-none" />Approving</>
                : <><Check />{request.approved ? 'Approve the new text' : 'Approve'}</>}
            </Button>
            <Button size="xs" variant="outline" data-slot="request-decline" disabled={waits} onClick={() => setConfirming(true)}>
              <X />Decline…
            </Button>
          </>
        )}
        <span className="text-muted-foreground">Read it first: an approved request runs as you wrote it.</span>
      </div>
    </div>
  );
}
