// A request card (issue #652): an open labelled issue assigned to the user that is not of a trusted origin — a stranger
// wrote it, or an app, a bot or a login that is no trusted actor labelled or assigned it, or a job filed it. It shows the
// title and the body as read, who wrote, labelled and assigned it, and why it is a request; Approve takes that text, and
// the job runs it. When the issue changed since a person approved it, the change shows line by line.
import { Check } from 'lucide-react';
import type { IntakeRequest } from '../../../src/domain/intake-origin.ts';
import { Button } from '@/components/ui/button';
import { act } from '@/store';
import { BodyDiff } from './text-change';

const ROLE: Record<IntakeRequest['actors'][number]['role'], string> = { author: 'written by', labelled: 'labelled by', assigned: 'assigned by' };

export function RequestCard({ request, source, itemKey, canOperate }: { request: IntakeRequest; source: string; itemKey: string; canOperate: boolean }) {
  const approve = () => act(`/ui/api/sources/${encodeURIComponent(source)}/intake`, { kind: 'approve', keys: [itemKey], hash: request.hash }, 'Approved: the next sync takes it');
  return (
    <div data-slot="request-card" data-request={itemKey} className="mt-1 w-full space-y-2 rounded-md border border-warn/40 bg-warn/5 p-3">
      <ul className="space-y-0.5" data-slot="request-why">
        {request.why.map((w) => <li key={w}>{w}</li>)}
      </ul>
      <div className="flex flex-wrap gap-x-3 text-muted-foreground" data-slot="request-actors">
        {request.actors.map((a) => (
          <span key={a.role} className={a.trusted ? 'text-ok' : 'text-warn'}>{ROLE[a.role]} {a.login ?? 'nobody known'}{a.app ? ` (${a.app})` : ''}</span>
        ))}
      </div>
      {request.approved && request.approved.title !== request.title && (
        <div data-slot="request-title-change">Title was <span className="line-through">{request.approved.title}</span></div>
      )}
      <div className="font-medium" data-slot="request-title">{request.title}</div>
      {request.approved
        ? <BodyDiff from={request.approved.body} to={request.body} />
        : <pre data-slot="request-body" className="max-h-64 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">{request.body}</pre>}
      <div className="flex flex-wrap items-center gap-2">
        {canOperate && (
          <Button size="xs" title="Approves this title and body: the next sync makes a job, and the job runs this text. A later edit shows the card again."
            onClick={() => void approve()}><Check />{request.approved ? 'Approve the new text' : 'Approve'}</Button>
        )}
        <span className="text-muted-foreground">Read it first: an approved request runs as you wrote it.</span>
      </div>
    </div>
  );
}
