// The job's terminal on its job view (issue #1128): an operator opens a running job's herdr pane, sees its screen read
// again every 1.5 s, and types into it — text, or a key — through the hopper (POST /ui/api/jobs/:id/terminal/*), from
// anywhere the UI reaches. Access decides each use; the daemon audits the session and never keeps the text.
import { SendHorizontal, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post } from '@/lib/api';
import { holdsPane, TERMINAL_KEY_BUTTONS, TERMINAL_POLL_MS } from '@/model/terminal';
import type { Job } from '@/model/wire';
import { useCanOperate } from '@/store/selectors';

const MAX_TEXT = 4000;

interface Screen { screen: string; at: string }

export function JobTerminal({ job }: { job: Job }) {
  const operate = useCanOperate();
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<Screen | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLPreElement>(null);
  const base = `/ui/api/jobs/${encodeURIComponent(job.id)}/terminal`;
  const live = holdsPane(job);

  useEffect(() => {
    if (!open || !live) return;
    let stop = false;
    const read = async () => {
      try {
        const s = await post<Screen>(`${base}/screen`, {});
        if (!stop) { setScreen(s); setError(undefined); }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void read();
    const timer = setInterval(() => void read(), TERMINAL_POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [open, live, base]);
  useEffect(() => { bottom.current?.scrollTo?.({ top: bottom.current.scrollHeight }); }, [screen?.screen]);

  if (!operate || !live) return null;
  const send = async (input: { text: string } | { keys: string[] }) => {
    setBusy(true);
    try {
      await post(`${base}/input`, input);
      setError(undefined);
      if ('text' in input) setText('');
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Terminal" icon={SquareTerminal} bodyClassName="space-y-2">
      <div data-slot="job-terminal" className="space-y-2">
        {!open && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}><SquareTerminal />Open terminal</Button>
            <span>View the job&apos;s pane and type into it. What you type goes to the job&apos;s machine as you type it.</span>
          </div>
        )}
        {open && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span data-slot="job-terminal-at">{screen ? `read ${screen.at}` : 'reading the pane…'}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setOpen(false); setScreen(undefined); }}><X />Close</Button>
            </div>
            {error && <div data-slot="job-terminal-error" className="text-xs text-bad">{error}</div>}
            <pre ref={bottom} data-slot="job-terminal-screen" className="max-h-96 overflow-auto rounded border bg-muted p-2 font-mono text-xs leading-tight whitespace-pre">{screen?.screen ?? ''}</pre>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text !== '') void send({ text }); }}>
              <Input value={text} maxLength={MAX_TEXT} placeholder="Text for the pane, as you would type it" aria-label="Text for the pane"
                onChange={(e) => setText(e.target.value)} />
              <Button size="sm" type="submit" variant="outline" disabled={busy || text === ''}><SendHorizontal />Type</Button>
            </form>
            <div className="flex flex-wrap gap-1">
              {TERMINAL_KEY_BUTTONS.map((k) => (
                <Button key={k.key} size="sm" variant="outline" data-key={k.key} disabled={busy} onClick={() => void send({ keys: [k.key] })}>{k.label}</Button>
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
