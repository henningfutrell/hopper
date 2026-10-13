// Notes to a job on its job view (issue #997): each note with who sent it, how, and where it is — queued, delivered,
// carried —, and Add note for an operator while the job may still run. The note goes into the job's session at the next
// turn boundary, or when it goes on (POST /ui/api/jobs/:id/notes).
import { MessageSquarePlus, StickyNote } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/markdown';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { noteFrom, noteStateText, takesNotes } from '@/model/notes';
import type { Job } from '@/model/wire';
import { act } from '@/store';
import { useCanOperate } from '@/store/selectors';

const MAX_NOTE_CHARS = 4000;

const TONE = { queued: 'text-warn', delivered: 'text-ok', carried: 'text-muted-foreground' } as const;

export function JobNotes({ job }: { job: Job }) {
  const operate = useCanOperate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const notes = job.notes ?? [];
  const form = operate && takesNotes(job);
  if (!form && notes.length === 0) return null;
  const send = async () => {
    setBusy(true);
    if (await act(`/ui/api/jobs/${encodeURIComponent(job.id)}/notes`, { text: text.trim() }, 'Note sent')) setText('');
    setBusy(false);
  };
  return (
    <Panel title="Notes" icon={StickyNote} count={notes.length} bodyClassName="space-y-2">
      <div data-slot="job-notes" className="space-y-2">
        {notes.map((n) => (
          <div key={n.id} data-slot="job-note" data-state={n.state} className="space-y-0.5 border-l-2 pl-2 text-xs">
            <div className="flex flex-wrap gap-x-2 text-muted-foreground">
              <span>{noteFrom(n)}</span><span>{n.at}</span><span className={TONE[n.state]}>{noteStateText(n)}</span>
            </div>
            <Markdown text={n.text} />
          </div>
        ))}
        {form && (
          <div className="space-y-1.5">
            <Textarea value={text} maxLength={MAX_NOTE_CHARS} placeholder="A note for the job: it goes into its session at the next turn boundary, or when it goes on."
              onChange={(e) => setText(e.target.value)} />
            <Button size="sm" variant="outline" disabled={busy || text.trim() === ''} onClick={() => void send()}><MessageSquarePlus />Add note</Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
